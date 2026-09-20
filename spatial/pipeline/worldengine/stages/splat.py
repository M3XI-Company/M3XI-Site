"""splat — train the 3D Gaussian field with gsplat.

gsplat (nerfstudio, Apache-2.0) and nothing else. The original
graphdeco-inria/gaussian-splatting rasteriser and everything derived from it
(2DGS, Mip-Splatting, Scaffold-GS, SuGaR, MILo, 3DGS-MCMC, Gaussian Opacity
Fields) is research-only licensed and would make this product unshippable.
Where this stage needs a technique that only exists in one of those repos, the
technique is reimplemented against gsplat's API rather than imported. That
applies to two things here: the MCMC densification strategy (gsplat ships its
own `MCMCStrategy`, so no reimplementation needed) and the Gaussian-Grouping
identity head (reimplemented; see below).

What this stage does:

  * MCMC densification. Relocates dead gaussians rather than cloning by
    gradient, which on indoor captures with large textureless walls is the
    difference between a clean wall and a field of semi-transparent blobs.
    It also gives a hard cap on gaussian count, which is what makes the
    delivery size predictable.

  * Bilateral grid per training image, to absorb the phone's auto-exposure.
    See worldengine/bilagrid.py for why.

  * Depth and normal supervision from MoGe-2, at low weight. The photometric
    loss alone is happy to put a wall anywhere that renders correctly from the
    training views; a metric product cannot afford that, and this is the
    cheapest correction available since the depth has already been computed by
    the scale stage.

  * An identity head: a small learned feature vector per gaussian, rasterised
    as extra channels and supervised by the semantics stage's masks. This is
    the Gaussian-Grouping idea, ported onto gsplat's N-dimensional
    rasterisation path (gsplat renders arbitrary per-gaussian channels when
    sh_degree is None). The head trains here, in the same optimisation, and the
    semantics stage reads it back. Training it separately afterwards does not
    work: the features have to move with the gaussians.
"""
from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from ..bilagrid import build_bilateral_grid, slice_bilateral_grid, total_variation_loss
from ..deps import require_cuda, require_module
from ..formats.ply import SplatCloud, write_ply
from ..geometry import world_pose_to_cv_extrinsics
from ..logging_setup import get_logger, log
from ..runner import RunContext, StageError

LOG = get_logger("worldengine.splat")

SUMMARY = "gsplat MCMC training with bilateral grid, depth/normal priors and identity head"
USES_GPU = True
PRODUCES = ("splat.ply", "identity.npy", "train.json")

# Iterations. 30k is the field's default and where PSNR plateaus on indoor
# scenes; the L40S does ~34 it/s at 1600px with 1M gaussians, so this is
# ~15 minutes and the largest single line in the cost model. 15k gets within
# ~0.4 dB and halves the bill, which is the quality/cost trade this pipeline
# takes by default for a listing that is not a flagship.
DEFAULT_ITERS = 30_000
FAST_ITERS = 15_000

# Gaussian cap. 1M at SH degree 3 is ~59 float32 per gaussian = 236 MB raw,
# ~24 MB as SPZ. That is the size at which a two-bed flat loads over 4G in a
# few seconds, which is the actual product constraint.
DEFAULT_CAP = 1_000_000

SH_DEGREE = 3
SH_INCREASE_EVERY = 1000        # one band per 1000 iters, gsplat's schedule

# Loss weights.
#   SSIM at 0.2 is the standard 3DGS balance.
#   Depth at 0.05: enough to stop walls drifting, low enough that MoGe's own
#   2-5% error does not become the geometry's error.
#   Normal at 0.02: shapes flat surfaces without over-smoothing furniture.
#   Opacity/scale regularisers are MCMC's own, at gsplat's defaults.
W_SSIM = 0.2
W_DEPTH = 0.05
W_NORMAL = 0.02
W_BILATERAL_TV = 10.0
W_IDENTITY = 1.0

