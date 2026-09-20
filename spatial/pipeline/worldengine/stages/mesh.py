"""mesh — surface geometry and normals from the trained splat.

DN-Splatter's `gs-mesh o3dtsdf` is the default backend: it renders depth and
normals from the trained gaussians at every training pose and fuses them with
Open3D's TSDF volume. That is the right algorithm for an indoor scene — TSDF
fusion of many consistent depth maps produces watertight walls where Poisson
reconstruction of a splat's point set produces bubbles.

An in-process backend does the same fusion directly from gsplat renders,
without the nerfstudio round-trip. It exists because DN-Splatter expects a
nerfstudio checkpoint and this pipeline trains gsplat directly; converting the
checkpoint is a real operation with real failure modes, so the option to skip
it is worth having. Both backends run the same Open3D TSDF; neither invents
anything if the other is missing, they just fail.

The stage also extracts planar surfaces (walls, floors, ceilings) by RANSAC on
the fused cloud, and runs the mirror/glazing evidence from worldengine
reflective.py over each candidate. Every wall in the world document comes from
here, and every one of them carries a reflective and glazed flag, because a
downstream stage that trusts a mirror produces a phantom room.
"""
from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from ..deps import require_binary, require_cuda, require_module
from ..geometry import world_pose_to_cv_extrinsics
from ..logging_setup import get_logger, log
from ..reflective import ReflectiveEvidence, combine, depth_behind_fraction, fit_plane
from ..runner import RunContext, StageError

LOG = get_logger("worldengine.mesh")

SUMMARY = "TSDF fusion of splat depth+normals (DN-Splatter o3dtsdf); plane extraction"
USES_GPU = True
PRODUCES = ("mesh.ply", "fused.npz", "surfaces.json")

# TSDF voxel size. 2 cm is below the 50 mm wall tolerance the product publishes,
# so the fusion is not the limiting error term, and it keeps a two-bed flat's
# volume under about 1.5 GB of TSDF blocks.
VOXEL_M = 0.02
SDF_TRUNC_M = 0.08              # 4 voxels, Open3D's usual ratio
DEPTH_TRUNC_M = 8.0             # beyond 8 m indoors the render depth is noise

# Plane extraction.
PLANE_INLIER_M = 0.03           # within the wall tolerance
PLANE_MIN_POINTS = 2000
PLANE_MIN_AREA_M2 = 0.6         # smaller than this is a cupboard door, not a wall
MAX_PLANES = 60
# A plane is a wall if its normal is within 20 degrees of horizontal, a floor or
# ceiling if within 20 degrees of vertical. UK interiors are rarely far off
# plumb, and 20 degrees leaves room for sloping ceilings in a loft conversion.
VERTICAL_TOL_RAD = 0.349


@dataclass(slots=True)
class Input:
    ply_path: str
    cameras: list[dict[str, Any]]
    aabb_min: list[float]
    aabb_max: list[float]
    backend: str = "dn-splatter"       # dn-splatter | o3d-tsdf
    voxel_m: float = VOXEL_M


@dataclass(slots=True)
class PlaneSurface:
    id: str
    kind: str                       # wall | floor | ceiling | unknown
    normal: list[float]
    d: float
    polygon: list[list[float]]      # world-space ring
    area_m2: float
    point_count: int
    is_reflective: bool
    is_glazed: bool
    evidence: dict[str, float]
    confidence: float


@dataclass(slots=True)
class Output:
    mesh_path: str
    fused_cloud_path: str
    surfaces: list[PlaneSurface]
    surfaces_path: str
    floor_elevations: list[float]
    ceiling_elevation: float
    vertex_count: int
    triangle_count: int
    backend: str
    reflective_area_m2: float
    glazed_area_m2: float
    warnings: list[str] = field(default_factory=list)


