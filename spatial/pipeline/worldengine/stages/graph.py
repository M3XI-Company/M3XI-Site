"""graph — the scene graph and the navigation mesh, computed from geometry.

Nothing in this stage asks a language model anything. Every relationship is a
geometric predicate evaluated over the room polygons, the surfaces, the
openings and the entity boxes, so "the fridge is in the kitchen" is a
containment test with a receipt, not a caption. That is what lets the viewer's
agent answer spatial questions and refuse when the geometry does not support an
answer.

The navigation graph is built here too, because navigability is a geometric
property of the same data: nodes on a grid of free floor space, edges between
neighbouring nodes, door edges through openings, stair edges between floors.
The quality gate checks that every room is reachable, and that check is only
meaningful if the graph was built without knowing what the answer should be.
"""
from __future__ import annotations

import json
import logging
import math
from collections import deque
from dataclasses import asdict, dataclass, field, replace
from typing import Any, Iterable, Sequence

import numpy as np

from ..geometry import point_in_ring, polygon_area, ring_centroid
from ..logging_setup import get_logger, log
from ..runner import RunContext, StageError

LOG = get_logger("worldengine.graph")

SUMMARY = "Geometric scene graph and navigation mesh; no model is consulted"
USES_GPU = False
PRODUCES = ("graph.json",)

# Navigation grid spacing. 0.25 m is fine enough that a 686 mm door gets two
# nodes across it and coarse enough that a 70 m2 flat is a few thousand nodes.
NAV_GRID_M = 0.25
# Minimum clearance for a node to be walkable. 0.28 m radius is the half-width
# the viewer's camera controller enforces; a node below it is inside furniture.
MIN_CLEARANCE_M = 0.28
# Nodes within this of each other are connected. sqrt(2) * grid covers the
# diagonal so the graph is 8-connected.
NAV_LINK_M = NAV_GRID_M * 1.45

# "near" for the scene graph. 1.5 m is conversational distance and roughly the
# distance at which a buyer would say two things are next to each other.
NEAR_M = 1.5
# Two rooms are adjacent when their polygons come within this.
ADJACENT_M = 0.35
# An entity is `located_on` another when its base is within 12 cm of the
# other's top and their footprints overlap by at least a third.
ON_GAP_M = 0.12
ON_OVERLAP = 0.33


@dataclass(slots=True)
class Input:
    rooms: list[dict[str, Any]]
    openings: list[dict[str, Any]]
    entities: list[dict[str, Any]]
    surfaces: list[dict[str, Any]]
    cameras: list[dict[str, Any]]
    floor_elevations: list[float]


@dataclass(slots=True)
class Rel:
    subject_type: str
    subject_id: str
    predicate: str
    object_type: str
    object_id: str
    value: float | None
    provenance: str
    confidence: float


@dataclass(slots=True)
class NavN:
    id: str
    room_id: str | None
    position: list[float]
    clearance: float
    is_entrance: bool
    is_viewpoint: bool


@dataclass(slots=True)
class NavE:
    a: str
    b: str
    cost: float
    width: float | None
    kind: str
    opening_id: str | None


@dataclass(slots=True)
class Output:
    relationships: list[Rel]
    nav_nodes: list[NavN]
    nav_edges: list[NavE]
    graph_path: str
    reachable_rooms: list[str]
    unreachable_rooms: list[str]
    navigation_continuity: float
    warnings: list[str] = field(default_factory=list)


def build_input(ctx: RunContext, upstream: dict[str, Any]) -> Input:
    lay = upstream.get("layout") or {}
    sem = upstream.get("semantics") or {}
    if not lay.get("rooms"):
        raise StageError("graph requires the layout stage output")
    mesh = ctx.store.load("mesh") or {}
    pose = ctx.store.load("pose") or {}
    return Input(
        rooms=list(lay["rooms"]), openings=list(lay.get("openings", [])),
        entities=list(sem.get("entities", [])),
        surfaces=list(mesh.get("surfaces", [])),
        cameras=list(pose.get("cameras", [])),
        floor_elevations=list(lay.get("floor_elevations", [0.0])),
    )


# ---------------------------------------------------------------------------
# Predicates — pure, tested
# ---------------------------------------------------------------------------

def ring_distance(a: Sequence[Sequence[float]], b: Sequence[Sequence[float]]) -> float:
    """Minimum distance between two XZ rings, 0 if they touch or overlap."""
    if any(point_in_ring(p, b) for p in a) or any(point_in_ring(p, a) for p in b):
        return 0.0
    best = float("inf")
    for i in range(len(a)):
        p0, p1 = a[i], a[(i + 1) % len(a)]
        for j in range(len(b)):
            q0, q1 = b[j], b[(j + 1) % len(b)]
            best = min(best, _seg_seg(p0, p1, q0, q1))
    return best


