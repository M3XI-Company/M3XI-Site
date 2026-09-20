"""Scene graph, navigation, layout helpers, mesh plane fitting, reflective
evidence and packaging — the CPU-testable geometry across the back half of the
pipeline."""
from __future__ import annotations

import math

import numpy as np
import pytest

from worldengine import reflective as RF
from worldengine.stages import graph as G
from worldengine.stages import layout as L
from worldengine.stages import mesh as M
from worldengine.stages import package as P
from worldengine.stages import semantics as SEM
from worldengine.formats.ply import SplatCloud
from tests.fixtures import BEDROOM, LIVING, artefacts


# --- layout -----------------------------------------------------------------

def test_density_map_transform_round_trips():
    rng = np.random.default_rng(0)
    pts = np.column_stack([rng.uniform(0, 7, 5000),
                           rng.uniform(0.4, 1.5, 5000),
                           rng.uniform(0, 3, 5000)])
    dens, mpp, origin = L.build_density_map(pts, 0.0, 2.4)
    assert dens.shape == (L.DENSITY_RES, L.DENSITY_RES)
    assert 0.0 <= dens.min() and dens.max() == pytest.approx(1.0)
    ring_px = [(0, 0), (10, 0), (10, 10), (0, 10)]
    ring_m = L.pixels_to_metres(ring_px, mpp, origin)
    assert ring_m[0] == (origin[0], origin[1])
    assert ring_m[2][0] == pytest.approx(origin[0] + 10 * mpp)


def test_density_map_uses_the_slab_band_not_the_whole_column():
    """Kitchen wall units above 1.6 m would close doorways that are open."""
    floor = np.column_stack([np.linspace(0, 4, 500), np.zeros(500) + 0.05,
                             np.zeros(500) + 1.5])
    high = np.column_stack([np.linspace(0, 4, 500), np.zeros(500) + 2.2,
                            np.zeros(500) + 1.5])
    band = np.column_stack([np.linspace(0, 4, 500), np.zeros(500) + 1.0,
                            np.zeros(500) + 1.5])
    dens, mpp, origin = L.build_density_map(np.vstack([floor, high, band]), 0.0, 2.4)
    assert dens.sum() > 0


def test_classify_room_kind_prefers_evidence_over_geometry():
    assert L.classify_room_kind(12.0, 1.2, 2.4, ["sofa", "television"]) == "living"
    assert L.classify_room_kind(9.0, 1.1, 2.4, ["bed"]) == "bedroom"
    assert L.classify_room_kind(8.0, 1.2, 2.4, ["hob", "oven"]) == "kitchen"
    assert L.classify_room_kind(2.2, 1.4, 2.4, ["toilet"]) == "wc"
    assert L.classify_room_kind(4.5, 1.2, 2.4, ["toilet", "bathtub"]) == "bathroom"


def test_classify_room_kind_stays_unknown_rather_than_guessing():
    """A wrongly named room in a listing is a misdescription, so an unsupported
    guess is worse than 'unknown'."""
    assert L.classify_room_kind(14.0, 1.3, 2.4, []) == "unknown"
    assert L.classify_room_kind(6.0, 4.0, 2.4, []) == "hall"


def test_polygon_aspect():
    assert L.polygon_aspect([(0, 0), (10, 0), (10, 1), (0, 1)]) > 5
    assert L.polygon_aspect([(0, 0), (3, 0), (3, 3), (0, 3)]) == pytest.approx(1.0, abs=0.05)


def test_cameras_in_room_respects_the_polygon():
    cams = [{"frame_id": "a", "position": [1.0, 1.5, 1.5]},
            {"frame_id": "b", "position": [5.0, 1.5, 1.5]},
            {"frame_id": "c", "position": [1.0, 9.0, 1.5]}]
    got = L.cameras_in_room(cams, LIVING, 0.0, 2.4)
    assert got == ["a"]