def build_input(ctx: RunContext, upstream: dict[str, Any]) -> Input:
    sp = upstream.get("splat") or {}
    if not sp.get("ply_path"):
        raise StageError("mesh requires the splat stage output")
    pose = ctx.store.load("pose") or {}
    if not pose.get("cameras"):
        raise StageError("mesh requires the pose stage artefact")
    return Input(
        ply_path=str(sp["ply_path"]),
        cameras=list(pose["cameras"]),
        aabb_min=list(sp["aabb_min"]), aabb_max=list(sp["aabb_max"]),
        backend=str(ctx.param("mesh_backend", "dn-splatter")),
        voxel_m=float(ctx.param("mesh_voxel_m", VOXEL_M)),
    )


# ---------------------------------------------------------------------------
# Plane extraction — pure numpy, tested without Open3D
# ---------------------------------------------------------------------------

def ransac_plane(points: np.ndarray, *, threshold: float = PLANE_INLIER_M,
                 iterations: int = 400, rng: np.random.Generator | None = None
                 ) -> tuple[np.ndarray, float, np.ndarray]:
    """Best plane by inlier count. Returns (n, d, inlier_mask)."""
    p = np.asarray(points, dtype=np.float64)
    if len(p) < 3:
        raise ValueError("need at least 3 points")
    g = rng or np.random.default_rng(0)
    best_n = np.array([0.0, 1.0, 0.0])
    best_d = 0.0
    best_mask = np.zeros(len(p), dtype=bool)
    for _ in range(iterations):
        idx = g.choice(len(p), 3, replace=False)
        a, b, c = p[idx]
        n = np.cross(b - a, c - a)
        norm = np.linalg.norm(n)
        if norm < 1e-9:
            continue
        n = n / norm
        d = -float(n @ a)
        mask = np.abs(p @ n + d) < threshold
        if mask.sum() > best_mask.sum():
            best_n, best_d, best_mask = n, d, mask
    if best_mask.sum() >= 3:
        # Refit on all inliers: the three-point hypothesis is only a seed.
        best_n, best_d = fit_plane(p[best_mask])
        best_mask = np.abs(p @ best_n + best_d) < threshold
    return best_n, best_d, best_mask


def classify_plane(normal: Sequence[float], *, tol: float = VERTICAL_TOL_RAD,
                   centroid_y: float = 0.0, floor_y: float = 0.0,
                   ceiling_y: float = 2.4) -> str:
    n = np.asarray(normal, dtype=np.float64)
    n = n / max(np.linalg.norm(n), 1e-12)
    vertical = abs(float(n[1]))            # +Y up, so |n.y| ~ 1 means horizontal surface
    if vertical > np.cos(tol):
        # Horizontal surface: floor or ceiling by which datum it is nearer.
        return "floor" if abs(centroid_y - floor_y) < abs(centroid_y - ceiling_y) else "ceiling"
    if vertical < np.sin(tol):
        return "wall"
    return "unknown"


def plane_polygon(points: np.ndarray, normal: np.ndarray, d: float) -> tuple[list[list[float]], float]:
    """Convex hull of the inliers projected into the plane, lifted back to 3D.

    A convex hull over-claims for an L-shaped wall with a chimney breast. It is
    used because the world contract wants a polygon per surface and a convex
    hull is a defensible over-approximation that cannot leave a hole where a
    wall is; room polygons, which the customer actually measures, come from
    RoomFormer in the layout stage, not from here.
    """
    n = np.asarray(normal, dtype=np.float64)
    n = n / max(np.linalg.norm(n), 1e-12)
    ref = np.array([0.0, 1.0, 0.0]) if abs(n[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(n, ref)
    u /= max(np.linalg.norm(u), 1e-12)
    v = np.cross(n, u)
    origin = -d * n
    rel = np.asarray(points, dtype=np.float64) - origin
    xy = np.stack([rel @ u, rel @ v], axis=1)

    hull = _convex_hull(xy)
    ring3 = [(origin + h[0] * u + h[1] * v).tolist() for h in hull]
    area = 0.0
    for i in range(len(hull)):
        x0, y0 = hull[i]
        x1, y1 = hull[(i + 1) % len(hull)]
        area += x0 * y1 - x1 * y0
    return ring3, abs(area) / 2.0


def _convex_hull(pts: np.ndarray) -> list[tuple[float, float]]:
    """Monotone chain. Returned counter-clockwise in the plane's own 2D basis."""
    p = sorted({(float(a), float(b)) for a, b in np.asarray(pts)})
    if len(p) < 3:
        return p

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for q in p:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], q) <= 0:
            lower.pop()
        lower.append(q)
    upper: list[tuple[float, float]] = []
    for q in reversed(p):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], q) <= 0:
            upper.pop()
        upper.append(q)
    return lower[:-1] + upper[:-1]