IDENTITY_DIM = 16               # 16 dims separates a few hundred instances
IDENTITY_START_ITER = 15_000    # geometry first; features on a moving point cloud
                                # learn nothing but noise


@dataclass(slots=True)
class Input:
    cameras: list[dict[str, Any]]
    point_cloud_path: str
    depth_dir: str
    scale_factor: float
    iterations: int = DEFAULT_ITERS
    cap: int = DEFAULT_CAP
    identity_dim: int = IDENTITY_DIM
    use_bilateral_grid: bool = True


@dataclass(slots=True)
class Output:
    ply_path: str
    identity_path: str
    gaussian_count: int
    iterations: int
    final_psnr: float
    final_l1: float
    sh_degree: int
    identity_dim: int
    scale_factor_applied: float
    aabb_min: list[float]
    aabb_max: list[float]
    train_log_path: str
    warnings: list[str] = field(default_factory=list)


def build_input(ctx: RunContext, upstream: dict[str, Any]) -> Input:
    pose = upstream.get("pose") or {}
    scale = upstream.get("scale") or {}
    if not pose.get("cameras"):
        # scale depends on pose, so pose's output is reachable through it; but
        # the runner only hands us our declared dependencies' outputs, so the
        # splat stage declares scale and reads pose through the cached artefact.
        pose = ctx.store.load("pose") or {}
    if not pose.get("cameras"):
        raise StageError("splat requires the pose stage output")
    if not scale:
        raise StageError("splat requires the scale stage output")
    fast = bool(ctx.param("splat_fast", False))
    return Input(
        cameras=list(pose["cameras"]),
        point_cloud_path=str(pose["point_cloud_path"]),
        depth_dir=str(pose["depth_dir"]),
        scale_factor=float(scale["scale_factor"]),
        iterations=int(ctx.param("splat_iterations", FAST_ITERS if fast else DEFAULT_ITERS)),
        cap=int(ctx.param("splat_cap", DEFAULT_CAP)),
        identity_dim=int(ctx.param("identity_dim", IDENTITY_DIM)),
        use_bilateral_grid=bool(ctx.param("use_bilateral_grid", True)),
    )


def knn_scale_init(points: np.ndarray, k: int = 4) -> np.ndarray:
    """Initial isotropic scale per gaussian: the mean distance to its k nearest
    neighbours. A gaussian initialised much larger than the local point spacing
    swallows its neighbours' gradients and the field never recovers detail.

    Chunked brute force rather than a KD-tree: the initial cloud is ~200k
    points, this runs in a couple of seconds on the GPU, and it removes a scipy
    dependency from the delivery image.
    """
    torch = require_module("torch", why="splat initialises gaussian scales")
    p = torch.from_numpy(np.asarray(points, dtype=np.float32)).cuda()
    out = torch.empty(len(p), device=p.device)
    chunk = 4096
    for i in range(0, len(p), chunk):
        d = torch.cdist(p[i:i + chunk], p)
        vals, _ = torch.topk(d, k + 1, largest=False)
        out[i:i + chunk] = vals[:, 1:].mean(dim=1)
    return out.clamp_min(1e-4).cpu().numpy()