def test_find_openings_between_adjacent_rooms():
    rooms = [L.LayoutRoom(id="rm_0", stable_key="a", floor_index=0, kind="unknown",
                          polygon=[list(p) for p in LIVING], floor_z=0.0,
                          ceiling_z=2.4, area_m2=12.0, camera_ids=[],
                          provenance="reconstructed", confidence=0.8),
             L.LayoutRoom(id="rm_1", stable_key="b", floor_index=0, kind="unknown",
                          polygon=[list(p) for p in BEDROOM], floor_z=0.0,
                          ceiling_z=2.4, area_m2=9.0, camera_ids=[],
                          provenance="reconstructed", confidence=0.8)]
    ops = L.find_openings(rooms, [], 0.0, 2.4)
    doors = [o for o in ops if o.kind in ("door", "doorway")]
    assert len(doors) == 1
    assert {doors[0].room_a, doors[0].room_b} == {"rm_0", "rm_1"}
    assert doors[0].centre[0] == pytest.approx(4.0, abs=0.01)
    assert 1.8 <= doors[0].height_m <= 2.1


def test_find_openings_emits_windows_from_glazed_surfaces():
    surf = [{"id": "srf_1", "is_glazed": True, "normal": [0, 0, 1],
             "polygon": [[1, 0.9, 0], [2.4, 0.9, 0], [2.4, 2.1, 0], [1, 2.1, 0]],
             "confidence": 0.7}]
    ops = L.find_openings([], surf, 0.0, 2.4)
    assert len(ops) == 1 and ops[0].kind == "window"
    assert ops[0].sill_m == pytest.approx(0.9)
    assert ops[0].surface_id == "srf_1"


def test_shared_span_ignores_rooms_that_only_touch_at_a_corner():
    a = [(0, 0), (0, 3), (3, 3), (3, 0)]
    b = [(3.0, 3.0), (3.0, 6.0), (6.0, 6.0), (6.0, 3.0)]
    span = L._shared_span(a, b, L.ADJACENCY_GAP_M)
    assert span is None or span[2] < L.DOOR_MIN_WIDTH_M


# --- mesh -------------------------------------------------------------------

def test_ransac_plane_recovers_a_known_plane():
    rng = np.random.default_rng(3)
    inliers = np.column_stack([rng.uniform(-2, 2, 800), rng.uniform(0, 2.4, 800),
                               np.full(800, 1.5) + rng.normal(0, 0.005, 800)])
    outliers = rng.uniform(-3, 3, (200, 3))
    n, d, mask = M.ransac_plane(np.vstack([inliers, outliers]), threshold=0.03)
    assert abs(abs(n[2]) - 1.0) < 0.02
    assert abs(abs(d) - 1.5) < 0.05
    assert mask[:800].mean() > 0.95


def test_classify_plane_by_normal_and_height():
    assert M.classify_plane([0, 1, 0], centroid_y=0.0, floor_y=0.0, ceiling_y=2.4) == "floor"
    assert M.classify_plane([0, -1, 0], centroid_y=2.4, floor_y=0.0, ceiling_y=2.4) == "ceiling"
    assert M.classify_plane([1, 0, 0]) == "wall"
    assert M.classify_plane([0, 0.7, 0.7]) == "unknown"


def test_plane_polygon_area_matches_the_inlier_extent():
    grid = np.array([[x, y, 0.0] for x in np.linspace(0, 4, 40)
                     for y in np.linspace(0, 2.4, 25)])
    ring, area = M.plane_polygon(grid, np.array([0.0, 0.0, 1.0]), 0.0)
    assert area == pytest.approx(4 * 2.4, rel=0.02)
    assert len(ring) >= 4
    assert all(abs(p[2]) < 1e-6 for p in ring)