def extract_planes(points: np.ndarray, *, max_planes: int = MAX_PLANES,
                   min_points: int = PLANE_MIN_POINTS,
                   min_area: float = PLANE_MIN_AREA_M2,
                   seed: int = 0) -> list[dict[str, Any]]:
    """Sequential RANSAC: find a plane, remove its inliers, repeat."""
    remaining = np.asarray(points, dtype=np.float64)
    rng = np.random.default_rng(seed)
    out: list[dict[str, Any]] = []
    for _ in range(max_planes):
        if len(remaining) < min_points:
            break
        n, d, mask = ransac_plane(remaining, rng=rng)
        if int(mask.sum()) < min_points:
            break
        inliers = remaining[mask]
        ring, area = plane_polygon(inliers, n, d)
        if area >= min_area:
            out.append({"normal": n.tolist(), "d": float(d), "polygon": ring,
                        "area": float(area), "points": inliers,
                        "count": int(mask.sum())})
        remaining = remaining[~mask]
    return out


def floor_and_ceiling(points: np.ndarray) -> tuple[list[float], float]:
    """Floor elevations (one per storey) and the ceiling of the top storey.

    Histogram of Y at 5 cm resolution; a storey's floor is a sharp peak because
    a floor is the one surface every frame in that room sees. Peaks closer than
    1.8 m apart are the same storey (a floor and its ceiling would be ~2.4 m).
    """
    y = np.asarray(points, dtype=np.float64)[:, 1]
    if len(y) == 0:
        return [0.0], 2.4
    lo, hi = float(y.min()), float(y.max())
    bins = max(8, int((hi - lo) / 0.05))
    hist, edges = np.histogram(y, bins=bins, range=(lo, hi))
    centres = 0.5 * (edges[:-1] + edges[1:])
    order = np.argsort(hist)[::-1]
    peaks: list[float] = []
    for i in order:
        c = float(centres[i])
        if hist[i] < 0.15 * hist.max():
            break
        if all(abs(c - p) > 1.8 for p in peaks):
            peaks.append(c)
        if len(peaks) >= 4:
            break
    peaks.sort()
    floors = peaks or [lo]
    # Ceiling of the top storey: the 98th percentile rather than the maximum,
    # which would be a floater or a rooflight reveal.
    ceiling = float(np.percentile(y, 98))
    return floors, ceiling


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------

def fuse_with_dn_splatter(ply_path: Path, out_dir: Path, voxel: float) -> Path:
    exe = require_binary("gs-mesh", why="mesh fuses with DN-Splatter's o3dtsdf")
    dst = out_dir / "mesh.ply"
    p = subprocess.run(
        [exe, "o3dtsdf", "--load-ply", str(ply_path), "--output-dir", str(out_dir),
         "--voxel-size", str(voxel), "--sdf-trunc", str(SDF_TRUNC_M),
         "--depth-trunc", str(DEPTH_TRUNC_M), "--use-normals", "True"],
        capture_output=True, text=True, check=False)
    if p.returncode != 0:
        raise StageError(f"gs-mesh o3dtsdf failed (exit {p.returncode}):\n"
                         f"{p.stderr.strip()[-1200:]}")
    if not dst.exists():
        cands = sorted(out_dir.glob("*.ply"))
        if not cands:
            raise StageError(f"gs-mesh produced no mesh in {out_dir}")
        dst = cands[0]
    return dst


