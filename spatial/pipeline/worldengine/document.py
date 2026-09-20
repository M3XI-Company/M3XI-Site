"""document — assemble the WorldDocument and refuse to emit a malformed one.

This is the last thing that runs and the only thing allowed to produce the JSON
that the viewer, the agent and the export bundle all read. It gathers the stage
artefacts, converts each into the contract's shapes, and then runs the contract
validator. If validation fails the document is not written: an invalid world
document that reaches the viewer is a crash in someone's browser, and one that
reaches an export bundle is a permanence promise we did not keep.

Provenance is assembled here too, and this is where the rule about not
collapsing the four levels actually bites. A room polygon is `reconstructed`,
but the *area* computed from it is only as good as the metric scale, which is
`inferred` — so the area Quantity carries the weaker of the two, via
weakest_provenance. The same applies to every derived number in the document.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from .contract import (Aabb, Asset, Camera, ContractError, DEFAULT_MEASUREMENT_POLICY,
                       Entity, Floor, Grounding, Intrinsics, MeasurementPolicy,
                       NavEdge, NavNode, Obb, Opening, Plane, QualityCheck,
                       QualityReport, Quantity, Region, Relationship, Room,
                       ScaleBlock, Surface, WorldDocument, validate,
                       validate_or_raise, weakest_provenance)
from .geometry import ensure_ccw_from_above, polygon_area, quat_normalise
from .logging_setup import get_logger, log

LOG = get_logger("worldengine.document")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _grounding(provenance: str, confidence: float,
               sources: Sequence[str] = ()) -> Grounding:
    return Grounding(provenance=provenance,          # type: ignore[arg-type]
                     confidence=float(min(1.0, max(0.0, confidence))),
                     sources=tuple(sources))


def assemble(*, world_id: str, property_id: str, version: int, label: str,
             artefacts: Mapping[str, Any],
             asset_urls: Mapping[str, str] | None = None,
             policy: MeasurementPolicy = DEFAULT_MEASUREMENT_POLICY,
             slug: str | None = None) -> WorldDocument:
    """Build a WorldDocument from the stage artefacts.

    `artefacts` maps stage name to the runner's serialised Output. `asset_urls`
    maps a packaged asset's local path to the URL it was uploaded to; a local
    path with no URL is kept as a file:// reference so a locally assembled
    document still validates and still resolves on the machine that made it.
    """
    pose = artefacts.get("pose") or {}
    scale = artefacts.get("scale") or {}
    mesh = artefacts.get("mesh") or {}
    layout = artefacts.get("layout") or {}
    semantics = artefacts.get("semantics") or {}
    graph = artefacts.get("graph") or {}
    regions = artefacts.get("regions") or {}
    package = artefacts.get("package") or {}
    quality = artefacts.get("quality") or {}

    urls = dict(asset_urls or {})
    scale_conf = float(scale.get("confidence", 0.3))
    # Every dimension in this document is downstream of metric scale, which is
    # `inferred` by nature: no camera measured a metre, a model estimated one.
    scale_prov = str(scale.get("provenance", "inferred"))

    # -- floors ------------------------------------------------------------
    elevations = list(layout.get("floor_elevations") or mesh.get("floor_elevations") or [0.0])
    floors: list[Floor] = []
    for i, y in enumerate(sorted(elevations)):
        floors.append(Floor(id=f"flr_{i}", level=i, elevation=float(y),
                            name=("Ground floor" if i == 0 else f"Floor {i}"),
                            grounding=_grounding("reconstructed", 0.85)))
    floor_id_for = {i: f.id for i, f in enumerate(floors)}

    # -- rooms -------------------------------------------------------------
    room_labels: dict[str, list[str]] = dict(semantics.get("room_labels") or {})
    rooms: list[Room] = []
    for r in layout.get("rooms", []):
        ring = ensure_ccw_from_above(r["polygon"])
        area_m2 = polygon_area(ring)
        prov = str(r.get("provenance", "reconstructed"))
        conf = float(r.get("confidence", 0.5))
        # Area provenance is the weaker of the polygon's and the scale's: a
        # perfectly reconstructed polygon measured with an uncertain metre is
        # an uncertain area.
        area = Quantity(
            value=float(area_m2), unit="m2", standard=policy.area_standard,
            tolerance=float(policy.area_tolerance_pct), tolerance_unit="pct",
            grounding=_grounding(weakest_provenance(prov, scale_prov),
                                 min(conf, scale_conf),
                                 tuple(r.get("camera_ids", ()))[:16]),
            basis={"polygonVertices": len(ring),
                   "scaleSource": scale.get("source", "unknown"),
                   "scaleAgreement": scale.get("agreement")})
        kind = r.get("kind", "unknown")
        if kind == "unknown":
            from .stages.layout import classify_room_kind, polygon_aspect
            kind = classify_room_kind(area_m2, polygon_aspect(ring),
                                      float(r["ceiling_z"]) - float(r["floor_z"]),
                                      room_labels.get(r["id"], ()))
        rooms.append(Room(
            id=r["id"], stable_key=r["stable_key"], kind=kind,
            polygon=tuple((float(a), float(b)) for a, b in ring),
            floor_z=float(r["floor_z"]), ceiling_z=float(r["ceiling_z"]),
            area=area, floor_id=floor_id_for.get(int(r.get("floor_index", 0))),
            grounding=_grounding(prov, conf, tuple(r.get("camera_ids", ()))[:16])))
    room_ids = {r.id for r in rooms}

    # -- surfaces ----------------------------------------------------------
    surfaces: list[Surface] = []
    for s in mesh.get("surfaces", []):
        n = tuple(float(v) for v in s["normal"])
        poly = tuple(tuple(float(c) for c in p) for p in s["polygon"])
        if len(poly) < 3:
            continue
        conf = float(s.get("confidence", 0.6))
        area = Quantity(value=float(s.get("area_m2", 0.0)), unit="m2",
                        standard="CLEAR-INTERNAL",
                        tolerance=float(policy.area_tolerance_pct),
                        tolerance_unit="pct",
                        grounding=_grounding(weakest_provenance("reconstructed", scale_prov),
                                             min(conf, scale_conf))) \
            if s.get("area_m2") else None
        surfaces.append(Surface(
            id=s["id"], kind=s.get("kind", "unknown"),
            plane=Plane(n=n, d=float(s["d"])), polygon=poly,
            is_reflective=bool(s.get("is_reflective", False)),
            is_glazed=bool(s.get("is_glazed", False)),
            room_id=s.get("room_id") if s.get("room_id") in room_ids else None,
            area=area,
            grounding=_grounding("reconstructed", conf)))
    surface_ids = {s.id for s in surfaces}

    # -- openings ----------------------------------------------------------
    def _len_q(v: float, conf: float) -> Quantity:
        return Quantity(value=float(v), unit="m", standard="CLEAR-INTERNAL",
                        tolerance=float(policy.wall_tolerance_mm),
                        tolerance_unit="mm",
                        grounding=_grounding(weakest_provenance("reconstructed", scale_prov),
                                             min(conf, scale_conf)))

    openings: list[Opening] = []
    for o in layout.get("openings", []):
        conf = float(o.get("confidence", 0.5))
        openings.append(Opening(
            id=o["id"], kind=o.get("kind", "doorway"),
            centre=tuple(float(v) for v in o["centre"]),
            normal=tuple(float(v) for v in o["normal"]) if o.get("normal") else None,
            room_a=o.get("room_a") if o.get("room_a") in room_ids else None,
            room_b=o.get("room_b") if o.get("room_b") in room_ids else None,
            surface_id=o.get("surface_id") if o.get("surface_id") in surface_ids else None,
            width=_len_q(o.get("width_m", 0.0), conf) if o.get("width_m") else None,
            height=_len_q(o.get("height_m", 0.0), conf) if o.get("height_m") else None,
            sill=_len_q(o.get("sill_m", 0.0), conf) if o.get("sill_m") else None,
            grounding=_grounding("reconstructed", conf)))

    # -- cameras -----------------------------------------------------------
    cameras: list[Camera] = []
    for c in pose.get("cameras", []):
        cameras.append(Camera(
            id=c["frame_id"],
            position=tuple(float(v) for v in c["position"]),
            orientation=quat_normalise(c["orientation"]),
            intrinsics=Intrinsics(fx=float(c["fx"]), fy=float(c["fy"]),
                                  cx=float(c["cx"]), cy=float(c["cy"]),
                                  width=int(c["width"]), height=int(c["height"]),
                                  model="pinhole"),
            frame_index=int(c.get("source_index", 0)),
            t_ms=int(c.get("t_ms", 0)),
            pose_confidence=float(c.get("pose_confidence", 0.0)),
            sharpness=float(c.get("sharpness", 0.0))))
    camera_ids = {c.id for c in cameras}

    # -- entities ----------------------------------------------------------
    entities: list[Entity] = []
    for e in semantics.get("entities", []):
        observed = tuple(x for x in e.get("observed_in", ()) if x in camera_ids)
        entities.append(Entity(
            id=e["id"], stable_key=e["stable_key"], label=e["label"],
            category=e.get("category", "other"),
            centroid=tuple(float(v) for v in e["centroid"]),
            aabb=Aabb(min=tuple(float(v) for v in e["aabb_min"]),
                      max=tuple(float(v) for v in e["aabb_max"])),
            observed_in=observed,
            room_id=e.get("room_id") if e.get("room_id") in room_ids else None,
            attributes={"gaussianCount": e.get("gaussian_count"),
                        "identityStability": e.get("identity_stability")},
            # Semantics is `inferred` by definition in this contract: a model
            # decided that shape is a sofa. Even at high confidence it is not
            # `observed`, and an entity with no surviving camera reference
            # drops another level.
            grounding=_grounding("inferred" if observed else "generated",
                                 float(e.get("confidence", 0.4)), observed[:16])))

    # -- relationships and nav --------------------------------------------
    opening_ids = {o.id for o in openings}
    entity_ids = {e.id for e in entities}
    floor_ids = {f.id for f in floors}
    # A relationship is only as real as both of its endpoints. Surfaces with
    # degenerate polygons and rooms the layout dropped do not reach this
    # document, and an edge pointing at one of them describes a thing that is
    # not there. The graph stage cannot know what assembly will discard, so the
    # filtering belongs here -- and it has to happen here rather than at the
    # database, because a dangling endpoint is what an ingest cannot resolve
    # and a viewer cannot draw.
    known: dict[str, set[str]] = {
        "room": room_ids, "entity": entity_ids, "surface": surface_ids,
        "opening": opening_ids, "floor": floor_ids,
    }
    relationships: list[Relationship] = []
    dropped_relationships = 0
    for r in graph.get("relationships", []):
        subject_ok = str(r["subject_id"]) in known.get(str(r["subject_type"]), set())
        object_ok = str(r["object_id"]) in known.get(str(r["object_type"]), set())
        if not (subject_ok and object_ok):
            dropped_relationships += 1
            continue
        relationships.append(Relationship(
            subject_type=r["subject_type"], subject_id=r["subject_id"],
            predicate=r["predicate"], object_type=r["object_type"],
            object_id=r["object_id"],
            value=None if r.get("value") is None else float(r["value"]),
            grounding=_grounding(r.get("provenance", "reconstructed"),
                                 float(r.get("confidence", 0.5)))))
    if dropped_relationships:
        log(LOG, logging.WARNING, "document.relationships_dropped",
            count=dropped_relationships,
            reason="an endpoint did not survive assembly")

    nav_nodes = tuple(NavNode(id=n["id"], position=tuple(float(v) for v in n["position"]),
                              clearance=float(n["clearance"]),
                              is_entrance=bool(n["is_entrance"]),
                              is_viewpoint=bool(n["is_viewpoint"]),
                              room_id=n.get("room_id") if n.get("room_id") in room_ids else None)
                      for n in graph.get("nav_nodes", []))
    node_ids = {n.id for n in nav_nodes}
    nav_edges = tuple(NavEdge(a=e["a"], b=e["b"], cost=float(e["cost"]),
                              kind=e.get("kind", "walk"),
                              width=None if e.get("width") is None else float(e["width"]),
                              # An edge through a doorway that was not kept is
                              # still a walkable edge; it just no longer cites
                              # an opening that exists.
                              opening_id=(e.get("opening_id")
                                          if e.get("opening_id") in opening_ids else None))
                      for e in graph.get("nav_edges", [])
                      if e["a"] in node_ids and e["b"] in node_ids)

    # -- regions -----------------------------------------------------------
    region_list = tuple(Region(id=r["id"], provenance=r["provenance"],
                               volume=Aabb(min=tuple(float(v) for v in r["min"]),
                                           max=tuple(float(v) for v in r["max"])),
                               room_id=r.get("room_id") if r.get("room_id") in room_ids else None,
                               reason=r.get("reason"),
                               confidence=float(r.get("confidence", 0.5)))
                        for r in regions.get("regions", []))

    # -- assets ------------------------------------------------------------
    assets: list[Asset] = []
    for a in package.get("assets", []):
        path = a["path"]
        assets.append(Asset(id=a["id"], role=a["role"], format=a["format"],
                            url=urls.get(path, f"file://{path}"),
                            bytes=a.get("bytes"), checksum=a.get("checksum"),
                            lod=a.get("lod"), chunk_key=a.get("chunk_key"),
                            splat_count=a.get("splat_count"), meta=a.get("meta")))

    # -- quality -----------------------------------------------------------
    checks = tuple(QualityCheck(name=c["name"], value=float(c["value"]),
                                threshold=float(c["threshold"]),
                                higher_is_better=bool(c["higherIsBetter"]),
                                pass_=bool(c["pass"]), detail=c.get("detail"))
                   for c in quality.get("checks", []))
    report = QualityReport(checks=checks, score=float(quality.get("score", 0.0)),
                           verdict=quality.get("verdict", "fail"),
                           created_at=quality.get("created_at") or _now())

    doc = WorldDocument(
        id=world_id, property_id=property_id, version=int(version), label=label,
        created_at=_now(), slug=slug,
        scale=ScaleBlock(source=str(scale.get("source", "unknown")),
                         agreement=float(scale.get("agreement", 0.0)),
                         grounding=_grounding(scale_prov, scale_conf)),
        floors=tuple(floors), rooms=tuple(rooms), surfaces=tuple(surfaces),
        openings=tuple(openings), entities=tuple(entities),
        relationships=tuple(relationships), nav_nodes=nav_nodes,
        nav_edges=nav_edges, regions=region_list, cameras=tuple(cameras),
        assets=tuple(assets), quality=report, measurement_policy=policy)
    return doc


def build_and_validate(**kw: Any) -> dict[str, Any]:
    """Assemble, validate, return the JSON. Raises ContractError on failure.

    Deliberately no `strict=False` escape hatch. If a world cannot satisfy the
    contract it does not get published, and the fix belongs in the stage that
    produced the bad shape.
    """
    doc = assemble(**kw)
    payload = doc.to_json()
    errs = validate(payload)
    if errs:
        log(LOG, logging.ERROR, "document.invalid", count=len(errs), errors=errs[:10])
    validate_or_raise(payload)
    log(LOG, logging.INFO, "document.ok", rooms=len(payload["rooms"]),
        entities=len(payload["entities"]), cameras=len(payload["cameras"]),
        regions=len(payload["regions"]), verdict=payload["quality"]["verdict"])
    return payload
