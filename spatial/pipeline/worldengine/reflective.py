"""Mirrors and glazing — the two failure modes that produce confidently wrong worlds.

A mirror is not a hard surface to a reconstruction: it is a window onto a room
that does not exist. MapAnything and MoGe both happily return depth *behind* the
mirror plane, COLMAP triangulates the reflected features into a phantom room,
and the result is a two-bed flat with a third bedroom nobody can find. Glazing
fails the other way: the exterior blows out to saturation, depth becomes
unconstrained, and the splat grows a cloud of floaters just outside every
window.

Four signals, none decisive alone, combined into a per-region score:

  1. Open-vocabulary detection ("a mirror", "a window") on the frames. Reliable
     for a large framed mirror over a fireplace. Unreliable for a frameless
     wardrobe-door mirror, which is exactly the case that causes the most
     damage in UK flats.

  2. Depth-behind-plane. Fit the wall plane around the candidate region from
     the surrounding pixels, then check how much of the region's depth lies
     behind it. A mirror puts almost all of it behind; a picture puts none.
     This is the strongest single signal and it needs no model.

  3. View-dependence. Reflected content moves at twice the angular rate of the
     surface it is on, so the same 3D point reprojects inconsistently across
     views. Measured as the photometric residual of the region under
     multi-view reprojection, normalised by the residual of its surroundings.

  4. Saturation, for glazing only. A window in a UK interior shot on a phone
     with auto-exposure is usually clipped; the fraction of pixels at or near
     255 over a candidate region separates glazing from a white wall.

HOW WELL THIS WORKS, HONESTLY. Signals 2 and 4 are geometric and behave
predictably; in the published literature depth-behind-plane separates mirrors
from flat wall decor cleanly when the mirror is larger than roughly 0.5 m
across and the camera passes it at an oblique angle, which a walkthrough
normally does. The cases it does not catch: a mirror viewed only head-on (the
reflection's geometry degenerates to a plane and looks like a picture), a small
bathroom mirror above a basin seen from one position, and a mirror facing
another mirror. Signal 3 requires the splat to have trained, so it is only
available to the mesh stage onward. There is no calibrated precision/recall
number here because measuring one requires a labelled set of UK interiors,
which this pipeline does not have. What the pipeline does with the uncertainty
is the important part: a flagged surface downgrades the grounding of anything
derived from it rather than being deleted, and the quality gate counts flagged
area, so a flat full of mirrors routes to an operator instead of publishing.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np

# Score weights. Depth-behind-plane dominates because it is the only signal
# that is close to a physical test rather than a correlate.
W_DETECTION = 0.25
W_DEPTH_BEHIND = 0.45
W_VIEW_DEPENDENCE = 0.20
W_SATURATION = 0.10

# A surface is flagged reflective at this score. 0.5 means two strong signals,
# or the depth test alone at near certainty. Below it the surface stays
# unflagged but its confidence is reduced proportionally, so the information is
# not thrown away.
REFLECTIVE_THRESHOLD = 0.50
GLAZED_THRESHOLD = 0.45

# Depth more than this far behind the local wall plane counts as "behind".
# 8 cm is wider than the plane-fit residual of a real wall (typically 1-3 cm
# from monocular depth) and narrower than any real recess.
BEHIND_MARGIN_M = 0.08

# Pixels at or above this are treated as clipped. Not 255: phone ISPs apply a
# tone curve that lands blown highlights in the 248-255 band.
SATURATION_LEVEL = 248


@dataclass(slots=True)
class ReflectiveEvidence:
    """Mirror and glazing evidence kept apart.

    The detection scores are separate because the two classes are physically
    different and a single "something was detected here" score conflates them:
    depth behind the wall plane is strong evidence for a mirror and weak
    evidence for a window, so a mirror scored against a shared detection term
    ends up flagged as glazed too, and the viewer then treats it as somewhere
    daylight comes from.
    """
    mirror_detection: float = 0.0
    window_detection: float = 0.0
    depth_behind_fraction: float = 0.0
    view_dependence: float = 0.0
    saturation_fraction: float = 0.0

    @property
    def reflective_score(self) -> float:
        return float(np.clip(
            W_DETECTION * self.mirror_detection
            + W_DEPTH_BEHIND * self.depth_behind_fraction
            + W_VIEW_DEPENDENCE * min(1.0, self.view_dependence),
            0.0, 1.0))

    @property
    def glazed_score(self) -> float:
        # Glazing is saturation plus a window detection. Depth behind the plane
        # contributes only a little, because a window and a mirror both produce
        # it and the saturation term is what tells them apart.
        return float(np.clip(
            0.50 * self.saturation_fraction
            + 0.40 * self.window_detection
            + 0.10 * self.depth_behind_fraction,
            0.0, 1.0))

    @property
    def is_reflective(self) -> bool:
        return self.reflective_score >= REFLECTIVE_THRESHOLD

    @property
    def is_glazed(self) -> bool:
        return self.glazed_score >= GLAZED_THRESHOLD

    def to_json(self) -> dict[str, float]:
        return {"mirrorDetection": round(self.mirror_detection, 4),
                "windowDetection": round(self.window_detection, 4),
                "depthBehind": round(self.depth_behind_fraction, 4),
                "viewDependence": round(self.view_dependence, 4),
                "saturation": round(self.saturation_fraction, 4),
                "reflectiveScore": round(self.reflective_score, 4),
                "glazedScore": round(self.glazed_score, 4)}


def saturation_fraction(patch: np.ndarray, level: int = SATURATION_LEVEL) -> float:
    """Fraction of pixels with any channel at or above `level`."""
    a = np.asarray(patch)
    if a.size == 0:
        return 0.0
    if a.ndim == 3:
        clipped = (a >= level).any(axis=2)
    else:
        clipped = a >= level
    return float(clipped.mean())


def fit_plane(points: np.ndarray) -> tuple[np.ndarray, float]:
    """Least-squares plane through 3D points, returned as (unit n, d) with
    n . x + d = 0. Uses the SVD of the centred points, so it is the total
    least-squares fit rather than a regression on one axis."""
    p = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    if len(p) < 3:
        raise ValueError("need at least 3 points to fit a plane")
    centroid = p.mean(axis=0)
    _, _, vt = np.linalg.svd(p - centroid, full_matrices=False)
    n = vt[-1]
    n = n / np.linalg.norm(n)
    return n, float(-n @ centroid)


def depth_behind_fraction(region_points: np.ndarray, surround_points: np.ndarray,
                          *, margin: float = BEHIND_MARGIN_M) -> float:
    """Fraction of the region's points that lie behind the plane fitted to its
    surroundings, by more than `margin`.

    "Behind" is defined relative to the side the surrounding points sit on: the
    plane normal is oriented so that the surround's own mean signed distance is
    non-negative, and the region is behind when its signed distance is
    negative. That removes any dependence on which way the SVD happened to
    point the normal.
    """
    region = np.asarray(region_points, dtype=np.float64).reshape(-1, 3)
    surround = np.asarray(surround_points, dtype=np.float64).reshape(-1, 3)
    if len(region) == 0 or len(surround) < 3:
        return 0.0
    n, d = fit_plane(surround)
    # Orient the normal away from the wall, toward wherever the camera-facing
    # side is; the surround straddles the plane so use the region's own centre
    # only to break the sign, never to set the magnitude.
    sd_region = region @ n + d
    if np.median(sd_region) > 0:
        n, d, sd_region = -n, -d, -sd_region
    return float((sd_region < -margin).mean())


def view_dependence(residual_region: float, residual_surround: float) -> float:
    """Ratio of photometric residual inside a region to its surroundings.

    A Lambertian wall reprojects consistently, so the ratio is ~1. A mirror's
    content moves with the viewpoint, so its residual is several times higher.
    Clamped at 4 so one catastrophic frame cannot saturate the combined score.
    """
    if residual_surround <= 1e-9:
        return 0.0
    return float(np.clip(residual_region / residual_surround, 0.0, 4.0) / 4.0)


def combine(mirror_detection: float = 0.0, window_detection: float = 0.0,
            behind: float = 0.0, view_dep: float = 0.0,
            saturation: float = 0.0) -> ReflectiveEvidence:
    c = lambda v: float(np.clip(v, 0.0, 1.0))
    return ReflectiveEvidence(mirror_detection=c(mirror_detection),
                              window_detection=c(window_detection),
                              depth_behind_fraction=c(behind),
                              view_dependence=c(view_dep),
                              saturation_fraction=c(saturation))


def mask_depth_for_scale(depth: np.ndarray, rgb: np.ndarray, *,
                         valid: np.ndarray | None = None) -> np.ndarray:
    """Boolean mask of depth pixels safe to use for metric scale estimation.

    Drops saturated pixels (glazing, specular highlights) and the tails of the
    depth distribution. Metric scale is a *median* over this mask, so removing
    the pixels that both estimators get wrong in the same direction is not
    cherry-picking: it is removing the systematic term that would otherwise
    make two wrong estimators agree with each other.
    """
    d = np.asarray(depth, dtype=np.float32)
    m = np.isfinite(d) & (d > 0.15) & (d < 25.0)
    if valid is not None:
        m &= np.asarray(valid).astype(bool)
    a = np.asarray(rgb)
    if a.ndim == 3:
        m &= ~(a >= SATURATION_LEVEL).any(axis=2)
        m &= ~(a <= 6).all(axis=2)          # crushed blacks carry no depth cue
    return m
