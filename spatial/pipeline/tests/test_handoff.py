"""The hand-off: turning an assembled world into rows the database can hold.

These tests are about the three properties the hand-off has to have, and each
one corresponds to a way this has gone wrong in systems like it: it has to fit
inside the request cap for a house rather than a flat, it has to survive being
sent twice, and it must not carry an identifier the database cannot resolve.
"""
from __future__ import annotations

import json

import pytest

from worldengine import handoff as H
from worldengine.document import build_and_validate
from tests.fixtures import artefacts

WORLD_ID = "55555555-5555-4555-8555-555555555555"
PROPERTY_ID = "33333333-3333-4333-8333-333333333333"


def document(**over):
    return build_and_validate(
        world_id=WORLD_ID, property_id=PROPERTY_ID, version=1,
        label="Flat 2, Alpha Court", artefacts=artefacts(**over),
        asset_urls={"/tmp/world.spz": f"asset://{WORLD_ID}/{WORLD_ID}/ab/a.spz",
                    "/tmp/chunks/_shell.spz": f"asset://{WORLD_ID}/{WORLD_ID}/bc/b.spz",
                    "/tmp/proxy.ply": f"asset://{WORLD_ID}/{WORLD_ID}/cd/c.ply"})


ASSETS = [
    {"name": "ab/a.spz", "role": "splat", "format": "spz", "bytes": 24_000_000,
     "checksum": "a" * 64, "lod": None, "chunkKey": None, "splatCount": 800_000},
    {"name": "build/world.raw.json", "role": "export_bundle", "format": "json",
     "bytes": 90_000, "checksum": "z" * 64, "chunkKey": H.RAW_DOCUMENT_CHUNK_KEY},
]


# ---------------------------------------------------------------------------
# Order and shape
# ---------------------------------------------------------------------------

def test_sections_are_emitted_in_an_order_that_satisfies_every_foreign_key():
    names = [b["section"] for b in H.sections(document(), ASSETS)]
    assert names[0] == "header"
    assert names[-1] == "commit"
    for parent, child in [("floors", "rooms"), ("rooms", "surfaces"),
                          ("rooms", "entities"), ("surfaces", "openings"),
                          ("cameras", "entities"), ("nav-nodes", "nav-edges"),
                          ("rooms", "regions"), ("entities", "relationships")]:
        assert names.index(parent) < names.index(child), f"{parent} must precede {child}"


def test_every_section_the_edge_function_knows_about_is_sent():
    """A section the worker never sends is a table the world never gets, and
    nothing downstream would report it -- the world would simply be thinner."""
    names = {b["section"] for b in H.sections(document(), ASSETS)}
    assert names == {
        "header", "floors", "rooms", "surfaces", "openings", "cameras",
        "entities", "nav-nodes", "nav-edges", "regions", "relationships",
        "assets", "quality", "commit",
    }


def test_an_empty_section_still_sends_one_request():
    """"This world has no openings" and "the openings never got sent" must not
    look the same in the log."""
    doc = dict(document())
    doc["openings"] = []
    bodies = [b for b in H.sections(doc, ASSETS) if b["section"] == "openings"]
    assert len(bodies) == 1
    assert bodies[0]["rows"] == []


# ---------------------------------------------------------------------------
# References
# ---------------------------------------------------------------------------

def _section(doc, name, assets=ASSETS):
    return [b for b in H.sections(doc, assets) if b["section"] == name]


def test_rooms_and_entities_are_referenced_by_stable_key_not_by_local_id():
    """The row's primary key is derived from the stable key, which is what
    makes a rescan land on the room it supersedes instead of making a new one.
    A reference by `rm_000` would resolve to nothing."""
    doc = document()
    room_keys = {r["stableKey"] for r in doc["rooms"]}
    local_ids = {r["id"] for r in doc["rooms"]}

    surfaces = _section(doc, "surfaces")[0]["rows"]
    keys = {s["roomKey"] for s in surfaces if s["roomKey"]}
    assert keys and keys <= room_keys
    assert not (keys & local_ids)

    openings = _section(doc, "openings")[0]["rows"]
    assert {o["roomAKey"] for o in openings} <= room_keys
    assert {o["roomBKey"] for o in openings} <= room_keys

    rels = _section(doc, "relationships")[0]["rows"]
    by_type = {(r["subjectType"], r["subjectKey"]) for r in rels}
    for node_type, key in by_type:
        if node_type == "room":
            assert key in room_keys


def test_non_room_references_travel_as_the_pipelines_own_local_ids():
    doc = document()
    edges = _section(doc, "nav-edges")[0]["rows"]
    node_ids = {n["id"] for n in _section(doc, "nav-nodes")[0]["rows"]}
    assert edges
    for e in edges:
        assert e["a"] in node_ids and e["b"] in node_ids
    opening_ids = {o["id"] for o in _section(doc, "openings")[0]["rows"]}
    assert {e["openingKey"] for e in edges if e["openingKey"]} <= opening_ids