def _seg_seg(p0: Sequence[float], p1: Sequence[float],
             q0: Sequence[float], q1: Sequence[float]) -> float:
    def point_seg(p: Sequence[float], a: Sequence[float], b: Sequence[float]) -> float:
        ax, ay = float(a[0]), float(a[1])
        bx, by = float(b[0]), float(b[1])
        px, py = float(p[0]), float(p[1])
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        t = 0.0 if den < 1e-12 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / den))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    return min(point_seg(p0, q0, q1), point_seg(p1, q0, q1),
               point_seg(q0, p0, p1), point_seg(q1, p0, p1))


def aabb_overlap_xz(a_min: Sequence[float], a_max: Sequence[float],
                    b_min: Sequence[float], b_max: Sequence[float]) -> float:
    """Fraction of the smaller footprint that overlaps the larger."""
    ix = max(0.0, min(a_max[0], b_max[0]) - max(a_min[0], b_min[0]))
    iz = max(0.0, min(a_max[2], b_max[2]) - max(a_min[2], b_min[2]))
    inter = ix * iz
    aa = max(1e-9, (a_max[0] - a_min[0]) * (a_max[2] - a_min[2]))
    bb = max(1e-9, (b_max[0] - b_min[0]) * (b_max[2] - b_min[2]))
    return inter / min(aa, bb)


def build_relationships(rooms: Sequence[dict[str, Any]],
                        openings: Sequence[dict[str, Any]],
                        entities: Sequence[dict[str, Any]],
                        surfaces: Sequence[dict[str, Any]]) -> list[Rel]:
    rels: list[Rel] = []

    def add(st: str, si: str, p: str, ot: str, oi: str, v: float | None,
            prov: str, conf: float) -> None:
        rels.append(Rel(st, si, p, ot, oi, v, prov, conf))

    by_id = {r["id"]: r for r in rooms}

    for i in range(len(rooms)):
        for j in range(i + 1, len(rooms)):
            a, b = rooms[i], rooms[j]
            if abs(a["floor_z"] - b["floor_z"]) > 0.6:
                # Different storeys: an above/below relation, which is what a
                # buyer means by "the bedroom over the kitchen".
                if aabb_overlap_xz(
                        [min(p[0] for p in a["polygon"]), 0, min(p[1] for p in a["polygon"])],
                        [max(p[0] for p in a["polygon"]), 0, max(p[1] for p in a["polygon"])],
                        [min(p[0] for p in b["polygon"]), 0, min(p[1] for p in b["polygon"])],
                        [max(p[0] for p in b["polygon"]), 0, max(p[1] for p in b["polygon"])]) > 0.2:
                    hi, lo = (a, b) if a["floor_z"] > b["floor_z"] else (b, a)
                    add("room", hi["id"], "above", "room", lo["id"],
                        abs(a["floor_z"] - b["floor_z"]), "reconstructed", 0.8)
                    add("room", lo["id"], "below", "room", hi["id"],
                        abs(a["floor_z"] - b["floor_z"]), "reconstructed", 0.8)
                continue
            d = ring_distance(a["polygon"], b["polygon"])
            if d <= ADJACENT_M:
                conf = float(np.clip(0.9 - d / ADJACENT_M * 0.3, 0.55, 0.9))
                add("room", a["id"], "adjacent_to", "room", b["id"], d, "reconstructed", conf)
                add("room", b["id"], "adjacent_to", "room", a["id"], d, "reconstructed", conf)

    for o in openings:
        ra, rb = o.get("room_a"), o.get("room_b")
        if ra and rb:
            c = float(o.get("confidence", 0.6))
            add("room", ra, "connected_to", "room", rb, float(o.get("width_m", 0.0)),
                "reconstructed", c)
            add("room", rb, "connected_to", "room", ra, float(o.get("width_m", 0.0)),
                "reconstructed", c)
            add("opening", o["id"], "opens_into", "room", ra, None, "reconstructed", c)
            add("opening", o["id"], "opens_into", "room", rb, None, "reconstructed", c)
        if o.get("surface_id"):
            add("opening", o["id"], "attached_to", "surface", o["surface_id"], None,
                "reconstructed", float(o.get("confidence", 0.6)))

    for s in surfaces:
        if s.get("room_id"):
            add("surface", s["id"], "inside", "room", s["room_id"], None,
                "reconstructed", float(s.get("confidence", 0.7)))

    for e in entities:
        if e.get("room_id"):
            c = float(e.get("confidence", 0.5))
            add("entity", e["id"], "inside", "room", e["room_id"], None, "inferred", c)
            add("room", e["room_id"], "contains", "entity", e["id"], None, "inferred", c)

    for i in range(len(entities)):
        for j in range(i + 1, len(entities)):
            a, b = entities[i], entities[j]
            ca = np.asarray(a["centroid"], dtype=np.float64)
            cb = np.asarray(b["centroid"], dtype=np.float64)
            d = float(np.linalg.norm(ca - cb))
            conf = min(float(a.get("confidence", 0.5)), float(b.get("confidence", 0.5)))
            if d <= NEAR_M:
                add("entity", a["id"], "near", "entity", b["id"], d, "inferred", conf)
                add("entity", b["id"], "near", "entity", a["id"], d, "inferred", conf)
            amin, amax = a["aabb_min"], a["aabb_max"]
            bmin, bmax = b["aabb_min"], b["aabb_max"]
            ov = aabb_overlap_xz(amin, amax, bmin, bmax)
            if ov >= ON_OVERLAP:
                if 0 <= amin[1] - bmax[1] <= ON_GAP_M:
                    add("entity", a["id"], "located_on", "entity", b["id"], ov, "inferred", conf)
                    add("entity", b["id"], "supports", "entity", a["id"], ov, "inferred", conf)
                elif 0 <= bmin[1] - amax[1] <= ON_GAP_M:
                    add("entity", b["id"], "located_on", "entity", a["id"], ov, "inferred", conf)
                    add("entity", a["id"], "supports", "entity", b["id"], ov, "inferred", conf)
    return rels