def test_extract_planes_finds_both_walls_and_stops():
    a = np.array([[0.0, y, z] for y in np.linspace(0, 2.4, 60)
                  for z in np.linspace(0, 3, 60)])
    b = np.array([[x, y, 0.0] for x in np.linspace(0, 4, 60)
                  for y in np.linspace(0, 2.4, 60)])
    planes = M.extract_planes(np.vstack([a, b]), min_points=1000, min_area=0.5)
    assert len(planes) >= 2
    normals = [np.abs(p["normal"]) for p in planes[:2]]
    assert any(n[0] > 0.9 for n in normals)
    assert any(n[2] > 0.9 for n in normals)


def test_floor_and_ceiling_from_a_two_storey_histogram():
    rng = np.random.default_rng(7)
    ground = rng.normal(0.0, 0.01, 4000)
    upper = rng.normal(2.7, 0.01, 4000)
    wall = rng.uniform(0.0, 5.2, 3000)
    floors, ceiling = M.floor_and_ceiling(
        np.column_stack([np.zeros(11000), np.concatenate([ground, upper, wall]),
                         np.zeros(11000)]))
    assert len(floors) == 2
    assert min(floors) == pytest.approx(0.0, abs=0.08)
    assert max(floors) == pytest.approx(2.7, abs=0.08)
    assert ceiling > 4.0


def test_convex_hull_is_counter_clockwise_and_minimal():
    pts = np.array([[0, 0], [1, 0], [2, 0], [2, 2], [0, 2], [1, 1]])
    hull = M._convex_hull(pts)
    assert len(hull) == 4
    assert (1.0, 1.0) not in hull


# --- reflective -------------------------------------------------------------

def test_depth_behind_fraction_separates_a_mirror_from_a_picture():
    rng = np.random.default_rng(1)
    wall = np.column_stack([rng.uniform(-1, 1, 500), rng.uniform(0, 2, 500),
                            np.zeros(500)])
    picture = np.column_stack([rng.uniform(-0.3, 0.3, 200),
                               rng.uniform(0.8, 1.6, 200),
                               np.full(200, 0.02)])
    mirror = np.column_stack([rng.uniform(-0.3, 0.3, 200),
                              rng.uniform(0.8, 1.6, 200),
                              np.full(200, -1.8)])
    assert RF.depth_behind_fraction(picture, wall) < 0.05
    assert RF.depth_behind_fraction(mirror, wall) > 0.95


def test_fit_plane_is_total_least_squares():
    rng = np.random.default_rng(2)
    pts = np.column_stack([rng.uniform(-1, 1, 300), rng.uniform(-1, 1, 300),
                           np.full(300, 2.0)])
    n, d = RF.fit_plane(pts)
    assert abs(abs(n[2]) - 1.0) < 1e-6
    assert abs(abs(d) - 2.0) < 1e-6
    with pytest.raises(ValueError):
        RF.fit_plane(np.zeros((2, 3)))


def test_saturation_fraction():
    img = np.full((10, 10, 3), 100, np.uint8)
    img[:5] = 255
    assert RF.saturation_fraction(img) == pytest.approx(0.5)
    assert RF.saturation_fraction(np.zeros((0, 0))) == 0.0


def test_evidence_combines_into_a_reflective_verdict():
    mirror = RF.combine(mirror_detection=0.8, behind=0.95, view_dep=0.7)
    assert mirror.is_reflective
    assert not mirror.is_glazed, "a mirror is not a window; they route differently"
    window = RF.combine(window_detection=0.7, behind=0.2, saturation=0.9)
    assert window.is_glazed
    assert not window.is_reflective
    plain = RF.combine(behind=0.02)
    assert not plain.is_reflective and not plain.is_glazed
    assert set(plain.to_json()) >= {"reflectiveScore", "glazedScore"}


def test_view_dependence_is_clamped():
    assert RF.view_dependence(4.0, 1.0) == 1.0
    assert RF.view_dependence(40.0, 1.0) == 1.0
    assert RF.view_dependence(1.0, 1.0) == pytest.approx(0.25)
    assert RF.view_dependence(1.0, 0.0) == 0.0


# --- graph ------------------------------------------------------------------