def test_a_rooms_floor_travels_as_its_level_because_that_is_the_unique_key():
    doc = document()
    rows = _section(doc, "rooms")[0]["rows"]
    levels = {f["level"] for f in _section(doc, "floors")[0]["rows"]}
    assert {r["floorLevel"] for r in rows} <= levels


def test_the_measurement_policy_rides_with_every_rooms_chunk():
    """It is denormalised onto each room row, so a chunk that arrived without
    it could not write one."""
    doc = document()
    for body in _section(doc, "rooms"):
        assert body["policy"]["areaStandard"] == doc["measurementPolicy"]["areaStandard"]
        assert body["policy"]["wallToleranceMm"] > 0


def test_a_relationship_naming_an_endpoint_that_is_not_in_the_document_is_refused():
    """document.py drops these during assembly. If one reaches here the two
    modules disagree about what an endpoint is, and shipping a world with a
    quietly thinner scene graph is the wrong way to find that out."""
    doc = dict(document())
    doc["relationships"] = list(doc["relationships"]) + [{
        "subjectType": "room", "subjectId": "rm_999", "predicate": "adjacent_to",
        "objectType": "room", "objectId": "rm_000",
        "grounding": {"provenance": "reconstructed", "confidence": 0.5},
    }]
    with pytest.raises(H.HandoffError, match="not in the document"):
        list(H.sections(doc, ASSETS))


# ---------------------------------------------------------------------------
# Fitting inside the request cap
# ---------------------------------------------------------------------------

def _big_document():
    """A document the size of a five-bed house with a heavy semantic pass.

    The reference flat is ~100 KB against a 256 KB cap, which is exactly the
    number that makes chunking look unnecessary. This is the case it exists
    for: five floors of rooms, four hundred posed frames, walls with real
    outlines, and a nav graph dense enough to path through a hallway.
    """
    doc = {k: v for k, v in document().items()}
    rooms = []
    for i in range(24):
        base = json.loads(json.dumps(doc["rooms"][0]))
        base["id"] = f"rm_{i:03d}"
        base["stableKey"] = f"r@{i}.0,{i}.5"
        base["polygon"] = [[float(i + x), float(y)] for x, y in
                           [(0, 0), (4, 0), (4, 3), (0, 3)]]
        rooms.append(base)
    doc["rooms"] = rooms

    surfaces = []
    for i in range(300):
        base = json.loads(json.dumps(doc["surfaces"][0]))
        base["id"] = f"srf_{i:03d}"
        base["roomId"] = rooms[i % len(rooms)]["id"]
        # A real wall outline after plane extraction, not a rectangle.
        base["polygon"] = [[float(j) * 0.01, float(j) * 0.02, float(j) * 0.03]
                           for j in range(120)]
        surfaces.append(base)
    doc["surfaces"] = surfaces

    cameras = []
    for i in range(400):
        base = json.loads(json.dumps(doc["cameras"][0]))
        base["id"] = f"f{i:07d}"
        cameras.append(base)
    doc["cameras"] = cameras

    nodes = []
    for i in range(1500):
        base = json.loads(json.dumps(doc["nav"]["nodes"][0]))
        base["id"] = f"nav_{i:05d}"
        base["roomId"] = rooms[i % len(rooms)]["id"]
        nodes.append(base)
    edges = [{"a": nodes[i]["id"], "b": nodes[i + 1]["id"], "cost": 1.0,
              "kind": "walk"} for i in range(len(nodes) - 1)]
    doc["nav"] = {"nodes": nodes, "edges": edges}

    entities = []
    for i in range(240):
        base = json.loads(json.dumps(doc["entities"][0]))
        base["id"] = f"ent_{i:04d}"
        base["stableKey"] = f"sofa@{i}.5,0.4,1.0"
        base["roomId"] = rooms[i % len(rooms)]["id"]
        base["observedIn"] = [c["id"] for c in cameras[:16]]
        entities.append(base)
    doc["entities"] = entities
    doc["relationships"] = [
        {"subjectType": "entity", "subjectId": e["id"], "predicate": "inside",
         "objectType": "room", "objectId": e["roomId"], "value": None,
         "grounding": {"provenance": "inferred", "confidence": 0.7}}
        for e in entities
    ]
    doc["openings"] = []
    doc["regions"] = []
    return doc