# ---------------------------------------------------------------------------
# Navigation
# ---------------------------------------------------------------------------

def build_nav(rooms: Sequence[dict[str, Any]], openings: Sequence[dict[str, Any]],
              entities: Sequence[dict[str, Any]], cameras: Sequence[dict[str, Any]],
              *, grid: float = NAV_GRID_M) -> tuple[list[NavN], list[NavE]]:
    """Grid of walkable nodes per room, plus door and stair edges between them.

    Clearance is computed against entity footprints: a node inside a sofa's
    XZ box is not walkable, and a node near one has its clearance reduced. The
    viewer's camera refuses to enter a node whose clearance is under its own
    radius, which is how a tour stops walking through furniture.
    """
    nodes: list[NavN] = []
    node_idx: dict[str, int] = {}
    per_room: dict[str, list[int]] = {}

    boxes = [(e["aabb_min"], e["aabb_max"]) for e in entities]

    for r in rooms:
        ring = r["polygon"]
        xs = [p[0] for p in ring]
        zs = [p[1] for p in ring]
        room_nodes: list[int] = []
        gx = np.arange(min(xs), max(xs) + grid, grid)
        gz = np.arange(min(zs), max(zs) + grid, grid)
        for x in gx:
            for z in gz:
                if not point_in_ring((x, z), ring):
                    continue
                clear = _clearance((float(x), float(z)), ring, boxes, r["floor_z"])
                if clear < MIN_CLEARANCE_M:
                    continue
                nid = f"nav_{len(nodes):05d}"
                node_idx[nid] = len(nodes)
                room_nodes.append(len(nodes))
                nodes.append(NavN(id=nid, room_id=r["id"],
                                  position=[float(x), float(r["floor_z"]) + 1.55, float(z)],
                                  clearance=float(clear), is_entrance=False,
                                  is_viewpoint=False))
        per_room[r["id"]] = room_nodes

    edges: list[NavE] = []
    pos = np.asarray([[n.position[0], n.position[2]] for n in nodes]) if nodes else np.zeros((0, 2))
    for ids in per_room.values():
        for a in ids:
            for b in ids:
                if b <= a:
                    continue
                d = float(np.linalg.norm(pos[a] - pos[b]))
                if d <= NAV_LINK_M:
                    edges.append(NavE(nodes[a].id, nodes[b].id, d, None, "walk", None))

    for o in openings:
        ra, rb = o.get("room_a"), o.get("room_b")
        if not (ra and rb):
            continue
        c = np.array([o["centre"][0], o["centre"][2]])
        na = _nearest(per_room.get(ra, []), pos, c)
        nb = _nearest(per_room.get(rb, []), pos, c)
        if na is None or nb is None:
            continue
        d = float(np.linalg.norm(pos[na] - pos[nb]))
        kind = "stair" if o.get("kind") == "stair" else "door"
        edges.append(NavE(nodes[na].id, nodes[nb].id, d,
                          float(o.get("width_m", 0.8)), kind, o["id"]))

    # Viewpoints: the node in each room with the most free space, which is
    # where a tour should stand to show the room.
    for rid, ids in per_room.items():
        if not ids:
            continue
        best = max(ids, key=lambda i: nodes[i].clearance)
        nodes[best] = replace(nodes[best], is_viewpoint=True)

    # Entrance: the node nearest the first camera in the capture, which is
    # where the person filming started, which is the front door often enough
    # to be the right default and is recorded as a guess, not a fact.
    if cameras and nodes:
        start = np.array([cameras[0]["position"][0], cameras[0]["position"][2]])
        i = int(np.argmin(np.linalg.norm(pos - start, axis=1)))
        nodes[i] = replace(nodes[i], is_entrance=True)

    return nodes, edges


