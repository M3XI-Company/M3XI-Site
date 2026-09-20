"""package — encode and chunk the delivery assets.

Three formats, for three different jobs:

  SPZ    primary. ~10x smaller than float32 PLY at no visible cost, MIT, and
         supported by the viewers that matter. This is what a phone downloads.
  SOG    where the target supports it. PlayCanvas' self-organising gaussians
         pack into WebP textures and stream progressively, which is better
         again on a slow connection. Produced by shelling out to the
         `splat-transform` CLI; if that is not in the image, the SOG is skipped
         and recorded as skipped. It is an optimisation, not a requirement, so
         its absence is a note rather than a failure — unlike a model, a
         missing encoder cannot cause a wrong answer.
  PLY    archived. Uncompressed, unquantised, the thing the customer takes with
         them. The permanence promise in the world contract is that an export
         bundle still works when we are gone, and that requires a format with
         no proprietary decoder.

Room chunking is what makes the viewer load in under two seconds: gaussians are
split by which room polygon contains them, so a tour opens the hallway and
streams the rest. Gaussians outside every room (the exterior shell, the bit
past the window) go into a `_shell` chunk that loads last.
"""
from __future__ import annotations

import hashlib
import json
import logging
import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from ..artifacts import sha256_file
from ..formats import spz as spz_fmt
from ..formats.ply import SplatCloud, read_ply, write_ply
from ..geometry import points_in_ring
from ..logging_setup import get_logger, log
from ..runner import RunContext, StageError

LOG = get_logger("worldengine.package")

SUMMARY = "Encode SPZ (primary), SOG (where supported) and archival PLY; chunk by room"
USES_GPU = False
PRODUCES = ("world.spz", "chunks/*.spz", "archive/splat.ply", "manifest.json")

# Chunks smaller than this are merged into the shell: a 300-gaussian chunk
# costs a round trip and saves nothing.
MIN_CHUNK_GAUSSIANS = 5_000
# LOD 1 keeps the largest gaussians by projected area, which is what survives
# at a distance. 25% is the ratio at which a room still reads correctly from
# the doorway.
LOD1_FRACTION = 0.25


@dataclass(slots=True)
class Input:
    ply_path: str
    mesh_path: str
    rooms: list[dict[str, Any]]
    regions_path: str
    world_id: str
    make_sog: bool = True
    make_lod: bool = True


@dataclass(slots=True)
class PackagedAsset:
    id: str
    role: str
    format: str
    path: str
    bytes: int
    checksum: str
    chunk_key: str | None
    lod: int | None
    splat_count: int | None
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class Output:
    assets: list[PackagedAsset]
    manifest_path: str
    total_bytes: int
    primary_format: str
    sog_available: bool
    chunk_count: int
    warnings: list[str] = field(default_factory=list)


def build_input(ctx: RunContext, upstream: dict[str, Any]) -> Input:
    sp = upstream.get("splat") or {}
    me = upstream.get("mesh") or {}
    lay = upstream.get("layout") or {}
    reg = upstream.get("regions") or {}
    for name, val in (("splat", sp), ("mesh", me), ("layout", lay), ("regions", reg)):
        if not val:
            raise StageError(f"package requires the {name} stage output")
    return Input(ply_path=str(sp["ply_path"]), mesh_path=str(me["mesh_path"]),
                 rooms=list(lay["rooms"]), regions_path=str(reg["regions_path"]),
                 world_id=ctx.world_id,
                 make_sog=bool(ctx.param("make_sog", True)),
                 make_lod=bool(ctx.param("make_lod", True)))


# ---------------------------------------------------------------------------
# Chunking and LOD — pure, tested
# ---------------------------------------------------------------------------

def assign_chunks(means: np.ndarray, rooms: Sequence[dict[str, Any]]) -> list[str]:
    """Chunk key per gaussian: the room whose polygon and height band contain
    it, else '_shell'.

    Vectorised per room rather than per gaussian: a two-bed flat has around a
    million gaussians and half a dozen rooms, so this is six array passes
    instead of six million Python calls.

    The height band is deliberately loose (25 cm below the floor, 35 cm above
    the ceiling): gaussians representing a skirting board or a ceiling rose sit
    slightly outside the room's nominal extent and belong with the room, not in
    the shell chunk that loads last.
    """
    m = np.asarray(means, dtype=np.float64).reshape(-1, 3)
    out = np.full(len(m), "_shell", dtype=object)
    unassigned = np.ones(len(m), dtype=bool)
    for r in rooms:
        if not unassigned.any():
            break
        lo = float(r["floor_z"]) - 0.25
        hi = float(r["ceiling_z"]) + 0.35
        band = unassigned & (m[:, 1] >= lo) & (m[:, 1] <= hi)
        if not band.any():
            continue
        hit = np.zeros(len(m), dtype=bool)
        hit[band] = points_in_ring(m[band][:, [0, 2]], r["polygon"])
        out[hit] = r["stable_key"]
        unassigned &= ~hit
    return [str(v) for v in out]


def subset(cloud: SplatCloud, mask: np.ndarray) -> SplatCloud:
    m = np.asarray(mask, dtype=bool)
    return SplatCloud(
        means=cloud.means[m], scales=cloud.scales[m], quats=cloud.quats[m],
        opacities=cloud.opacities[m], sh0=cloud.sh0[m],
        shN=None if cloud.shN is None else cloud.shN[m],
        normals=None if cloud.normals is None else cloud.normals[m])