def test_a_five_bed_house_still_fits_inside_every_request():
    doc = _big_document()
    whole = len(json.dumps(doc).encode())
    assert whole > H.MAX_BODY_BYTES, (
        "this fixture is meant to be too big to send in one request; "
        f"it is only {whole} bytes")
    for section, size in H.request_sizes(doc, ASSETS):
        assert size <= H.MAX_BODY_BYTES, f"{section} request is {size} bytes"
        assert size <= H.REQUEST_BUDGET_BYTES + 4096, (
            f"{section} overshot the budget at {size} bytes")


def test_chunking_never_drops_or_duplicates_a_row():
    doc = _big_document()
    for name, key in [("surfaces", "id"), ("cameras", "id"),
                      ("nav-nodes", "id"), ("entities", "stableKey")]:
        sent = [r[key] for b in H.sections(doc, ASSETS)
                if b["section"] == name for r in b["rows"]]
        assert len(sent) == len(set(sent))
    surfaces = [r["id"] for b in H.sections(doc, ASSETS)
                if b["section"] == "surfaces" for r in b["rows"]]
    assert surfaces == [s["id"] for s in doc["surfaces"]]


def test_chunks_are_numbered_so_a_partial_section_is_visible():
    doc = _big_document()
    bodies = [b for b in H.sections(doc, ASSETS) if b["section"] == "surfaces"]
    assert len(bodies) > 1
    assert [b["chunkIndex"] for b in bodies] == list(range(len(bodies)))
    assert {b["chunkCount"] for b in bodies} == {len(bodies)}


def test_a_row_too_large_to_send_fails_loudly_rather_than_being_refused_later():
    """Discovering this as an HTTP 400 twenty-five minutes into a GPU job
    wastes the run; it is a bug in the stage that produced the row."""
    doc = dict(document())
    monster = json.loads(json.dumps(doc["surfaces"][0]))
    monster["polygon"] = [[float(i), 0.0, 0.0] for i in range(40_000)]
    doc["surfaces"] = [monster]
    with pytest.raises(H.HandoffError, match="too big to store"):
        list(H.sections(doc, ASSETS))


# ---------------------------------------------------------------------------
# Re-sending
# ---------------------------------------------------------------------------

def test_the_same_document_produces_byte_identical_requests_every_time():
    """A preempted pod re-sends everything. Nothing here may carry a nonce, a
    timestamp or an attempt number, or the second pass would write new rows
    beside the first pass's instead of over them."""
    doc = document()
    first = json.dumps(list(H.sections(doc, ASSETS)), sort_keys=True)
    second = json.dumps(list(H.sections(doc, ASSETS)), sort_keys=True)
    assert first == second


# ---------------------------------------------------------------------------
# deliver()
# ---------------------------------------------------------------------------

class Recorder:
    def __init__(self, refuse=False):
        self.bodies: list[dict] = []
        self.refuse = refuse

    def ingest(self, job_id, body):
        self.bodies.append(body)
        if body["section"] == "commit":
            if self.refuse:
                raise RuntimeError("refused")
            return {"ok": True, "verdict": "pass"}
        return {"ok": True, "written": len(body.get("rows") or [])}


def test_deliver_sends_every_section_then_commits():
    c = Recorder()
    out = H.deliver(c, "job", document(), ASSETS)
    assert out["verdict"] == "pass"
    assert c.bodies[-1]["section"] == "commit"
    assert c.bodies[0]["section"] == "header"


def test_summarise_counts_what_is_about_to_be_written():
    counts = H.summarise(document())
    assert counts["rooms"] == 2
    assert counts["cameras"] == 16
    assert counts["navNodes"] == 2 and counts["navEdges"] == 1
    assert counts["entities"] == 2


# ---------------------------------------------------------------------------
# The fixture both suites share
# ---------------------------------------------------------------------------

def test_the_shared_fixture_still_matches_what_the_pipeline_emits():
    """tests/data/handoff_fixture.json is the one world both test suites use.

    The TypeScript suite replays its `sections` through wv-jobs and compares
    the rendered document against its `document`. If the pipeline changes what
    it assembles or how it splits it, that comparison has to be against the NEW
    world, or the round trip is being proved against a world nobody builds any
    more. So the file is checked in and checked here.
    """
    import json as _json
    from tests.make_handoff_fixture import FIXTURE_PATH, build

    assert FIXTURE_PATH.is_file(), (
        f"{FIXTURE_PATH} is missing; run python3 -m tests.make_handoff_fixture")
    on_disk = _json.loads(FIXTURE_PATH.read_text())
    fresh = _json.loads(_json.dumps(build(), sort_keys=True))
    assert on_disk == fresh, (
        "the checked-in hand-off fixture no longer matches what the pipeline "
        "emits. Regenerate it with: python3 -m tests.make_handoff_fixture "
        "(from spatial/pipeline), and re-run the TypeScript suite -- the "
        "round-trip test there is what proves the new shape still survives "
        "the database.")