def _clearance(pt: tuple[float, float], ring: Sequence[Sequence[float]],
               boxes: Sequence[tuple[Sequence[float], Sequence[float]]],
               floor_y: float) -> float:
    best = float("inf")
    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        best = min(best, _seg_seg(pt, pt, a, b))
    for mn, mx in boxes:
        # Only furniture that occupies the walking band blocks a node; a
        # ceiling light does not.
        if mx[1] < floor_y + 0.15 or mn[1] > floor_y + 1.8:
            continue
        dx = max(mn[0] - pt[0], 0.0, pt[0] - mx[0])
        dz = max(mn[2] - pt[1], 0.0, pt[1] - mx[2])
        best = min(best, math.hypot(dx, dz))
    return float(best)


def _nearest(ids: Sequence[int], pos: np.ndarray, target: np.ndarray) -> int | None:
    if not len(ids):
        return None
    d = np.linalg.norm(pos[list(ids)] - target, axis=1)
    return int(ids[int(np.argmin(d))])


def reachability(rooms: Sequence[dict[str, Any]], nodes: Sequence[NavN],
                 edges: Sequence[NavE]) -> tuple[list[str], list[str]]:
    """Rooms reachable from the entrance by walking. Rooms with no nav node at
    all count as unreachable, which is the right answer: a room the camera
    cannot enter is a room the tour cannot show."""
    if not nodes:
        return [], [r["id"] for r in rooms]
    adj: dict[str, list[str]] = {n.id: [] for n in nodes}
    for e in edges:
        adj.setdefault(e.a, []).append(e.b)
        adj.setdefault(e.b, []).append(e.a)
    start = next((n.id for n in nodes if n.is_entrance), nodes[0].id)
    seen = {start}
    q = deque([start])
    while q:
        cur = q.popleft()
        for nxt in adj.get(cur, ()):
            if nxt not in seen:
                seen.add(nxt)
                q.append(nxt)
    room_of = {n.id: n.room_id for n in nodes}
    reached = {room_of[i] for i in seen if room_of.get(i)}
    all_ids = [r["id"] for r in rooms]
    return ([r for r in all_ids if r in reached],
            [r for r in all_ids if r not in reached])


def run(inp: Input, ctx: RunContext) -> Output:
    rels = build_relationships(inp.rooms, inp.openings, inp.entities, inp.surfaces)
    nodes, edges = build_nav(inp.rooms, inp.openings, inp.entities, inp.cameras)
    reached, unreached = reachability(inp.rooms, nodes, edges)
    continuity = len(reached) / float(max(1, len(inp.rooms)))

    warnings: list[str] = []
    if unreached:
        warnings.append(f"{len(unreached)} room(s) unreachable from the entrance: "
                        f"{unreached[:5]}. Either a doorway was missed or the "
                        "capture never walked between them.")

    path = ctx.out("graph.json")
    path.write_text(json.dumps(
        {"relationships": [asdict(r) for r in rels],
         "navNodes": [asdict(n) for n in nodes],
         "navEdges": [asdict(e) for e in edges]}, indent=1, default=float))

    out = Output(relationships=rels, nav_nodes=nodes, nav_edges=edges,
                 graph_path=str(path), reachable_rooms=reached,
                 unreachable_rooms=unreached, navigation_continuity=float(continuity),
                 warnings=warnings)
    log(LOG, logging.INFO, "graph.ok", relationships=len(rels), nav_nodes=len(nodes),
        nav_edges=len(edges), continuity=round(continuity, 3))
    return out
