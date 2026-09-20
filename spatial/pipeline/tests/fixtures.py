"""A small, complete, internally consistent set of stage artefacts.

Deliberately hand-built rather than captured from a real run: every number here
is one a human chose, so a test that fails points at a rule rather than at
whatever the GPU happened to produce that day.

Geometry: a two-room flat. Living room 4 x 3 m at the origin, bedroom 3 x 3 m
to its +X side, a 0.9 m doorway between them, 2.4 m ceilings.
"""
from __future__ import annotations

import math
from typing import Any

from worldengine.geometry import ensure_ccw_from_above

LIVING = ensure_ccw_from_above([(0.0, 0.0), (4.0, 0.0), (4.0, 3.0), (0.0, 3.0)])
BEDROOM = ensure_ccw_from_above([(4.0, 0.0), (7.0, 0.0), (7.0, 3.0), (4.0, 3.0)])


def camera(i: int, x: float, z: float) -> dict[str, Any]:
    return {"frame_id": f"f{i:07d}", "path": f"/tmp/frames/f{i:07d}.jpg",
            "source_index": i, "t_ms": i * 400,
            "position": [x, 1.55, z], "orientation": [0.0, 0.0, 0.0, 1.0],
            "fx": 900.0, "fy": 900.0, "cx": 800.0, "cy": 450.0,
            "width": 1600, "height": 900, "pose_confidence": 0.82,
            "sharpness": 180.0, "registered": True, "drift_m": 0.02,
            "drift_rad": 0.01}