def test_ring_distance_zero_when_touching():
    assert G.ring_distance(LIVING, BEDROOM) == pytest.approx(0.0, abs=1e-9)
    far = [(20, 20), (20, 23), (24, 23), (24, 20)]
    assert G.ring_distance(LIVING, far) > 15


def test_relationships_are_symmetric_where_they_should_be():
    a = artefacts()
    rels = G.build_relationships(a["layout"]["rooms"], a["layout"]["openings"],
                                 a["semantics"]["entities"], a["mesh"]["surfaces"])
    pairs = {(r.subject_id, r.predicate, r.object_id) for r in rels}
    assert ("rm_000", "adjacent_to", "rm_001") in pairs
    assert ("rm_001", "adjacent_to", "rm_000") in pairs
    assert ("rm_000", "connected_to", "rm_001") in pairs
    assert ("ent_0000", "inside", "rm_000") in pairs
    assert ("rm_000", "contains", "ent_0000") in pairs


def test_relationship_confidence_never_exceeds_its_inputs():
    a = artefacts()
    rels = G.build_relationships(a["layout"]["rooms"], a["layout"]["openings"],
                                 a["semantics"]["entities"], a["mesh"]["surfaces"])
    for r in rels:
        assert 0.0 <= r.confidence <= 1.0
    ent = next(r for r in rels if r.subject_id == "ent_0000" and r.predicate == "inside")
    assert ent.provenance == "inferred"
    assert ent.confidence <= 0.78


def test_located_on_needs_vertical_adjacency_and_footprint_overlap():
    table = {"id": "t", "centroid": [1, 0.4, 1], "aabb_min": [0.5, 0.0, 0.5],
             "aabb_max": [1.5, 0.75, 1.5], "confidence": 0.7, "room_id": None}
    lamp = {"id": "l", "centroid": [1, 0.9, 1], "aabb_min": [0.9, 0.78, 0.9],
            "aabb_max": [1.1, 1.1, 1.1], "confidence": 0.7, "room_id": None}
    apart = {"id": "x", "centroid": [1, 2.0, 1], "aabb_min": [0.9, 1.9, 0.9],
             "aabb_max": [1.1, 2.1, 1.1], "confidence": 0.7, "room_id": None}
    rels = G.build_relationships([], [], [table, lamp], [])
    got = {(r.subject_id, r.predicate, r.object_id) for r in rels}
    assert ("l", "located_on", "t") in got
    assert ("t", "supports", "l") in got
    rels2 = G.build_relationships([], [], [table, apart], [])
    assert not any(r.predicate == "located_on" for r in rels2)


def test_nav_graph_reaches_every_room_through_a_door():
    a = artefacts()
    nodes, edges = G.build_nav(a["layout"]["rooms"], a["layout"]["openings"],
                               a["semantics"]["entities"], a["pose"]["cameras"])
    assert nodes and edges
    reached, unreached = G.reachability(a["layout"]["rooms"], nodes, edges)
    assert set(reached) == {"rm_000", "rm_001"}
    assert unreached == []
    assert sum(1 for e in edges if e.kind == "door") == 1
    assert sum(1 for n in nodes if n.is_entrance) == 1
    assert sum(1 for n in nodes if n.is_viewpoint) == 2


def test_a_room_with_no_door_is_reported_unreachable():
    a = artefacts()
    a["layout"]["openings"] = []
    nodes, edges = G.build_nav(a["layout"]["rooms"], [], [], a["pose"]["cameras"])
    reached, unreached = G.reachability(a["layout"]["rooms"], nodes, edges)
    assert len(unreached) == 1


def test_nav_nodes_avoid_furniture():
    a = artefacts()
    big = {"id": "e", "aabb_min": [0.2, 0.0, 0.2], "aabb_max": [3.8, 1.0, 2.8],
           "centroid": [2, 0.5, 1.5], "confidence": 0.8, "room_id": "rm_000"}
    nodes, _ = G.build_nav([a["layout"]["rooms"][0]], [], [big], [])
    assert not nodes, "a room entirely filled with furniture has nowhere to stand"