def lod_mask(cloud: SplatCloud, fraction: float) -> np.ndarray:
    """Keep the gaussians that matter at a distance.

    Ranked by the product of geometric size and opacity: a large, opaque
    gaussian carries the wall, a tiny transparent one carries a highlight
    nobody sees from the doorway. This is a size-based decimation, not a
    re-optimisation, so it is lossy in a way that is obvious rather than subtle.
    """
    n = cloud.count
    keep = max(1, int(round(n * float(fraction))))
    size = np.exp(cloud.scales).max(axis=1)
    alpha = 1.0 / (1.0 + np.exp(-cloud.opacities))
    score = size * alpha
    idx = np.argpartition(-score, keep - 1)[:keep]
    m = np.zeros(n, dtype=bool)
    m[idx] = True
    return m


def _asset(path: Path, role: str, fmt: str, *, chunk: str | None = None,
           lod: int | None = None, count: int | None = None,
           meta: dict[str, Any] | None = None) -> PackagedAsset:
    data = path.stat().st_size
    return PackagedAsset(
        id=hashlib.sha256(str(path).encode()).hexdigest()[:24],
        role=role, format=fmt, path=str(path), bytes=data,
        checksum=sha256_file(path), chunk_key=chunk, lod=lod,
        splat_count=count, meta=meta or {})


def run(inp: Input, ctx: RunContext) -> Output:
    out_dir = ctx.data_dir()
    chunk_dir = out_dir / "chunks"
    archive_dir = out_dir / "archive"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    archive_dir.mkdir(parents=True, exist_ok=True)

    cloud = read_ply(inp.ply_path)
    assets: list[PackagedAsset] = []
    warnings: list[str] = []

    whole = out_dir / "world.spz"
    spz_fmt.write_spz(whole, cloud)
    assets.append(_asset(whole, "splat", "spz", count=cloud.count,
                         meta={"shDegree": cloud.sh_degree}))

    archive_ply = archive_dir / "splat.ply"
    shutil.copy2(inp.ply_path, archive_ply)
    assets.append(_asset(archive_ply, "splat", "ply", count=cloud.count,
                         meta={"purpose": "archival; the customer's own copy"}))

    keys = assign_chunks(cloud.means, inp.rooms)
    arr = np.asarray(keys)
    chunk_count = 0
    for key in sorted(set(keys)):
        m = arr == key
        if key != "_shell" and int(m.sum()) < MIN_CHUNK_GAUSSIANS:
            arr[m] = "_shell"
    for key in sorted(set(arr.tolist())):
        m = arr == key
        if not m.any():
            continue
        sub = subset(cloud, m)
        safe = key.replace("/", "_").replace(",", "_")
        p = chunk_dir / f"{safe}.spz"
        spz_fmt.write_spz(p, sub)
        assets.append(_asset(p, "splat_chunk", "spz", chunk=key, lod=0,
                             count=sub.count))
        chunk_count += 1
        if inp.make_lod and sub.count > 4 * MIN_CHUNK_GAUSSIANS:
            lm = lod_mask(sub, LOD1_FRACTION)
            lp = chunk_dir / f"{safe}.lod1.spz"
            spz_fmt.write_spz(lp, subset(sub, lm))
            assets.append(_asset(lp, "splat_chunk", "spz", chunk=key, lod=1,
                                 count=int(lm.sum())))

    sog_ok = False
    if inp.make_sog:
        exe = shutil.which("splat-transform")
        if exe:
            sog_path = out_dir / "world.sog"
            p = subprocess.run([exe, str(archive_ply), str(sog_path)],
                               capture_output=True, text=True, check=False)
            if p.returncode == 0 and sog_path.exists():
                assets.append(_asset(sog_path, "splat", "sog", count=cloud.count))
                sog_ok = True
            else:
                warnings.append("splat-transform failed to produce SOG: "
                                f"{p.stderr.strip()[:200]}; SPZ remains primary")
        else:
            warnings.append("splat-transform is not installed, so no SOG was "
                            "produced. SPZ is the primary format regardless; SOG "
                            "is a bandwidth optimisation for viewers that read it.")

    mesh_src = Path(inp.mesh_path)
    if mesh_src.exists():
        mesh_dst = out_dir / "proxy.ply"
        shutil.copy2(mesh_src, mesh_dst)
        assets.append(_asset(mesh_dst, "proxy_mesh", "ply",
                             meta={"purpose": "collision and occlusion proxy"}))

    reg_src = Path(inp.regions_path)
    if reg_src.exists():
        reg_dst = out_dir / "regions.json"
        shutil.copy2(reg_src, reg_dst)
        assets.append(_asset(reg_dst, "export_bundle", "json",
                             meta={"purpose": "unobserved and generated volumes"}))

    manifest = out_dir / "manifest.json"
    manifest.write_text(json.dumps({"worldId": inp.world_id,
                                    "assets": [asdict(a) for a in assets]},
                                   indent=1, default=float))

    total = sum(a.bytes for a in assets)
    # 120 MB is where a tour stops loading acceptably on a UK 4G connection.
    if total > 120 * 1024 * 1024:
        warnings.append(f"delivery bundle is {total/1e6:.0f} MB; consider a lower "
                        "gaussian cap, the load will be slow on mobile")

    out = Output(assets=assets, manifest_path=str(manifest), total_bytes=int(total),
                 primary_format="spz", sog_available=sog_ok,
                 chunk_count=chunk_count, warnings=warnings)
    log(LOG, logging.INFO, "package.ok", assets=len(assets), chunks=chunk_count,
        total_mb=round(total / 1e6, 2), sog=sog_ok)
    return out
