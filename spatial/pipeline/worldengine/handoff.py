"""handoff — deliver the assembled world to the database, in sections.

The pipeline's last act is not writing a file. It is handing the world over to
the system of record, which is the database: an operator has to be able to
rename a room, move a misplaced object, fix a dimension and approve a
redaction, and those writes have to land in rows that row-level security
protects and a portfolio query can read. The document the pipeline assembles is
the shape every other package compiles against, and it is uploaded as
``build/world.raw.json`` so a build can be diffed against what the database
ended up holding — but nothing reads it as the world.

This module turns a validated document into the sequence of requests that
``wv-jobs ingest-world`` accepts, and it exists as its own module for two
reasons. It is the piece most likely to need changing when the schema grows,
and it is the piece whose correctness is easiest to check without a database:
every function here is a pure transformation of one dict into another.

Three properties it has to hold.

**It must fit.** The edge function refuses a body over 256 KB. A two-bed flat's
document is about 100 KB and a five-bed house with a full semantic pass is
several times that, so the document is never sent whole. Sections are chunked
by row count *and* by serialised size, because a single wall can carry a
400-vertex outline and fifty nav nodes together do not.

**It must be re-sendable.** A preempted pod's job is reclaimed and re-run, and
the re-run sends everything again. Nothing here carries a nonce, a timestamp or
an attempt number; every row is identified by the pipeline's own stable ids, so
the second pass lands on the first pass's rows.

**It must not carry ids the database cannot resolve.** Rooms and entities are
referenced by their ``stableKey`` and not by ``rm_000``, because the row's
primary key is derived from the stable key — that is what makes a rescan land
on the room it supersedes rather than creating a second one. Everything else is
referenced by the pipeline's local id, which is already stable.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Iterable, Iterator, Mapping, Sequence

from .logging_setup import get_logger, log

LOG = get_logger("worldengine.handoff")

# The edge function's body cap. Mirrored, not discovered: exceeding it is a 400
# with no useful diagnosis, half way through a 35-minute job.
MAX_BODY_BYTES = 256 * 1024

# What a request actually aims for. The gap is the envelope: the action name,
# the job and worker ids, the policy block, and JSON's own overhead.
REQUEST_BUDGET_BYTES = 150 * 1024

# Row caps per request. These mirror MAX_ROWS in
# supabase/functions/_wv_shared/worldIngest.ts and must not drift: a cap that
# is larger here is a 400 the worker could have avoided.
MAX_ROWS: dict[str, int] = {
    "floors": 64,
    "rooms": 200,
    "surfaces": 300,
    "openings": 400,
    "cameras": 500,
    "entities": 400,
    "nav-nodes": 1000,
    "nav-edges": 1000,
    "regions": 500,
    "relationships": 1000,
    "assets": 256,
}

# The object the pipeline's own assembled document is uploaded under, and the
# chunk key its row carries. Named so nobody mistakes it for the world: it is
# an input to a diff, not a thing to read. Must match RAW_DOCUMENT_OBJECT_NAME
# and RAW_DOCUMENT_CHUNK_KEY in _wv_shared/worldDocument.ts.
RAW_DOCUMENT_OBJECT_NAME = "build/world.raw.json"
RAW_DOCUMENT_CHUNK_KEY = "world-raw"


class HandoffError(RuntimeError):
    """The document cannot be delivered as it stands. Never worked around."""


def _size(payload: Any) -> int:
    return len(json.dumps(payload, separators=(",", ":"), default=str).encode())


def _chunks(rows: Sequence[Mapping[str, Any]], section: str) -> Iterator[list[dict[str, Any]]]:
    """Split a section into requests that fit, by count and by bytes.

    A single row that cannot fit on its own is a hard failure rather than a
    request that will be refused: a 200 KB surface polygon is a bug in the mesh
    stage, and discovering it as an HTTP 400 twenty-five minutes into a job
    wastes the whole run.
    """
    cap = MAX_ROWS.get(section, 100)
    batch: list[dict[str, Any]] = []
    size = 0
    for row in rows:
        n = _size(row)
        if n > REQUEST_BUDGET_BYTES:
            raise HandoffError(
                f"a single {section} row serialises to {n} bytes, which cannot fit "
                f"in a {REQUEST_BUDGET_BYTES}-byte request; the row is too big to "
                "store, not merely too big to send"
            )
        if batch and (len(batch) >= cap or size + n > REQUEST_BUDGET_BYTES):
            yield batch
            batch, size = [], 0
        batch.append(dict(row))
        size += n
    if batch:
        yield batch


# ---------------------------------------------------------------------------
# Reference translation
# ---------------------------------------------------------------------------

def _room_keys(document: Mapping[str, Any]) -> dict[str, str]:
    return {str(r["id"]): str(r["stableKey"]) for r in document.get("rooms", [])}


def _entity_keys(document: Mapping[str, Any]) -> dict[str, str]:
    return {str(e["id"]): str(e["stableKey"]) for e in document.get("entities", [])}


def _floor_levels(document: Mapping[str, Any]) -> dict[str, int]:
    return {str(f["id"]): int(f["level"]) for f in document.get("floors", [])}


def _quantity_value(q: Any) -> float | None:
    return None if not isinstance(q, Mapping) else q.get("value")


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------

def sections(document: Mapping[str, Any],
             assets: Sequence[Mapping[str, Any]] = ()) -> Iterator[dict[str, Any]]:
    """Every request body the hand-off sends, in dependency order.

    The order satisfies every foreign key in the schema in a single pass:
    floors before rooms, rooms before anything that names one, cameras before
    the entities that cite them, nav nodes before nav edges. The edge function
    checks rather than trusts — a section that arrives early is refused with the
    name of the one it needs — but a worker following this order never sees
    that refusal.

    `assets` are the packaged files as `upload_assets` returned them, carrying
    the world-relative object name the edge function will prefix.
    """
    rooms = _room_keys(document)
    entities = _entity_keys(document)
    floors = _floor_levels(document)
    nav = document.get("nav") or {}

    def node_key(node_type: str, node_id: Any) -> Any:
        """The key the database resolves a scene-graph endpoint by."""
        nid = str(node_id)
        if node_type == "room":
            return rooms.get(nid)
        if node_type == "entity":
            return entities.get(nid)
        if node_type == "floor":
            level = floors.get(nid)
            return None if level is None else str(level)
        return nid

    yield {
        "section": "header",
        "scale": document["scale"],
        "propertyId": document["propertyId"],
        "version": document["version"],
    }

    yield from _section("floors", [
        {"level": f["level"], "name": f.get("name"), "elevation": f["elevation"],
         "grounding": f["grounding"]}
        for f in document.get("floors", [])
    ])

    # The measurement policy rides with every rooms request rather than being
    # stored once: it is denormalised onto each room row, and a chunk that
    # arrived without it could not write one.
    for body in _section("rooms", [
        {"stableKey": r["stableKey"], "kind": r["kind"], "name": r.get("name"),
         "polygon": r["polygon"], "floorZ": r["floorZ"], "ceilingZ": r["ceilingZ"],
         "area": {"value": r["area"]["value"], "standard": r["area"]["standard"],
                  "tolerance": r["area"]["tolerance"]},
         "floorLevel": floors.get(str(r.get("floorId"))),
         "grounding": r["grounding"]}
        for r in document.get("rooms", [])
    ]):
        body["policy"] = document["measurementPolicy"]
        yield body

    yield from _section("surfaces", [
        {"id": s["id"], "kind": s["kind"], "plane": s["plane"], "polygon": s["polygon"],
         "areaM2": _quantity_value(s.get("area")),
         "isReflective": s["isReflective"], "isGlazed": s["isGlazed"],
         "roomKey": rooms.get(str(s.get("roomId"))), "grounding": s["grounding"]}
        for s in document.get("surfaces", [])
    ])

    yield from _section("openings", [
        {"id": o["id"], "kind": o["kind"], "centre": o["centre"], "normal": o.get("normal"),
         "surfaceKey": o.get("surfaceId"),
         "roomAKey": rooms.get(str(o.get("roomA"))),
         "roomBKey": rooms.get(str(o.get("roomB"))),
         "widthM": _quantity_value(o.get("width")),
         "heightM": _quantity_value(o.get("height")),
         "sillM": _quantity_value(o.get("sill")),
         "grounding": o["grounding"]}
        for o in document.get("openings", [])
    ])

    yield from _section("cameras", [
        {"id": c["id"], "frameIndex": c.get("frameIndex"), "tMs": c.get("tMs"),
         "position": c["position"], "orientation": c["orientation"],
         "intrinsics": c["intrinsics"], "poseConfidence": c.get("poseConfidence"),
         "sharpness": c.get("sharpness"), "roomKey": rooms.get(str(c.get("roomId")))}
        for c in document.get("cameras", [])
    ])

    yield from _section("entities", [
        {"stableKey": e["stableKey"], "label": e["label"], "category": e["category"],
         "roomKey": rooms.get(str(e.get("roomId"))), "centroid": e["centroid"],
         "aabb": e["aabb"], "obb": e.get("obb"), "observedIn": e.get("observedIn", []),
         "attributes": e.get("attributes"), "grounding": e["grounding"]}
        for e in document.get("entities", [])
    ])

    yield from _section("nav-nodes", [
        {"id": n["id"], "roomKey": rooms.get(str(n.get("roomId"))),
         "position": n["position"], "clearance": n["clearance"],
         "isEntrance": n["isEntrance"], "isViewpoint": n["isViewpoint"]}
        for n in nav.get("nodes", [])
    ])

    yield from _section("nav-edges", [
        {"a": e["a"], "b": e["b"], "cost": e["cost"], "widthM": e.get("width"),
         "kind": e["kind"], "openingKey": e.get("openingId")}
        for e in nav.get("edges", [])
    ])

    yield from _section("regions", [
        {"id": r["id"], "provenance": r["provenance"], "volume": r["volume"],
         "roomKey": rooms.get(str(r.get("roomId"))), "reason": r.get("reason"),
         "confidence": r.get("confidence")}
        for r in document.get("regions", [])
    ])

    relationships: list[dict[str, Any]] = []
    for r in document.get("relationships", []):
        subject = node_key(r["subjectType"], r["subjectId"])
        target = node_key(r["objectType"], r["objectId"])
        if subject is None or target is None:
            # document.py drops relationships whose endpoints did not survive
            # assembly, so reaching here means the document and this module
            # disagree about what an endpoint is. Fail rather than quietly
            # shipping a world with a thinner scene graph than was built.
            raise HandoffError(
                f"relationship {r['subjectType']}:{r['subjectId']} "
                f"{r['predicate']} {r['objectType']}:{r['objectId']} names an "
                "endpoint that is not in the document"
            )
        relationships.append({
            "subjectType": r["subjectType"], "subjectKey": subject,
            "predicate": r["predicate"],
            "objectType": r["objectType"], "objectKey": target,
            "value": r.get("value"), "grounding": r["grounding"],
        })
    yield from _section("relationships", relationships)

    yield from _section("assets", [
        {"name": a["name"], "role": a["role"], "format": a["format"],
         "bytes": a.get("bytes"), "checksum": a.get("checksum"), "lod": a.get("lod"),
         "chunkKey": a.get("chunkKey"), "splatCount": a.get("splatCount"),
         "meta": a.get("meta") or {}}
        for a in assets
    ])

    yield {"section": "quality", "quality": document["quality"]}
    yield {"section": "commit"}


def _section(name: str, rows: Sequence[Mapping[str, Any]]) -> Iterator[dict[str, Any]]:
    """One request per chunk, each labelled with its place in the section.

    A section with no rows still sends one empty request. That is deliberate:
    the log line it produces is how an operator tells "this world has no
    openings" from "the openings never got sent".
    """
    batches = list(_chunks(rows, name)) or [[]]
    for i, batch in enumerate(batches):
        yield {"section": name, "rows": batch,
               "chunkIndex": i, "chunkCount": len(batches)}


# ---------------------------------------------------------------------------
# Delivery
# ---------------------------------------------------------------------------

def deliver(client: Any, job_id: str, document: Mapping[str, Any],
            assets: Sequence[Mapping[str, Any]] = ()) -> dict[str, Any]:
    """Send every section, then commit. Returns the commit's result.

    The commit is where the database proves it holds the world that was built:
    it renders the rows back into a document and compares them against
    ``build/world.raw.json``. A material difference — a missing room, a dropped
    surface, a measurement that did not survive — refuses the commit, and this
    raises. It does not publish a world that is not the world that was
    reconstructed.
    """
    written: dict[str, int] = {}
    for body in sections(document, assets):
        name = str(body["section"])
        if name == "commit":
            out = client.ingest(job_id, body)
            log(LOG, logging.INFO, "handoff.committed",
                verdict=out.get("verdict"), sections=written)
            return out
        out = client.ingest(job_id, body)
        written[name] = written.get(name, 0) + int(out.get("written", 0))
    raise HandoffError("the section stream ended without a commit")


def summarise(document: Mapping[str, Any]) -> dict[str, int]:
    """Row counts per section, for the log line that precedes a hand-off."""
    nav = document.get("nav") or {}
    return {
        "floors": len(document.get("floors", [])),
        "rooms": len(document.get("rooms", [])),
        "surfaces": len(document.get("surfaces", [])),
        "openings": len(document.get("openings", [])),
        "cameras": len(document.get("cameras", [])),
        "entities": len(document.get("entities", [])),
        "navNodes": len(nav.get("nodes", [])),
        "navEdges": len(nav.get("edges", [])),
        "regions": len(document.get("regions", [])),
        "relationships": len(document.get("relationships", [])),
    }


def request_sizes(document: Mapping[str, Any],
                  assets: Sequence[Mapping[str, Any]] = ()) -> list[tuple[str, int]]:
    """(section, serialised bytes) for every request the hand-off would send.

    Used by the tests to assert the cap is respected for a property far larger
    than the reference flat, which is the case the chunking exists for.
    """
    return [(str(b["section"]), _size(b)) for b in sections(document, assets)]


def iter_sections(document: Mapping[str, Any],
                  assets: Sequence[Mapping[str, Any]] = ()) -> Iterable[dict[str, Any]]:
    return sections(document, assets)