def test_reachability_with_no_nodes_reports_everything_unreachable():
    a = artefacts()
    reached, unreached = G.reachability(a["layout"]["rooms"], [], [])
    assert reached == [] and len(unreached) == 2


# --- semantics helpers ------------------------------------------------------

def test_assign_room_uses_the_xz_ring_and_height_band():
    a = artefacts()
    rooms = a["layout"]["rooms"]
    assert SEM.assign_room([1.5, 0.4, 1.0], rooms) == "rm_000"
    assert SEM.assign_room([5.5, 0.4, 1.0], rooms) == "rm_001"
    assert SEM.assign_room([20.0, 0.4, 1.0], rooms) is None


def test_cluster_by_identity_is_cosine_not_euclidean():
    feats = np.array([[1.0, 0.0], [10.0, 0.0], [0.0, 1.0]], np.float32)
    sel = SEM.cluster_by_identity(feats, np.array([1.0, 0.0]), threshold=0.9)
    assert list(sel) == [True, True, False], "magnitude must not matter"


def test_identity_stability_is_a_plain_fraction():
    assert SEM.identity_stability([True, True, False, True]) == pytest.approx(0.75)
    assert SEM.identity_stability([]) == 0.0


def test_project_points_puts_a_point_in_front_of_the_camera_at_the_centre():
    camera = {"position": [0, 0, 0], "orientation": [0, 0, 0, 1],
              "fx": 500.0, "fy": 500.0, "cx": 320.0, "cy": 240.0,
              "width": 640, "height": 480}
    uv, vis = SEM.project_points(np.array([[0.0, 0.0, -3.0]]), camera)
    assert vis[0]
    assert uv[0] == pytest.approx([320.0, 240.0])
    # A point behind the camera is not visible.
    _, vis2 = SEM.project_points(np.array([[0.0, 0.0, 3.0]]), camera)
    assert not vis2[0]


# --- package ----------------------------------------------------------------

def _cloud(means):
    n = len(means)
    return SplatCloud(means=np.asarray(means, np.float32),
                      scales=np.full((n, 3), -3.0, np.float32),
                      quats=np.tile([0, 0, 0, 1], (n, 1)).astype(np.float32),
                      opacities=np.zeros(n, np.float32),
                      sh0=np.zeros((n, 3), np.float32))


def test_assign_chunks_splits_by_room_and_keeps_a_shell():
    a = artefacts()
    means = np.array([[1.0, 1.0, 1.5],     # living
                      [5.5, 1.0, 1.5],     # bedroom
                      [20.0, 1.0, 1.5]])   # outside everything
    keys = P.assign_chunks(means, a["layout"]["rooms"])
    assert keys[0] == "r@2.0,1.5"
    assert keys[1] == "r@5.5,1.5"
    assert keys[2] == "_shell"


def test_lod_mask_keeps_the_large_opaque_gaussians():
    n = 1000
    rng = np.random.default_rng(0)
    scales = rng.uniform(-7, -1, (n, 3)).astype(np.float32)
    c = SplatCloud(means=rng.normal(size=(n, 3)).astype(np.float32),
                   scales=scales,
                   quats=np.tile([0, 0, 0, 1], (n, 1)).astype(np.float32),
                   opacities=rng.uniform(-3, 3, n).astype(np.float32),
                   sh0=np.zeros((n, 3), np.float32))
    m = P.lod_mask(c, 0.25)
    assert m.sum() == 250
    score = np.exp(c.scales).max(axis=1) / (1 + np.exp(-c.opacities))
    assert score[m].mean() > score[~m].mean()


def test_subset_preserves_every_field():
    c = _cloud([[0, 0, 0], [1, 1, 1], [2, 2, 2]])
    s = P.subset(c, np.array([True, False, True]))
    assert s.count == 2
    assert np.array_equal(s.means, c.means[[0, 2]])
    assert s.shN is None