def fuse_in_process(ply_path: Path, cameras: Sequence[dict[str, Any]],
                    out_dir: Path, voxel: float) -> tuple[Path, np.ndarray]:
    """Render depth and colour from the trained splat at every pose and fuse."""
    torch = require_cuda(why="mesh renders depth from the splat", min_vram_gb=16.0)
    gsplat = require_module("gsplat", why="mesh renders depth from the splat")
    o3d = require_module("open3d", why="mesh fuses depth into a TSDF volume")
    from ..formats.ply import read_ply, quat_xyzw_to_wxyz

    cloud = read_ply(ply_path)
    device = "cuda"
    means = torch.from_numpy(cloud.means).to(device)
    quats = torch.from_numpy(quat_xyzw_to_wxyz(cloud.quats)).to(device)
    scales = torch.exp(torch.from_numpy(cloud.scales).to(device))
    opac = torch.sigmoid(torch.from_numpy(cloud.opacities).to(device))
    sh = torch.from_numpy(np.concatenate(
        [cloud.sh0[:, None, :], cloud.shN if cloud.shN is not None
         else np.zeros((cloud.count, 0, 3), np.float32)], axis=1)).to(device)

    volume = o3d.pipelines.integration.ScalableTSDFVolume(
        voxel_length=voxel, sdf_trunc=SDF_TRUNC_M,
        color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8)

    for c in cameras:
        w, h = int(c["width"]), int(c["height"])
        R_cw, t_cw = world_pose_to_cv_extrinsics(c["position"], c["orientation"])
        vm = np.eye(4, dtype=np.float32)
        vm[:3, :3] = R_cw
        vm[:3, 3] = t_cw
        K = torch.tensor([[c["fx"], 0, c["cx"]], [0, c["fy"], c["cy"]], [0, 0, 1]],
                         device=device, dtype=torch.float32)
        with torch.no_grad():
            render, alpha, _ = gsplat.rasterization(
                means=means, quats=quats, scales=scales, opacities=opac,
                colors=sh, viewmats=torch.from_numpy(vm).to(device)[None],
                Ks=K[None], width=w, height=h, sh_degree=cloud.sh_degree,
                render_mode="RGB+ED", packed=True, rasterize_mode="antialiased")
        rgb = (render[0, ..., :3].clamp(0, 1) * 255).byte().cpu().numpy()
        depth = render[0, ..., 3].cpu().numpy().astype(np.float32)
        # Only fuse where the render is actually opaque: a pixel the splat did
        # not cover has a depth value that means nothing.
        depth[alpha[0, ..., 0].cpu().numpy() < 0.8] = 0.0
        rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
            o3d.geometry.Image(np.ascontiguousarray(rgb)),
            o3d.geometry.Image(depth), depth_scale=1.0,
            depth_trunc=DEPTH_TRUNC_M, convert_rgb_to_intensity=False)
        intr = o3d.camera.PinholeCameraIntrinsic(w, h, c["fx"], c["fy"], c["cx"], c["cy"])
        volume.integrate(rgbd, intr, vm.astype(np.float64))

    mesh = volume.extract_triangle_mesh()
    mesh.compute_vertex_normals()
    dst = out_dir / "mesh.ply"
    o3d.io.write_triangle_mesh(str(dst), mesh)
    return dst, np.asarray(mesh.vertices)