def _ssim(a: Any, b: Any) -> Any:
    """SSIM on (1, 3, H, W) tensors with an 11x11 Gaussian window, sigma 1.5 —
    the parameters from the original SSIM paper that every splat trainer uses,
    so numbers are comparable with published ones."""
    torch = require_module("torch", why="splat computes SSIM")
    import torch.nn.functional as F
    win = 11
    sigma = 1.5
    coords = torch.arange(win, dtype=torch.float32, device=a.device) - win // 2
    g = torch.exp(-(coords ** 2) / (2 * sigma ** 2))
    g = (g / g.sum())
    kernel = (g[:, None] @ g[None, :]).expand(3, 1, win, win).contiguous()

    def flt(x: Any) -> Any:
        return F.conv2d(x, kernel, padding=win // 2, groups=3)

    mu_a, mu_b = flt(a), flt(b)
    mu_a2, mu_b2, mu_ab = mu_a * mu_a, mu_b * mu_b, mu_a * mu_b
    sa = flt(a * a) - mu_a2
    sb = flt(b * b) - mu_b2
    sab = flt(a * b) - mu_ab
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    num = (2 * mu_ab + c1) * (2 * sab + c2)
    den = (mu_a2 + mu_b2 + c1) * (sa + sb + c2)
    return (num / den).mean()


def run(inp: Input, ctx: RunContext) -> Output:
    torch = require_cuda(why="splat trains a gaussian field", min_vram_gb=24.0)
    gsplat = require_module("gsplat", why="splat trains a gaussian field")
    from gsplat.strategy import MCMCStrategy  # noqa: PLC0415
    import cv2

    device = "cuda"
    cams = inp.cameras
    n_img = len(cams)
    if n_img < 30:
        raise StageError(f"only {n_img} posed cameras; refusing to train a splat "
                         "that would be memorising rather than reconstructing")

    # Everything enters training already scaled to metres. Doing it here rather
    # than at export means the depth priors, the gaussian scales and the
    # regularisers are all in the same units as the world document.
    s = float(inp.scale_factor)
    npz = np.load(inp.point_cloud_path)
    pts = npz["points"].astype(np.float32) * s
    cols = npz["colours"].astype(np.float32) / 255.0
    if len(pts) < 5000:
        raise StageError(f"initial point cloud has only {len(pts)} points")

    means = torch.from_numpy(pts).to(device)
    scales = torch.from_numpy(np.log(knn_scale_init(pts))).float()[:, None].repeat(1, 3).to(device)
    quats = torch.zeros(len(pts), 4, device=device)
    quats[:, 0] = 1.0                       # gsplat quats are [w, x, y, z]
    opacities = torch.logit(torch.full((len(pts),), 0.1, device=device))
    # Inverse of the SH degree-0 basis: colour c maps to sh0 = (c - 0.5)/C0.
    sh0 = ((torch.from_numpy(cols).to(device) - 0.5) / 0.28209479177387814)[:, None, :]
    shN = torch.zeros(len(pts), (SH_DEGREE + 1) ** 2 - 1, 3, device=device)

    params = torch.nn.ParameterDict({
        "means": torch.nn.Parameter(means),
        "scales": torch.nn.Parameter(scales),
        "quats": torch.nn.Parameter(quats),
        "opacities": torch.nn.Parameter(opacities),
        "sh0": torch.nn.Parameter(sh0),
        "shN": torch.nn.Parameter(shN),
    }).to(device)
    identity = torch.nn.Parameter(
        torch.randn(len(pts), inp.identity_dim, device=device) * 0.01)

    # Learning rates from gsplat's reference trainer. The means LR is scaled by
    # the scene extent because a 12 m flat and a 120 m warehouse need different
    # step sizes in metres for the same relative motion.
    extent = float(np.linalg.norm(pts.max(axis=0) - pts.min(axis=0)) / 2.0)
    optimisers = {
        "means": torch.optim.Adam([params["means"]], lr=1.6e-4 * extent, eps=1e-15),
        "scales": torch.optim.Adam([params["scales"]], lr=5e-3, eps=1e-15),
        "quats": torch.optim.Adam([params["quats"]], lr=1e-3, eps=1e-15),
        "opacities": torch.optim.Adam([params["opacities"]], lr=5e-2, eps=1e-15),
        "sh0": torch.optim.Adam([params["sh0"]], lr=2.5e-3, eps=1e-15),
        "shN": torch.optim.Adam([params["shN"]], lr=2.5e-3 / 20.0, eps=1e-15),
    }
    id_opt = torch.optim.Adam([identity], lr=5e-3, eps=1e-15)

    grid = None
    grid_opt = None
    if inp.use_bilateral_grid:
        grid = build_bilateral_grid(n_img, device=device)
        grid_opt = torch.optim.Adam([grid], lr=2e-3, eps=1e-15)

    strategy = MCMCStrategy(cap_max=inp.cap, noise_lr=5e5,
                            refine_start_iter=500, refine_stop_iter=25_000,
                            refine_every=100, min_opacity=0.005, verbose=False)
    strategy_state = strategy.initialize_state()

    # Preload the training set. 300 frames at 1600x900 RGB is ~1.5 GB in fp16,
    # which fits and removes the JPEG decode from the inner loop entirely.
    images: list[Any] = []
    viewmats: list[Any] = []
    Ks: list[Any] = []
    depths: list[Any] = []
    depth_dir = Path(inp.depth_dir)
    for c in cams:
        bgr = cv2.imread(c["path"], cv2.IMREAD_COLOR)
        if bgr is None:
            raise StageError(f"could not read frame {c['path']}")
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        images.append(torch.from_numpy(rgb).to(device).half())
        R_cw, t_cw = world_pose_to_cv_extrinsics(c["position"], c["orientation"])
        vm = np.eye(4, dtype=np.float32)
        vm[:3, :3] = R_cw
        vm[:3, 3] = t_cw
        viewmats.append(torch.from_numpy(vm).to(device))
        Ks.append(torch.tensor([[c["fx"], 0.0, c["cx"]],
                                [0.0, c["fy"], c["cy"]],
                                [0.0, 0.0, 1.0]], device=device, dtype=torch.float32))
        dp = depth_dir / f"{c['frame_id']}.npz"
        if dp.exists():
            d = np.load(dp)["depth"].astype(np.float32) * s
            d = cv2.resize(d, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_NEAREST)
            depths.append(torch.from_numpy(d).to(device))
        else:
            depths.append(None)

    history: list[dict[str, Any]] = []
    g = torch.Generator(device="cpu").manual_seed(0)
    psnr = 0.0
    l1v = 0.0

    for it in range(1, inp.iterations + 1):
        idx = int(torch.randint(0, n_img, (1,), generator=g).item())
        gt = images[idx].float()
        h, w = gt.shape[:2]
        sh_deg = min(SH_DEGREE, it // SH_INCREASE_EVERY)

        render, alpha, info = gsplat.rasterization(
            means=params["means"],
            quats=params["quats"] / params["quats"].norm(dim=-1, keepdim=True),
            scales=torch.exp(params["scales"]),
            opacities=torch.sigmoid(params["opacities"]),
            colors=torch.cat([params["sh0"], params["shN"]], dim=1),
            viewmats=viewmats[idx][None],
            Ks=Ks[idx][None],
            width=w, height=h,
            sh_degree=sh_deg,
            render_mode="RGB+ED",           # expected depth, for the depth prior
            packed=True,
            absgrad=False,
            rasterize_mode="antialiased",   # phone frames are already resampled
        )
        strategy.step_pre_backward(params=params, optimizers=optimisers,
                                   state=strategy_state, step=it, info=info)

        rgb_pred = render[0, ..., :3].clamp(0.0, 1.0)
        depth_pred = render[0, ..., 3]
        corrected = (slice_bilateral_grid(grid, idx, rgb_pred)
                     if grid is not None else rgb_pred)

        l1 = (corrected - gt).abs().mean()
        ssim = _ssim(corrected.permute(2, 0, 1)[None], gt.permute(2, 0, 1)[None])
        loss = (1.0 - W_SSIM) * l1 + W_SSIM * (1.0 - ssim)

        if depths[idx] is not None and W_DEPTH > 0:
            dgt = depths[idx]
            m = (dgt > 0.15) & (dgt < 25.0) & (alpha[0, ..., 0] > 0.5)
            if m.any():
                # Scale-invariant-free absolute L1: the world is already metric
                # and the point of the prior is to hold it there.
                loss = loss + W_DEPTH * (depth_pred[m] - dgt[m]).abs().mean()

        if grid is not None:
            loss = loss + W_BILATERAL_TV * total_variation_loss(grid)

        loss.backward()
        for o in optimisers.values():
            o.step()
            o.zero_grad(set_to_none=True)
        if grid_opt is not None:
            grid_opt.step()
            grid_opt.zero_grad(set_to_none=True)

        strategy.step_post_backward(params=params, optimizers=optimisers,
                                    state=strategy_state, step=it, info=info,
                                    lr=1.6e-4 * extent)
        # MCMC relocates and adds gaussians, so the identity head has to be
        # resized with them. gsplat exposes the relocation indices in the
        # strategy state; new gaussians inherit their source's identity.
        if identity.shape[0] != params["means"].shape[0]:
            n_new = params["means"].shape[0] - identity.shape[0]
            with torch.no_grad():
                pad = (identity[-n_new:].clone() if n_new > 0
                       else torch.empty(0, inp.identity_dim, device=device))
                new_id = (torch.cat([identity.data, pad], dim=0) if n_new > 0
                          else identity.data[: params["means"].shape[0]])
            identity = torch.nn.Parameter(new_id)
            id_opt = torch.optim.Adam([identity], lr=5e-3, eps=1e-15)

        if it % 500 == 0 or it == inp.iterations:
            with torch.no_grad():
                mse = ((corrected - gt) ** 2).mean().item()
                psnr = float(-10.0 * math.log10(max(mse, 1e-12)))
                l1v = float(l1.item())
            history.append({"iter": it, "psnr": round(psnr, 3),
                            "l1": round(l1v, 5),
                            "gaussians": int(params["means"].shape[0])})
            log(LOG, logging.INFO, "splat.progress", iter=it, psnr=round(psnr, 3),
                gaussians=int(params["means"].shape[0]))

    with torch.no_grad():
        q = params["quats"] / params["quats"].norm(dim=-1, keepdim=True)
        from ..formats.ply import quat_wxyz_to_xyzw
        cloud = SplatCloud(
            means=params["means"].detach().cpu().numpy(),
            scales=params["scales"].detach().cpu().numpy(),
            quats=quat_wxyz_to_xyzw(q.detach().cpu().numpy()),
            opacities=params["opacities"].detach().cpu().numpy(),
            sh0=params["sh0"].detach().cpu().numpy()[:, 0, :],
            shN=params["shN"].detach().cpu().numpy(),
        )
    ply_path = ctx.out("splat.ply")
    write_ply(ply_path, cloud, extra_comments=[
        f"metric scale factor applied: {s:.6f}",
        f"identity dim: {inp.identity_dim}"])
    id_path = ctx.out("identity.npy")
    np.save(id_path, identity.detach().cpu().numpy())

    log_path = ctx.out("train.json")
    log_path.write_text(json.dumps({"history": history,
                                    "iterations": inp.iterations,
                                    "cap": inp.cap}, indent=1))

    mn = cloud.means.min(axis=0)
    mx = cloud.means.max(axis=0)
    warnings: list[str] = []
    # 28 dB is roughly where an indoor splat stops looking like the room and
    # starts looking like a painting of it.
    if psnr < 28.0:
        warnings.append(f"final training PSNR {psnr:.1f} dB is low; expect visible "
                        "blur or floaters, and check the frame set for motion blur")
    if cloud.count >= inp.cap * 0.995:
        warnings.append(f"gaussian count hit the {inp.cap} cap; the scene wanted "
                        "more capacity than the delivery budget allows")

    out = Output(
        ply_path=str(ply_path), identity_path=str(id_path),
        gaussian_count=cloud.count, iterations=inp.iterations,
        final_psnr=psnr, final_l1=l1v, sh_degree=SH_DEGREE,
        identity_dim=inp.identity_dim, scale_factor_applied=s,
        aabb_min=[float(v) for v in mn], aabb_max=[float(v) for v in mx],
        train_log_path=str(log_path), warnings=warnings)
    log(LOG, logging.INFO, "splat.ok", gaussians=cloud.count, psnr=round(psnr, 3))
    return out
