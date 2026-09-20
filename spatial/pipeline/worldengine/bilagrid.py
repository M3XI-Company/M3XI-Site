"""Bilateral grid for per-image photometric correction.

A phone shoots a walkthrough with auto-exposure and auto-white-balance running
continuously. Walking from a north-facing bedroom into a south-facing living
room changes the ISP's output by well over a stop, and a splat trained on those
frames without compensation bakes the exposure ramp into the radiance field:
the living room wall is brighter *as geometry*, and the seam sits wherever the
exposure changed. It is one of the most visible artefacts in phone-captured
splats and it is entirely avoidable.

The fix is a per-image bilateral grid: a low-resolution 3D grid (x, y,
luminance) of 3x4 affine colour transforms, sliced trilinearly at each pixel
and applied to the rendered colour before the photometric loss. The renderer
therefore learns the scene, and the grid absorbs the camera's choices. At
render time for the viewer the grid is discarded, which is the point.

This is a clean-room implementation from the published method (Wang et al.,
"Bilateral Guided Radiance Field Processing"), written against gsplat's tensor
conventions. It deliberately does not vendor code from any Inria-derived
repository.
"""
from __future__ import annotations

from typing import Any


def _torch() -> Any:
    import torch
    return torch


def build_bilateral_grid(num_images: int, *, grid_x: int = 16, grid_y: int = 16,
                         grid_l: int = 8, device: str = "cuda") -> Any:
    """Parameters initialised to the identity affine.

    Shape (N, 12, L, Y, X). 12 = a 3x4 matrix per cell. 16x16x8 is the size the
    method's authors use and is where the grid has enough freedom to follow an
    auto-exposure ramp without enough freedom to start modelling the scene.
    """
    torch = _torch()
    ident = torch.tensor([1.0, 0.0, 0.0, 0.0,
                          0.0, 1.0, 0.0, 0.0,
                          0.0, 0.0, 1.0, 0.0], device=device)
    grid = ident.view(1, 12, 1, 1, 1).repeat(num_images, 1, grid_l, grid_y, grid_x)
    return torch.nn.Parameter(grid.clone())


def slice_bilateral_grid(grid: Any, image_index: int, rgb: Any) -> Any:
    """Apply the per-image grid to an (H, W, 3) rendered image in [0, 1].

    Guide channel is Rec.709 luminance, which is what the eye and the ISP both
    weight by; using plain mean would let a saturated red wall drive the
    exposure correction for the whole frame.
    """
    torch = _torch()
    import torch.nn.functional as F

    if rgb.dim() != 3 or rgb.shape[-1] != 3:
        raise ValueError(f"expected (H, W, 3), got {tuple(rgb.shape)}")
    h, w, _ = rgb.shape
    lum = (0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2])

    ys = torch.linspace(-1.0, 1.0, h, device=rgb.device)
    xs = torch.linspace(-1.0, 1.0, w, device=rgb.device)
    gy, gx = torch.meshgrid(ys, xs, indexing="ij")
    gl = (lum.clamp(0.0, 1.0) * 2.0 - 1.0)
    # grid_sample's 3D coordinate order is (x, y, z) mapped to (W, H, D).
    coords = torch.stack([gx, gy, gl], dim=-1).view(1, 1, h, w, 3)

    g = grid[image_index].unsqueeze(0)                    # (1, 12, L, Y, X)
    sampled = F.grid_sample(g, coords, mode="bilinear",
                            padding_mode="border", align_corners=True)
    affine = sampled.view(3, 4, h, w).permute(2, 3, 0, 1)  # (H, W, 3, 4)
    homog = torch.cat([rgb, torch.ones_like(rgb[..., :1])], dim=-1).unsqueeze(-1)
    return (affine @ homog).squeeze(-1)


def total_variation_loss(grid: Any) -> Any:
    """Smoothness prior over the grid.

    Without it the grid develops sharp cell boundaries and starts explaining
    scene detail instead of camera behaviour, at which point it is no longer a
    correction, it is a second renderer with no geometry.
    """
    torch = _torch()
    d_x = (grid[..., 1:] - grid[..., :-1]).abs().mean()
    d_y = (grid[..., 1:, :] - grid[..., :-1, :]).abs().mean()
    d_l = (grid[:, :, 1:] - grid[:, :, :-1]).abs().mean()
    return d_x + d_y + d_l
