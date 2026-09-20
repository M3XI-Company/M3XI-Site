"""The world contract, in Python.

This file is a transcription of spatial/packages/world-core/src/types.ts. It is
the only place in the pipeline that is allowed to know the wire shape of a
WorldDocument, and it carries a validator strict enough that a malformed
document cannot leave the process.

Two rules that the TypeScript types cannot express and this file must:

  * A Quantity without a standard and a tolerance is a liability, not a
    feature. validate() rejects it.
  * A ring that is not counter-clockwise viewed from above is rejected rather
    than silently flipped, because a silently flipped ring changes which side
    of a wall the viewer thinks it is on.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Sequence

from .geometry import is_ccw_from_above, polygon_area, quat_normalise

# ---------------------------------------------------------------------------
# Vocabularies (kept in the same order as types.ts so a diff is readable)
# ---------------------------------------------------------------------------

Provenance = Literal["observed", "reconstructed", "inferred", "generated"]

PROVENANCE_RANK: dict[str, int] = {
    "observed": 0, "reconstructed": 1, "inferred": 2, "generated": 3,
}

MEASUREMENT_STANDARDS = ("RICS-COMP-GIA", "RICS-COMP-NIA", "IPMS-3C", "CLEAR-INTERNAL")

ROOM_KINDS = (
    "living", "kitchen", "bedroom", "bathroom", "wc", "hall", "landing",
    "stairwell", "utility", "storage", "office", "dining", "conservatory",
    "garage", "balcony", "garden", "exterior", "unknown",
)
SURFACE_KINDS = ("wall", "floor", "ceiling", "soffit", "column", "unknown")
OPENING_KINDS = ("door", "doorway", "window", "rooflight", "stair", "hatch", "arch")
ASSET_ROLES = (
    "splat", "splat_chunk", "proxy_mesh", "visual_mesh", "pointcloud",
    "floorplan", "cover", "depth_archive", "source_media", "export_bundle",
)
NODE_TYPES = ("room", "entity", "surface", "opening", "floor")
PREDICATES = (
    "inside", "contains", "adjacent_to", "connected_to", "near", "far_from",
    "above", "below", "left_of", "right_of", "attached_to", "intersects",
    "visible_from", "blocks", "opens_into", "supports", "located_on",
)
ENTITY_CATEGORIES = ("furniture", "appliance", "fixture", "fitting", "structure", "other")

# Region.provenance is Exclude<Provenance, 'reconstructed'> in types.ts: a
# region is either something a camera saw, something a model guessed at, or
# something a model invented. Geometry never "derives" an unobserved volume.
REGION_PROVENANCE = ("observed", "inferred", "generated")


def weakest_provenance(*p: str) -> str:
    """Worst wins, matching weakestProvenance() in types.ts."""
    out = "observed"
    for q in p:
        if q not in PROVENANCE_RANK:
            raise ValueError(f"unknown provenance {q!r}")
        if PROVENANCE_RANK[q] > PROVENANCE_RANK[out]:
            out = q
    return out


class ContractError(ValueError):
    """Raised when a document does not match types.ts. Never caught inside the
    pipeline: a document that fails this has no business being published."""


# ---------------------------------------------------------------------------
# Leaf records
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class Grounding:
    provenance: Provenance
    confidence: float
    sources: tuple[str, ...] = ()

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"provenance": self.provenance,
                               "confidence": round(float(self.confidence), 4)}
        if self.sources:
            out["sources"] = list(self.sources)
        return out

    def weakened_to(self, provenance: str, confidence: float | None = None) -> "Grounding":
        return Grounding(
            provenance=weakest_provenance(self.provenance, provenance),  # type: ignore[arg-type]
            confidence=min(self.confidence, confidence) if confidence is not None else self.confidence,
            sources=self.sources,
        )


@dataclass(frozen=True, slots=True)
class Quantity:
    value: float
    unit: Literal["m", "m2", "m3", "deg"]
    standard: str
    tolerance: float
    tolerance_unit: Literal["mm", "pct"]
    grounding: Grounding
    basis: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "value": float(self.value),
            "unit": self.unit,
            "standard": self.standard,
            "tolerance": float(self.tolerance),
            "toleranceUnit": self.tolerance_unit,
            "grounding": self.grounding.to_json(),
        }
        if self.basis is not None:
            out["basis"] = self.basis
        return out


@dataclass(frozen=True, slots=True)
class Intrinsics:
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int
    model: Literal["pinhole", "opencv", "fisheye"] = "opencv"
    dist: tuple[float, ...] = ()

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "fx": float(self.fx), "fy": float(self.fy),
            "cx": float(self.cx), "cy": float(self.cy),
            "width": int(self.width), "height": int(self.height),
            "model": self.model,
        }
        if self.dist:
            out["dist"] = [float(d) for d in self.dist]
        return out


@dataclass(frozen=True, slots=True)
class Camera:
    id: str
    position: tuple[float, float, float]
    orientation: tuple[float, float, float, float]
    intrinsics: Intrinsics
    capture_id: str | None = None
    frame_index: int | None = None
    t_ms: int | None = None
    pose_confidence: float | None = None
    sharpness: float | None = None
    room_id: str | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "position": [float(v) for v in self.position],
            "orientation": [float(v) for v in quat_normalise(self.orientation)],
            "intrinsics": self.intrinsics.to_json(),
        }
        for key, val in (("captureId", self.capture_id), ("frameIndex", self.frame_index),
                         ("tMs", self.t_ms), ("poseConfidence", self.pose_confidence),
                         ("sharpness", self.sharpness), ("roomId", self.room_id)):
            if val is not None:
                out[key] = val
        return out


@dataclass(frozen=True, slots=True)
class Asset:
    id: str
    role: str
    format: str
    url: str
    bytes: int | None = None
    checksum: str | None = None
    lod: int | None = None
    chunk_key: str | None = None
    splat_count: int | None = None
    meta: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "role": self.role,
                               "format": self.format, "url": self.url}
        for key, val in (("bytes", self.bytes), ("checksum", self.checksum),
                         ("lod", self.lod), ("chunkKey", self.chunk_key),
                         ("splatCount", self.splat_count), ("meta", self.meta)):
            if val is not None:
                out[key] = val
        return out


@dataclass(frozen=True, slots=True)
class Floor:
    id: str
    level: int
    elevation: float
    grounding: Grounding
    name: str | None = None

    def to_json(self) -> dict[str, Any]:
        out = {"id": self.id, "level": int(self.level),
               "elevation": float(self.elevation),
               "grounding": self.grounding.to_json()}
        if self.name:
            out["name"] = self.name
        return out


@dataclass(frozen=True, slots=True)
class Room:
    id: str
    stable_key: str
    kind: str
    polygon: tuple[tuple[float, float], ...]
    floor_z: float
    ceiling_z: float
    area: Quantity
    grounding: Grounding
    floor_id: str | None = None
    name: str | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id, "stableKey": self.stable_key, "kind": self.kind,
            "polygon": [[float(p[0]), float(p[1])] for p in self.polygon],
            "floorZ": float(self.floor_z), "ceilingZ": float(self.ceiling_z),
            "area": self.area.to_json(), "grounding": self.grounding.to_json(),
        }
        if self.floor_id:
            out["floorId"] = self.floor_id
        if self.name:
            out["name"] = self.name
        return out


@dataclass(frozen=True, slots=True)
class Plane:
    n: tuple[float, float, float]
    d: float

    def to_json(self) -> dict[str, Any]:
        return {"n": [float(v) for v in self.n], "d": float(self.d)}


@dataclass(frozen=True, slots=True)
class Surface:
    id: str
    kind: str
    plane: Plane
    polygon: tuple[tuple[float, float, float], ...]
    is_reflective: bool
    is_glazed: bool
    grounding: Grounding
    room_id: str | None = None
    area: Quantity | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id, "kind": self.kind, "plane": self.plane.to_json(),
            "polygon": [[float(c) for c in p] for p in self.polygon],
            "isReflective": bool(self.is_reflective),
            "isGlazed": bool(self.is_glazed),
            "grounding": self.grounding.to_json(),
        }
        if self.room_id:
            out["roomId"] = self.room_id
        if self.area is not None:
            out["area"] = self.area.to_json()
        return out


@dataclass(frozen=True, slots=True)
class Opening:
    id: str
    kind: str
    centre: tuple[float, float, float]
    grounding: Grounding
    surface_id: str | None = None
    room_a: str | None = None
    room_b: str | None = None
    normal: tuple[float, float, float] | None = None
    width: Quantity | None = None
    height: Quantity | None = None
    sill: Quantity | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id, "kind": self.kind,
            "centre": [float(v) for v in self.centre],
            "grounding": self.grounding.to_json(),
        }
        if self.surface_id:
            out["surfaceId"] = self.surface_id
        if self.room_a:
            out["roomA"] = self.room_a
        if self.room_b:
            out["roomB"] = self.room_b
        if self.normal is not None:
            out["normal"] = [float(v) for v in self.normal]
        for key, q in (("width", self.width), ("height", self.height), ("sill", self.sill)):
            if q is not None:
                out[key] = q.to_json()
        return out


@dataclass(frozen=True, slots=True)
class Aabb:
    min: tuple[float, float, float]
    max: tuple[float, float, float]

    def to_json(self) -> dict[str, Any]:
        return {"min": [float(v) for v in self.min], "max": [float(v) for v in self.max]}


@dataclass(frozen=True, slots=True)
class Obb:
    centre: tuple[float, float, float]
    half: tuple[float, float, float]
    quat: tuple[float, float, float, float]

    def to_json(self) -> dict[str, Any]:
        return {"centre": [float(v) for v in self.centre],
                "half": [float(v) for v in self.half],
                "quat": [float(v) for v in quat_normalise(self.quat)]}


@dataclass(frozen=True, slots=True)
class Entity:
    id: str
    stable_key: str
    label: str
    category: str
    centroid: tuple[float, float, float]
    aabb: Aabb
    observed_in: tuple[str, ...]
    grounding: Grounding
    room_id: str | None = None
    obb: Obb | None = None
    attributes: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id, "stableKey": self.stable_key, "label": self.label,
            "category": self.category,
            "centroid": [float(v) for v in self.centroid],
            "aabb": self.aabb.to_json(),
            "observedIn": list(self.observed_in),
            "grounding": self.grounding.to_json(),
        }
        if self.room_id:
            out["roomId"] = self.room_id
        if self.obb is not None:
            out["obb"] = self.obb.to_json()
        if self.attributes:
            out["attributes"] = self.attributes
        return out


@dataclass(frozen=True, slots=True)
class Relationship:
    subject_type: str
    subject_id: str
    predicate: str
    object_type: str
    object_id: str
    grounding: Grounding
    value: float | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "subjectType": self.subject_type, "subjectId": self.subject_id,
            "predicate": self.predicate,
            "objectType": self.object_type, "objectId": self.object_id,
            "grounding": self.grounding.to_json(),
        }
        if self.value is not None:
            out["value"] = float(self.value)
        return out


@dataclass(frozen=True, slots=True)
class NavNode:
    id: str
    position: tuple[float, float, float]
    clearance: float
    is_entrance: bool
    is_viewpoint: bool
    room_id: str | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id, "position": [float(v) for v in self.position],
            "clearance": float(self.clearance),
            "isEntrance": bool(self.is_entrance),
            "isViewpoint": bool(self.is_viewpoint),
        }
        if self.room_id:
            out["roomId"] = self.room_id
        return out


@dataclass(frozen=True, slots=True)
class NavEdge:
    a: str
    b: str
    cost: float
    kind: Literal["walk", "door", "stair"]
    width: float | None = None
    opening_id: str | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"a": self.a, "b": self.b,
                               "cost": float(self.cost), "kind": self.kind}
        if self.width is not None:
            out["width"] = float(self.width)
        if self.opening_id:
            out["openingId"] = self.opening_id
        return out


@dataclass(frozen=True, slots=True)
class Region:
    id: str
    provenance: str
    volume: Aabb
    room_id: str | None = None
    reason: str | None = None
    confidence: float | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "provenance": self.provenance,
                               "volume": self.volume.to_json()}
        if self.room_id:
            out["roomId"] = self.room_id
        if self.reason:
            out["reason"] = self.reason
        if self.confidence is not None:
            out["confidence"] = float(self.confidence)
        return out


@dataclass(frozen=True, slots=True)
class QualityCheck:
    name: str
    value: float
    threshold: float
    higher_is_better: bool
    pass_: bool
    detail: str | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "name": self.name, "value": float(self.value),
            "threshold": float(self.threshold),
            "higherIsBetter": bool(self.higher_is_better),
            "pass": bool(self.pass_),
        }
        if self.detail:
            out["detail"] = self.detail
        return out


@dataclass(frozen=True, slots=True)
class QualityReport:
    checks: tuple[QualityCheck, ...]
    score: float
    verdict: Literal["pass", "review", "fail"]
    created_at: str

    def to_json(self) -> dict[str, Any]:
        return {"checks": [c.to_json() for c in self.checks],
                "score": round(float(self.score), 4),
                "verdict": self.verdict,
                "createdAt": self.created_at}


@dataclass(frozen=True, slots=True)
class ScaleBlock:
    source: str
    agreement: float
    grounding: Grounding

    def to_json(self) -> dict[str, Any]:
        return {"source": self.source,
                "agreement": round(float(self.agreement), 4),
                "grounding": self.grounding.to_json()}


@dataclass(frozen=True, slots=True)
class MeasurementPolicy:
    area_standard: str
    area_tolerance_pct: float
    wall_tolerance_mm: float

    def to_json(self) -> dict[str, Any]:
        return {"areaStandard": self.area_standard,
                "areaTolerancePct": float(self.area_tolerance_pct),
                "wallToleranceMm": float(self.wall_tolerance_mm)}


# The published policy for a phone-video reconstruction.
#
# RICS-COMP-GIA because UK agency listings quote gross internal area and a
# reconstruction measures to the internal wall face, which is what GIA wants.
# 5% area tolerance and 50 mm wall tolerance because that is what monocular
# metric scale actually delivers indoors (see stages/scale.py for the
# measurement that backs this). Quoting tighter would be a misrepresentation
# under the DMCC Act 2024; quoting looser would be useless to a buyer.
DEFAULT_MEASUREMENT_POLICY = MeasurementPolicy(
    area_standard="RICS-COMP-GIA", area_tolerance_pct=5.0, wall_tolerance_mm=50.0
)


@dataclass(frozen=True, slots=True)
class WorldDocument:
    id: str
    property_id: str
    version: int
    label: str
    created_at: str
    scale: ScaleBlock
    floors: tuple[Floor, ...]
    rooms: tuple[Room, ...]
    surfaces: tuple[Surface, ...]
    openings: tuple[Opening, ...]
    entities: tuple[Entity, ...]
    relationships: tuple[Relationship, ...]
    nav_nodes: tuple[NavNode, ...]
    nav_edges: tuple[NavEdge, ...]
    regions: tuple[Region, ...]
    cameras: tuple[Camera, ...]
    assets: tuple[Asset, ...]
    quality: QualityReport
    measurement_policy: MeasurementPolicy = DEFAULT_MEASUREMENT_POLICY
    slug: str | None = None
    published_at: str | None = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "formatVersion": 1,
            "id": self.id,
            "propertyId": self.property_id,
            "version": int(self.version),
            "label": self.label,
            "createdAt": self.created_at,
            "units": {"length": "m", "angle": "rad"},
            "upAxis": "Y",
            "handedness": "right",
            "scale": self.scale.to_json(),
            "floors": [f.to_json() for f in self.floors],
            "rooms": [r.to_json() for r in self.rooms],
            "surfaces": [s.to_json() for s in self.surfaces],
            "openings": [o.to_json() for o in self.openings],
            "entities": [e.to_json() for e in self.entities],
            "relationships": [r.to_json() for r in self.relationships],
            "nav": {"nodes": [n.to_json() for n in self.nav_nodes],
                    "edges": [e.to_json() for e in self.nav_edges]},
            "regions": [r.to_json() for r in self.regions],
            "cameras": [c.to_json() for c in self.cameras],
            "assets": [a.to_json() for a in self.assets],
            "quality": self.quality.to_json(),
            "measurementPolicy": self.measurement_policy.to_json(),
        }
        if self.slug:
            out["slug"] = self.slug
        if self.published_at:
            out["publishedAt"] = self.published_at
        return out


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")


def _err(errors: list[str], cond: bool, msg: str) -> None:
    if not cond:
        errors.append(msg)


def _check_grounding(errors: list[str], where: str, g: Any) -> None:
    if not isinstance(g, dict):
        errors.append(f"{where}: grounding missing")
        return
    _err(errors, g.get("provenance") in PROVENANCE_RANK,
         f"{where}: bad provenance {g.get('provenance')!r}")
    c = g.get("confidence")
    _err(errors, isinstance(c, (int, float)) and 0.0 <= float(c) <= 1.0,
         f"{where}: confidence must be in [0,1], got {c!r}")


def _check_quantity(errors: list[str], where: str, q: Any) -> None:
    if not isinstance(q, dict):
        errors.append(f"{where}: quantity missing")
        return
    _err(errors, isinstance(q.get("value"), (int, float)) and math.isfinite(float(q["value"])),
         f"{where}: non-finite value")
    _err(errors, q.get("unit") in ("m", "m2", "m3", "deg"), f"{where}: bad unit {q.get('unit')!r}")
    # The rule that costs money if it is wrong: no standard, no tolerance, no exit.
    _err(errors, q.get("standard") in MEASUREMENT_STANDARDS,
         f"{where}: undeclared measurement standard {q.get('standard')!r}")
    _err(errors, isinstance(q.get("tolerance"), (int, float)) and float(q["tolerance"]) > 0,
         f"{where}: tolerance must be a positive number")
    _err(errors, q.get("toleranceUnit") in ("mm", "pct"),
         f"{where}: bad toleranceUnit {q.get('toleranceUnit')!r}")
    _check_grounding(errors, where, q.get("grounding"))


def _vec(errors: list[str], where: str, v: Any, n: int) -> None:
    ok = (isinstance(v, (list, tuple)) and len(v) == n
          and all(isinstance(c, (int, float)) and math.isfinite(float(c)) for c in v))
    _err(errors, ok, f"{where}: expected {n} finite numbers, got {v!r}")


def validate(doc: dict[str, Any], *, strict_rings: bool = True) -> list[str]:
    """Return a list of contract violations. Empty list means the document
    matches types.ts. Never raises on bad input; returns why instead."""
    e: list[str] = []
    if not isinstance(doc, dict):
        return ["document is not an object"]

    _err(e, doc.get("formatVersion") == 1, "formatVersion must be the literal 1")
    for key in ("id", "propertyId", "label", "createdAt"):
        _err(e, isinstance(doc.get(key), str) and doc[key], f"{key} must be a non-empty string")
    _err(e, isinstance(doc.get("version"), int) and doc["version"] >= 1,
         "version must be an integer >= 1")
    _err(e, bool(_ISO.match(str(doc.get("createdAt", "")))),
         f"createdAt must be an ISO-8601 instant, got {doc.get('createdAt')!r}")

    # Frame conventions. These are literals in types.ts; a document that gets
    # them wrong renders upside down rather than failing, so check them hard.
    _err(e, doc.get("units") == {"length": "m", "angle": "rad"},
         f"units must be {{length:'m', angle:'rad'}}, got {doc.get('units')!r}")
    _err(e, doc.get("upAxis") == "Y", f"upAxis must be 'Y', got {doc.get('upAxis')!r}")
    _err(e, doc.get("handedness") == "right",
         f"handedness must be 'right', got {doc.get('handedness')!r}")

    scale = doc.get("scale")
    if not isinstance(scale, dict):
        e.append("scale block missing")
    else:
        _err(e, isinstance(scale.get("source"), str) and scale["source"], "scale.source missing")
        a = scale.get("agreement")
        _err(e, isinstance(a, (int, float)) and 0.0 <= float(a) <= 1.0,
             f"scale.agreement must be in [0,1], got {a!r}")
        _check_grounding(e, "scale", scale.get("grounding"))

    mp = doc.get("measurementPolicy")
    if not isinstance(mp, dict):
        e.append("measurementPolicy missing")
    else:
        _err(e, mp.get("areaStandard") in MEASUREMENT_STANDARDS,
             f"measurementPolicy.areaStandard invalid: {mp.get('areaStandard')!r}")
        _err(e, isinstance(mp.get("areaTolerancePct"), (int, float)) and mp["areaTolerancePct"] > 0,
             "measurementPolicy.areaTolerancePct must be positive")
        _err(e, isinstance(mp.get("wallToleranceMm"), (int, float)) and mp["wallToleranceMm"] > 0,
             "measurementPolicy.wallToleranceMm must be positive")

    for key in ("floors", "rooms", "surfaces", "openings", "entities",
                "relationships", "regions", "cameras", "assets"):
        if not isinstance(doc.get(key), list):
            e.append(f"{key} must be an array")
    nav = doc.get("nav")
    if not isinstance(nav, dict) or not isinstance(nav.get("nodes"), list) \
            or not isinstance(nav.get("edges"), list):
        e.append("nav must be {nodes: [], edges: []}")
        nav = {"nodes": [], "edges": []}

    floor_ids = {f.get("id") for f in doc.get("floors", []) if isinstance(f, dict)}
    room_ids: set[str] = set()
    surface_ids: set[str] = set()
    camera_ids: set[str] = set()

    for i, f in enumerate(doc.get("floors", []) or []):
        w = f"floors[{i}]"
        _err(e, isinstance(f.get("id"), str) and f["id"], f"{w}.id missing")
        _err(e, isinstance(f.get("level"), int), f"{w}.level must be an integer")
        _err(e, isinstance(f.get("elevation"), (int, float)), f"{w}.elevation must be a number")
        _check_grounding(e, w, f.get("grounding"))

    seen_stable: set[str] = set()
    for i, r in enumerate(doc.get("rooms", []) or []):
        w = f"rooms[{i}]"
        rid = r.get("id")
        _err(e, isinstance(rid, str) and rid, f"{w}.id missing")
        if isinstance(rid, str):
            room_ids.add(rid)
        sk = r.get("stableKey")
        _err(e, isinstance(sk, str) and sk, f"{w}.stableKey missing")
        _err(e, sk not in seen_stable, f"{w}.stableKey {sk!r} is not unique")
        if isinstance(sk, str):
            seen_stable.add(sk)
        _err(e, r.get("kind") in ROOM_KINDS, f"{w}.kind invalid: {r.get('kind')!r}")
        poly = r.get("polygon")
        if not isinstance(poly, list) or len(poly) < 3:
            e.append(f"{w}.polygon needs at least 3 vertices")
        else:
            for j, p in enumerate(poly):
                _vec(e, f"{w}.polygon[{j}]", p, 2)
            if strict_rings and all(isinstance(p, (list, tuple)) and len(p) == 2 for p in poly):
                _err(e, is_ccw_from_above(poly),
                     f"{w}.polygon must be counter-clockwise viewed from above")
                _err(e, polygon_area(poly) > 0.25,
                     f"{w}.polygon area {polygon_area(poly):.3f} m2 is below the 0.25 m2 "
                     "floor; a room that small is a reconstruction artefact")
        fz, cz = r.get("floorZ"), r.get("ceilingZ")
        _err(e, isinstance(fz, (int, float)) and isinstance(cz, (int, float)) and cz > fz,
             f"{w}: ceilingZ must be above floorZ")
        _check_quantity(e, f"{w}.area", r.get("area"))
        _check_grounding(e, w, r.get("grounding"))
        if r.get("floorId") is not None:
            _err(e, r["floorId"] in floor_ids, f"{w}.floorId {r['floorId']!r} is dangling")

    for i, s in enumerate(doc.get("surfaces", []) or []):
        w = f"surfaces[{i}]"
        sid = s.get("id")
        _err(e, isinstance(sid, str) and sid, f"{w}.id missing")
        if isinstance(sid, str):
            surface_ids.add(sid)
        _err(e, s.get("kind") in SURFACE_KINDS, f"{w}.kind invalid: {s.get('kind')!r}")
        pl = s.get("plane")
        if not isinstance(pl, dict):
            e.append(f"{w}.plane missing")
        else:
            _vec(e, f"{w}.plane.n", pl.get("n"), 3)
            if isinstance(pl.get("n"), (list, tuple)) and len(pl["n"]) == 3:
                nrm = math.sqrt(sum(float(c) ** 2 for c in pl["n"]))
                _err(e, abs(nrm - 1.0) < 1e-3, f"{w}.plane.n must be unit, |n|={nrm:.5f}")
            _err(e, isinstance(pl.get("d"), (int, float)), f"{w}.plane.d must be a number")
        poly = s.get("polygon")
        _err(e, isinstance(poly, list) and len(poly) >= 3, f"{w}.polygon needs >= 3 vertices")
        if isinstance(poly, list):
            for j, p in enumerate(poly):
                _vec(e, f"{w}.polygon[{j}]", p, 3)
        _err(e, isinstance(s.get("isReflective"), bool), f"{w}.isReflective must be a boolean")
        _err(e, isinstance(s.get("isGlazed"), bool), f"{w}.isGlazed must be a boolean")
        _check_grounding(e, w, s.get("grounding"))
        if s.get("roomId") is not None:
            _err(e, s["roomId"] in room_ids, f"{w}.roomId {s['roomId']!r} is dangling")
        if s.get("area") is not None:
            _check_quantity(e, f"{w}.area", s["area"])

    for i, o in enumerate(doc.get("openings", []) or []):
        w = f"openings[{i}]"
        _err(e, isinstance(o.get("id"), str) and o["id"], f"{w}.id missing")
        _err(e, o.get("kind") in OPENING_KINDS, f"{w}.kind invalid: {o.get('kind')!r}")
        _vec(e, f"{w}.centre", o.get("centre"), 3)
        _check_grounding(e, w, o.get("grounding"))
        for key in ("roomA", "roomB"):
            if o.get(key) is not None:
                _err(e, o[key] in room_ids, f"{w}.{key} {o[key]!r} is dangling")
        if o.get("surfaceId") is not None:
            _err(e, o["surfaceId"] in surface_ids, f"{w}.surfaceId is dangling")
        for key in ("width", "height", "sill"):
            if o.get(key) is not None:
                _check_quantity(e, f"{w}.{key}", o[key])

    for i, c in enumerate(doc.get("cameras", []) or []):
        w = f"cameras[{i}]"
        cid = c.get("id")
        _err(e, isinstance(cid, str) and cid, f"{w}.id missing")
        if isinstance(cid, str):
            camera_ids.add(cid)
        _vec(e, f"{w}.position", c.get("position"), 3)
        _vec(e, f"{w}.orientation", c.get("orientation"), 4)
        q = c.get("orientation")
        if isinstance(q, (list, tuple)) and len(q) == 4:
            n = math.sqrt(sum(float(v) ** 2 for v in q))
            _err(e, abs(n - 1.0) < 1e-4, f"{w}.orientation must be unit, |q|={n:.6f}")
        intr = c.get("intrinsics")
        if not isinstance(intr, dict):
            e.append(f"{w}.intrinsics missing")
        else:
            for key in ("fx", "fy", "cx", "cy"):
                _err(e, isinstance(intr.get(key), (int, float)) and math.isfinite(float(intr[key])),
                     f"{w}.intrinsics.{key} invalid")
            for key in ("width", "height"):
                _err(e, isinstance(intr.get(key), int) and intr[key] > 0,
                     f"{w}.intrinsics.{key} must be a positive integer")
            _err(e, float(intr.get("fx", 0)) > 0 and float(intr.get("fy", 0)) > 0,
                 f"{w}.intrinsics focal lengths must be positive")
        if c.get("roomId") is not None:
            _err(e, c["roomId"] in room_ids, f"{w}.roomId {c['roomId']!r} is dangling")

    for i, en in enumerate(doc.get("entities", []) or []):
        w = f"entities[{i}]"
        _err(e, isinstance(en.get("id"), str) and en["id"], f"{w}.id missing")
        _err(e, isinstance(en.get("stableKey"), str) and en["stableKey"], f"{w}.stableKey missing")
        _err(e, isinstance(en.get("label"), str) and en["label"], f"{w}.label missing")
        _err(e, en.get("category") in ENTITY_CATEGORIES, f"{w}.category invalid")
        _vec(e, f"{w}.centroid", en.get("centroid"), 3)
        ab = en.get("aabb")
        if not isinstance(ab, dict):
            e.append(f"{w}.aabb missing")
        else:
            _vec(e, f"{w}.aabb.min", ab.get("min"), 3)
            _vec(e, f"{w}.aabb.max", ab.get("max"), 3)
            if isinstance(ab.get("min"), list) and isinstance(ab.get("max"), list) \
                    and len(ab["min"]) == 3 and len(ab["max"]) == 3:
                _err(e, all(float(ab["max"][k]) >= float(ab["min"][k]) for k in range(3)),
                     f"{w}.aabb is inverted")
        obs = en.get("observedIn")
        _err(e, isinstance(obs, list), f"{w}.observedIn must be an array")
        if isinstance(obs, list) and camera_ids:
            dangling = [o for o in obs if o not in camera_ids]
            _err(e, not dangling, f"{w}.observedIn references unknown cameras {dangling[:3]}")
        # An entity with no observation is not an entity, it is a guess with a
        # bounding box. Allowed only if its provenance says so.
        g = en.get("grounding") or {}
        if isinstance(obs, list) and not obs:
            _err(e, g.get("provenance") in ("inferred", "generated"),
                 f"{w}: no observedIn cameras, so provenance cannot be "
                 f"{g.get('provenance')!r}")
        _check_grounding(e, w, g)
        if en.get("roomId") is not None:
            _err(e, en["roomId"] in room_ids, f"{w}.roomId is dangling")

    node_ids: set[str] = set()
    for i, n in enumerate(nav.get("nodes", []) or []):
        w = f"nav.nodes[{i}]"
        nid = n.get("id")
        _err(e, isinstance(nid, str) and nid, f"{w}.id missing")
        if isinstance(nid, str):
            node_ids.add(nid)
        _vec(e, f"{w}.position", n.get("position"), 3)
        _err(e, isinstance(n.get("clearance"), (int, float)) and float(n["clearance"]) >= 0,
             f"{w}.clearance must be >= 0")
        _err(e, isinstance(n.get("isEntrance"), bool), f"{w}.isEntrance must be a boolean")
        _err(e, isinstance(n.get("isViewpoint"), bool), f"{w}.isViewpoint must be a boolean")
        if n.get("roomId") is not None:
            _err(e, n["roomId"] in room_ids, f"{w}.roomId is dangling")

    for i, ed in enumerate(nav.get("edges", []) or []):
        w = f"nav.edges[{i}]"
        _err(e, ed.get("a") in node_ids, f"{w}.a {ed.get('a')!r} is dangling")
        _err(e, ed.get("b") in node_ids, f"{w}.b {ed.get('b')!r} is dangling")
        _err(e, isinstance(ed.get("cost"), (int, float)) and float(ed["cost"]) >= 0,
             f"{w}.cost must be >= 0")
        _err(e, ed.get("kind") in ("walk", "door", "stair"), f"{w}.kind invalid")

    for i, r in enumerate(doc.get("relationships", []) or []):
        w = f"relationships[{i}]"
        _err(e, r.get("subjectType") in NODE_TYPES, f"{w}.subjectType invalid")
        _err(e, r.get("objectType") in NODE_TYPES, f"{w}.objectType invalid")
        _err(e, r.get("predicate") in PREDICATES, f"{w}.predicate invalid: {r.get('predicate')!r}")
        _check_grounding(e, w, r.get("grounding"))

    for i, rg in enumerate(doc.get("regions", []) or []):
        w = f"regions[{i}]"
        _err(e, isinstance(rg.get("id"), str) and rg["id"], f"{w}.id missing")
        # types.ts: Exclude<Provenance, 'reconstructed'>. Geometry does not
        # "derive" a volume nobody looked at.
        _err(e, rg.get("provenance") in REGION_PROVENANCE,
             f"{w}.provenance must be one of {REGION_PROVENANCE}, got {rg.get('provenance')!r}")
        vol = rg.get("volume")
        if not isinstance(vol, dict):
            e.append(f"{w}.volume missing")
        else:
            _vec(e, f"{w}.volume.min", vol.get("min"), 3)
            _vec(e, f"{w}.volume.max", vol.get("max"), 3)
        if rg.get("roomId") is not None:
            _err(e, rg["roomId"] in room_ids, f"{w}.roomId is dangling")

    for i, a in enumerate(doc.get("assets", []) or []):
        w = f"assets[{i}]"
        _err(e, isinstance(a.get("id"), str) and a["id"], f"{w}.id missing")
        _err(e, a.get("role") in ASSET_ROLES, f"{w}.role invalid: {a.get('role')!r}")
        _err(e, isinstance(a.get("format"), str) and a["format"], f"{w}.format missing")
        _err(e, isinstance(a.get("url"), str) and a["url"], f"{w}.url missing")

    q = doc.get("quality")
    if not isinstance(q, dict):
        e.append("quality report missing")
    else:
        _err(e, q.get("verdict") in ("pass", "review", "fail"),
             f"quality.verdict invalid: {q.get('verdict')!r}")
        sc = q.get("score")
        _err(e, isinstance(sc, (int, float)) and 0.0 <= float(sc) <= 1.0,
             f"quality.score must be in [0,1], got {sc!r}")
        checks = q.get("checks")
        _err(e, isinstance(checks, list) and len(checks) > 0,
             "quality.checks must be a non-empty array")
        for j, c in enumerate(checks or []):
            cw = f"quality.checks[{j}]"
            _err(e, isinstance(c.get("name"), str) and c["name"], f"{cw}.name missing")
            _err(e, isinstance(c.get("value"), (int, float)), f"{cw}.value must be a number")
            _err(e, isinstance(c.get("threshold"), (int, float)), f"{cw}.threshold must be a number")
            _err(e, isinstance(c.get("pass"), bool), f"{cw}.pass must be a boolean")
            _err(e, isinstance(c.get("higherIsBetter"), bool),
                 f"{cw}.higherIsBetter must be a boolean")

    return e


def validate_or_raise(doc: dict[str, Any], *, strict_rings: bool = True) -> dict[str, Any]:
    errs = validate(doc, strict_rings=strict_rings)
    if errs:
        head = "\n  ".join(errs[:25])
        more = f"\n  ... and {len(errs) - 25} more" if len(errs) > 25 else ""
        raise ContractError(f"{len(errs)} contract violation(s):\n  {head}{more}")
    return doc