def artefacts(**overrides: Any) -> dict[str, Any]:
    cams = [camera(i, 0.5 + 0.3 * i, 1.5) for i in range(8)] + \
           [camera(8 + i, 4.5 + 0.3 * i, 1.5) for i in range(8)]
    selected = [{"frame_id": c["frame_id"], "path": c["path"],
                 "source_index": c["source_index"], "t_ms": c["t_ms"],
                 "sharpness": c["sharpness"], "sharpness_norm": 0.05,
                 "width": c["width"], "height": c["height"]} for c in cams]
    redacted = [{**f, "redaction_count": 0} for f in selected]
    base: dict[str, Any] = {
        "frames": {"frames": selected, "blur_rejection_fraction": 0.06,
                   "selected_count": len(selected), "candidate_count": 900,
                   "rejected_blur_count": 54, "rejected_motion_count": 9,
                   "rejected_redundant_count": 500, "median_sharpness": 180.0,
                   "median_displacement_frac": 0.3,
                   "scores_path": "/tmp/scores.json"},
        "redact": {"frames": redacted, "completeness": 1.0,
                   "detection_count": 12, "applied_count": 12,
                   "frames_with_redactions": 4,
                   "detections_path": "/tmp/redactions.json",
                   "inpainter": "telea",
                   "detectors": {"face": "yunet-2023mar",
                                 "openVocab": "owlv2-base-patch16-ensemble",
                                 "text": "doctr-db_resnet50",
                                 "maskRefinement": "sam3.1"},
                   "counts_by_kind": {"face": 2, "document": 3, "screen": 7}},
        "pose": {"cameras": cams, "registered_fraction": 1.0,
                 "mean_reprojection_error_px": 0.9,
                 "point_cloud_path": "/tmp/points.npz", "depth_dir": "/tmp/depth",
                 "mapanything_scale_factor": 1.0, "scale_is_metric": True},
        "scale": {"source": "mapanything+moge2:agreed", "agreement": 0.95,
                  "scale_factor": 1.012, "relative_disagreement": 0.012,
                  "spread": 0.02, "provenance": "inferred", "confidence": 0.9,
                  "needs_review": False, "frames_used": 60},
        "splat": {"ply_path": "/tmp/splat.ply", "identity_path": "/tmp/id.npy",
                  "gaussian_count": 800_000, "final_psnr": 31.2, "sh_degree": 3,
                  "aabb_min": [-0.5, -0.1, -0.5], "aabb_max": [7.5, 2.6, 3.5]},
        "mesh": {"mesh_path": "/tmp/mesh.ply", "fused_cloud_path": "/tmp/fused.npz",
                 "floor_elevations": [0.0], "ceiling_elevation": 2.4,
                 "vertex_count": 120_000, "triangle_count": 230_000,
                 "backend": "dn-splatter", "reflective_area_m2": 0.0,
                 "glazed_area_m2": 2.1,
                 "surfaces": [
                     {"id": "srf_000", "kind": "wall",
                      "normal": [1.0, 0.0, 0.0], "d": 0.0,
                      "polygon": [[0, 0, 0], [0, 2.4, 0], [0, 2.4, 3], [0, 0, 3]],
                      "area_m2": 7.2, "point_count": 5000,
                      "is_reflective": False, "is_glazed": False,
                      "evidence": {}, "confidence": 0.88, "room_id": "rm_000"},
                     {"id": "srf_001", "kind": "wall",
                      "normal": [0.0, 0.0, 1.0], "d": 0.0,
                      "polygon": [[1, 0.9, 0], [2.4, 0.9, 0], [2.4, 2.1, 0], [1, 2.1, 0]],
                      "area_m2": 1.68, "point_count": 2200,
                      "is_reflective": False, "is_glazed": True,
                      "evidence": {"saturation": 0.6}, "confidence": 0.7,
                      "room_id": "rm_000"}]},
        "layout": {
            "rooms": [
                {"id": "rm_000", "stable_key": "r@2.0,1.5", "floor_index": 0,
                 "kind": "unknown", "polygon": [list(p) for p in LIVING],
                 "floor_z": 0.0, "ceiling_z": 2.4, "area_m2": 12.0,
                 "camera_ids": [c["frame_id"] for c in cams[:8]],
                 "provenance": "reconstructed", "confidence": 0.85},
                {"id": "rm_001", "stable_key": "r@5.5,1.5", "floor_index": 0,
                 "kind": "unknown", "polygon": [list(p) for p in BEDROOM],
                 "floor_z": 0.0, "ceiling_z": 2.4, "area_m2": 9.0,
                 "camera_ids": [c["frame_id"] for c in cams[8:]],
                 "provenance": "reconstructed", "confidence": 0.85}],
            "openings": [
                {"id": "opn_000", "kind": "door", "room_a": "rm_000",
                 "room_b": "rm_001", "centre": [4.0, 1.02, 1.5],
                 "normal": [0.0, 0.0, 1.0], "width_m": 0.9, "height_m": 2.04,
                 "sill_m": 0.0, "surface_id": None,
                 "provenance": "reconstructed", "confidence": 0.8}],
            "floor_elevations": [0.0], "metres_per_pixel": 0.03,
            "origin_xz": [-0.5, -0.5]},
        "semantics": {
            "entities": [
                {"id": "ent_0000", "stable_key": "sofa@1.5,0.4,1.0",
                 "label": "sofa", "category": "furniture", "room_id": "rm_000",
                 "centroid": [1.5, 0.4, 1.0],
                 "aabb_min": [0.6, 0.0, 0.5], "aabb_max": [2.4, 0.85, 1.5],
                 "observed_in": [c["frame_id"] for c in cams[:5]],
                 "gaussian_count": 9000, "identity_stability": 0.88,
                 "confidence": 0.78, "provenance": "inferred"},
                {"id": "ent_0001", "stable_key": "bed@4.9,0.3,1.2",
                 "label": "bed", "category": "furniture", "room_id": "rm_001",
                 "centroid": [4.9, 0.3, 1.15],
                 "aabb_min": [4.2, 0.0, 0.2], "aabb_max": [5.6, 0.6, 2.1],
                 "observed_in": [c["frame_id"] for c in cams[8:13]],
                 "gaussian_count": 12000, "identity_stability": 0.82,
                 "confidence": 0.74, "provenance": "inferred"}],
            "room_labels": {"rm_000": ["sofa"], "rm_001": ["bed"]},
            "track_count": 2, "mean_identity_stability": 0.85,
            "concepts_used": ["sofa", "bed"]},
        "graph": {
            "relationships": [
                {"subject_type": "room", "subject_id": "rm_000",
                 "predicate": "connected_to", "object_type": "room",
                 "object_id": "rm_001", "value": 0.9,
                 "provenance": "reconstructed", "confidence": 0.8},
                {"subject_type": "entity", "subject_id": "ent_0000",
                 "predicate": "inside", "object_type": "room",
                 "object_id": "rm_000", "value": None,
                 "provenance": "inferred", "confidence": 0.78}],
            "nav_nodes": [
                {"id": "nav_00000", "room_id": "rm_000", "position": [1.5, 1.55, 1.5],
                 "clearance": 1.1, "is_entrance": True, "is_viewpoint": True},
                {"id": "nav_00001", "room_id": "rm_001", "position": [5.5, 1.55, 1.5],
                 "clearance": 1.2, "is_entrance": False, "is_viewpoint": True}],
            "nav_edges": [
                {"a": "nav_00000", "b": "nav_00001", "cost": 4.0, "width": 0.9,
                 "kind": "door", "opening_id": "opn_000"}],
            "reachable_rooms": ["rm_000", "rm_001"], "unreachable_rooms": [],
            "navigation_continuity": 1.0},
        "regions": {
            "regions": [
                {"id": "reg_0000", "provenance": "inferred",
                 "min": [3.4, 0.0, 2.4], "max": [4.0, 2.4, 3.0],
                 "room_id": "rm_000",
                 "reason": "no camera observed this volume", "confidence": 0.9},
                {"id": "reg_obs_0000", "provenance": "observed",
                 "min": [0.0, 0.0, 0.0], "max": [7.0, 2.4, 3.0],
                 "room_id": None, "reason": "observed by at least 2 cameras",
                 "confidence": 0.95}],
            "unobserved_fraction": 0.11, "observed_voxels": 9000,
            "interior_voxels": 10112, "voxel_m": 0.15,
            "per_room_unobserved": {"rm_000": 0.1, "rm_001": 0.12},
            "regions_path": "/tmp/regions.json", "occupancy_path": "/tmp/occ.npz"},
        "package": {
            "assets": [
                {"id": "a0", "role": "splat", "format": "spz",
                 "path": "/tmp/world.spz", "bytes": 24_000_000,
                 "checksum": "a" * 64, "chunk_key": None, "lod": None,
                 "splat_count": 800_000, "meta": {}},
                {"id": "a1", "role": "splat_chunk", "format": "spz",
                 "path": "/tmp/chunks/_shell.spz", "bytes": 300_000,
                 "checksum": "b" * 64, "chunk_key": "_shell", "lod": 0,
                 "splat_count": 8_000, "meta": {}},
                {"id": "a2", "role": "proxy_mesh", "format": "ply",
                 "path": "/tmp/proxy.ply", "bytes": 4_000_000,
                 "checksum": "c" * 64, "chunk_key": None, "lod": None,
                 "splat_count": None, "meta": {}}],
            "manifest_path": "/tmp/manifest.json", "total_bytes": 28_300_000,
            "primary_format": "spz", "sog_available": False, "chunk_count": 3},
        "quality": {
            "checks": [{"name": "scale_agreement", "value": 0.95,
                        "threshold": 0.9, "higherIsBetter": True, "pass": True,
                        "detail": "agreed"}],
            "score": 0.93, "verdict": "pass",
            "created_at": "2026-09-19T12:00:00Z",
            "values": {}, "report_path": "/tmp/quality.json", "blocking": []},
    }
    for k, v in overrides.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            base[k] = {**base[k], **v}
        else:
            base[k] = v
    return base