def run(inp: Input, ctx: RunContext) -> Output:
    o3d = require_module("open3d", why="mesh reads and samples the fused mesh")
    out_dir = ctx.data_dir()

    if inp.backend == "dn-splatter":
        mesh_path = fuse_with_dn_splatter(Path(inp.ply_path), out_dir, inp.voxel_m)
        mesh = o3d.io.read_triangle_mesh(str(mesh_path))
        verts = np.asarray(mesh.vertices)
    elif inp.backend == "o3d-tsdf":
        mesh_path, verts = fuse_in_process(Path(inp.ply_path), inp.cameras,
                                           out_dir, inp.voxel_m)
        mesh = o3d.io.read_triangle_mesh(str(mesh_path))
    else:
        raise StageError(f"unknown mesh backend {inp.backend!r}; "
                         "expected 'dn-splatter' or 'o3d-tsdf'")

    if len(verts) < 1000:
        raise StageError(f"fused mesh has only {len(verts)} vertices; TSDF fusion "
                         "found almost no consistent surface, which means the "
                         "splat's depth is not view-consistent")

    # Subsample for plane fitting: 5 cm spacing is finer than the plane
    # threshold, so nothing is lost and RANSAC runs in seconds.
    pcd = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(verts))
    sampled = np.asarray(pcd.voxel_down_sample(0.05).points)

    floors, ceiling = floor_and_ceiling(sampled)
    planes = extract_planes(sampled)

    surfaces: list[PlaneSurface] = []
    refl_area = glaz_area = 0.0
    for i, pl in enumerate(planes):
        pts = pl["points"]
        centroid_y = float(np.mean(pts[:, 1]))
        kind = classify_plane(pl["normal"], centroid_y=centroid_y,
                              floor_y=floors[0], ceiling_y=ceiling)
        # Depth-behind evidence: does the fused geometry put points behind this
        # plane where a solid wall would allow none? A mirror does exactly that.
        n = np.asarray(pl["normal"])
        d = pl["d"]
        sd = sampled @ n + d
        near = sampled[np.abs(sd) < 0.5]
        behind = depth_behind_fraction(near, pts) if len(near) >= 3 else 0.0
        # The mesh stage has geometry only. Detection scores come from the
        # redact stage's OWLv2 pass and the view-dependence term needs a
        # trained splat, so at this point the depth test carries the
        # verdict on its own; both are folded in by the document stage
        # when they exist.
        ev = combine(behind=behind)
        s = PlaneSurface(
            id=f"srf_{i:03d}", kind=kind, normal=[float(v) for v in n],
            d=float(d), polygon=[[float(c) for c in p] for p in pl["polygon"]],
            area_m2=float(pl["area"]), point_count=int(pl["count"]),
            is_reflective=ev.is_reflective, is_glazed=ev.is_glazed,
            evidence=ev.to_json(),
            # Confidence falls with reflectivity: a wall we half-believe is a
            # mirror is a wall we half-believe.
            confidence=float(np.clip(0.9 - 0.6 * ev.reflective_score, 0.2, 0.95)))
        if s.is_reflective:
            refl_area += s.area_m2
        if s.is_glazed:
            glaz_area += s.area_m2
        surfaces.append(s)

    fused_path = ctx.out("fused.npz")
    np.savez_compressed(fused_path, points=sampled.astype(np.float32))
    surf_path = ctx.out("surfaces.json")
    surf_path.write_text(json.dumps([asdict(s) for s in surfaces], indent=1, default=float))

    warnings: list[str] = []
    if refl_area > 2.0:
        warnings.append(f"{refl_area:.1f} m2 of surface flagged reflective; "
                        "check for phantom rooms behind mirrors before publishing")
    if len(floors) > 3:
        warnings.append(f"{len(floors)} floor planes detected; either a multi-storey "
                        "property or a split-level artefact")

    out = Output(
        mesh_path=str(mesh_path), fused_cloud_path=str(fused_path),
        surfaces=surfaces, surfaces_path=str(surf_path),
        floor_elevations=[float(f) for f in floors], ceiling_elevation=float(ceiling),
        vertex_count=int(len(verts)),
        triangle_count=int(len(np.asarray(mesh.triangles))),
        backend=inp.backend, reflective_area_m2=float(refl_area),
        glazed_area_m2=float(glaz_area), warnings=warnings)
    log(LOG, logging.INFO, "mesh.ok", vertices=out.vertex_count,
        triangles=out.triangle_count, surfaces=len(surfaces),
        floors=len(floors), reflective_m2=round(refl_area, 2))
    return out
