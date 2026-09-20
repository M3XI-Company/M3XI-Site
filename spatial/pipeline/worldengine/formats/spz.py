"""SPZ v2 — the delivery container.

SPZ is Niantic's gzip-compressed, fixed-point gaussian splat format (MIT). It
is roughly an order of magnitude smaller than float32 PLY at visually
indistinguishable quality, which is the difference between a 400 MB and a 40 MB
download for a two-bed flat, which is the difference between a tour that loads
on 4G and one that does not.

Container, after gunzip:

    offset size  field
    0      4     magic, 0x5053474e little-endian ("NGSP" when read as bytes)
    4      4     version, 2
    8      4     numPoints
    12     1     shDegree (0..3)
    13     1     fractionalBits for positions (12 is the reference default)
    14     1     flags; bit 0 = antialiased
    15     1     reserved, 0
    16     ...   positions   numPoints * 3 * 3 bytes, 24-bit signed fixed point
           ...   alphas      numPoints * 1
           ...   colours     numPoints * 3
           ...   scales      numPoints * 3
           ...   rotations   numPoints * 3   (quaternion xyz; w recovered, w>=0)
           ...   sh          numPoints * shDim * 3, shDim = coeffs-1

Quantisation, matching the reference encoder:

    position  round(x * 2^fractionalBits) as 24-bit signed little-endian
    alpha     round(sigmoid(opacity) * 255)
    colour    round((sh0 * SH_C0 + 0.5) * 255), SH_C0 = 0.28209479177387814
    scale     round((log_scale + 10) * 16)
    rotation  round(q.xyz * 127.5 + 127.5) after forcing w >= 0
    sh        degree 1 coefficients to 8 bits at 1/8 step, higher bands at
              1/4 step, both centred on 128

HONESTY NOTE: this is a clean-room encoder written from the format
specification, not a binding to Niantic's libspz. It round-trips against
itself (tests/test_formats.py) and the quantisation constants match the
published ones, but before the first paid export, one file must be opened in
PlayCanvas' SuperSplat and in the reference C++ decoder. That check needs
network access to those tools and has not been done here.
"""
from __future__ import annotations

import gzip
import struct
from pathlib import Path
from typing import Any

import numpy as np

from .ply import SplatCloud

SPZ_MAGIC = 0x5053474E
SPZ_VERSION = 2
SPZ_HEADER = struct.Struct("<IIIBBBB")
SH_C0 = 0.28209479177387814

FLAG_ANTIALIASED = 0x1

_SH_COEFFS = {0: 0, 1: 3, 2: 8, 3: 15}     # coefficients ABOVE degree 0


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30.0, 30.0)))


def _logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-6, 1.0 - 1e-6)
    return np.log(p / (1.0 - p))


def _pack_i24(values: np.ndarray) -> bytes:
    """(M,) int32 in [-2^23, 2^23) -> 3-byte little-endian two's complement."""
    v = np.asarray(values, dtype=np.int64)
    if np.any(v < -(1 << 23)) or np.any(v >= (1 << 23)):
        raise ValueError(
            "position out of 24-bit fixed-point range; the world is larger than "
            "2048 m at 12 fractional bits. Recentre the world on its datum or "
            "lower fractionalBits."
        )
    u = (v.astype(np.int64) & 0xFFFFFF).astype(np.uint32)
    out = np.empty((u.size, 3), dtype=np.uint8)
    out[:, 0] = (u & 0xFF).astype(np.uint8)
    out[:, 1] = ((u >> 8) & 0xFF).astype(np.uint8)
    out[:, 2] = ((u >> 16) & 0xFF).astype(np.uint8)
    return out.tobytes()


def _unpack_i24(buf: bytes, count: int) -> np.ndarray:
    a = np.frombuffer(buf, dtype=np.uint8, count=count * 3).reshape(count, 3).astype(np.int64)
    u = a[:, 0] | (a[:, 1] << 8) | (a[:, 2] << 16)
    return np.where(u >= (1 << 23), u - (1 << 24), u)


def _sh_quant_step(index: int) -> float:
    """Reference encoder uses a coarser step for the higher bands, because
    they carry less energy and 8 bits each is where the format's size win
    comes from."""
    return 8.0 if index < 3 else 4.0


def encode(cloud: SplatCloud, *, fractional_bits: int = 12,
           antialiased: bool = True) -> bytes:
    n = cloud.count
    deg = cloud.sh_degree
    sh_dim = _SH_COEFFS[deg]

    scale_f = float(1 << fractional_bits)
    pos_q = np.rint(cloud.means.astype(np.float64) * scale_f).astype(np.int64)
    positions = _pack_i24(pos_q.reshape(-1))

    alphas = np.rint(_sigmoid(cloud.opacities.astype(np.float64)) * 255.0)
    alphas = np.clip(alphas, 0, 255).astype(np.uint8)

    colours = np.rint((cloud.sh0.astype(np.float64) * SH_C0 + 0.5) * 255.0)
    colours = np.clip(colours, 0, 255).astype(np.uint8)

    scales = np.rint((cloud.scales.astype(np.float64) + 10.0) * 16.0)
    scales = np.clip(scales, 0, 255).astype(np.uint8)

    q = cloud.quats.astype(np.float64)
    q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    # Only xyz is stored; the decoder recovers w = sqrt(1 - |xyz|^2) >= 0, so
    # the sign must be canonicalised before dropping it.
    q = np.where(q[:, 3:4] < 0.0, -q, q)
    rots = np.rint(q[:, :3] * 127.5 + 127.5)
    rots = np.clip(rots, 0, 255).astype(np.uint8)

    if sh_dim:
        shN = cloud.shN.astype(np.float64)                     # (N, K, 3)
        steps = np.array([_sh_quant_step(i) for i in range(sh_dim)])[None, :, None]
        sh_q = np.rint(shN * steps + 128.0)
        sh_bytes = np.clip(sh_q, 0, 255).astype(np.uint8).reshape(n, sh_dim * 3).tobytes()
    else:
        sh_bytes = b""

    flags = FLAG_ANTIALIASED if antialiased else 0
    header = SPZ_HEADER.pack(SPZ_MAGIC, SPZ_VERSION, n, deg, fractional_bits, flags, 0)
    raw = b"".join([header, positions, alphas.tobytes(), colours.tobytes(),
                    scales.tobytes(), rots.tobytes(), sh_bytes])
    # mtime=0 so the same cloud always yields the same bytes and therefore the
    # same checksum in wv_asset. Byte-identical rebuilds are how you tell a
    # re-upload from a re-render.
    return gzip.compress(raw, compresslevel=6, mtime=0)


def write_spz(path: str | Path, cloud: SplatCloud, **kw: Any) -> int:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(encode(cloud, **kw))
    return p.stat().st_size


def decode(blob: bytes) -> tuple[SplatCloud, dict[str, Any]]:
    raw = gzip.decompress(blob) if blob[:2] == b"\x1f\x8b" else blob
    magic, version, n, deg, frac_bits, flags, _ = SPZ_HEADER.unpack_from(raw, 0)
    if magic != SPZ_MAGIC:
        raise ValueError(f"not an SPZ file: magic 0x{magic:08x}")
    if version != SPZ_VERSION:
        raise ValueError(f"unsupported SPZ version {version}; this decoder is v2")
    if deg not in _SH_COEFFS:
        raise ValueError(f"invalid SH degree {deg}")
    sh_dim = _SH_COEFFS[deg]

    expected = SPZ_HEADER.size + n * (9 + 1 + 3 + 3 + 3 + sh_dim * 3)
    if len(raw) < expected:
        raise ValueError(f"SPZ truncated: {len(raw)} bytes, expected {expected}")

    off = SPZ_HEADER.size
    means = (_unpack_i24(raw[off:off + n * 9], n * 3).reshape(n, 3)
             / float(1 << frac_bits)).astype(np.float32)
    off += n * 9
    alphas = np.frombuffer(raw, np.uint8, n, off).astype(np.float64) / 255.0
    off += n
    colours = np.frombuffer(raw, np.uint8, n * 3, off).reshape(n, 3).astype(np.float64)
    off += n * 3
    scales_b = np.frombuffer(raw, np.uint8, n * 3, off).reshape(n, 3).astype(np.float64)
    off += n * 3
    rots_b = np.frombuffer(raw, np.uint8, n * 3, off).reshape(n, 3).astype(np.float64)
    off += n * 3

    sh0 = ((colours / 255.0) - 0.5) / SH_C0
    opac = _logit(alphas)
    scales = scales_b / 16.0 - 10.0
    xyz = (rots_b - 127.5) / 127.5
    w = np.sqrt(np.clip(1.0 - np.sum(xyz ** 2, axis=1), 0.0, 1.0))
    quats = np.concatenate([xyz, w[:, None]], axis=1)
    quats = quats / np.maximum(np.linalg.norm(quats, axis=1, keepdims=True), 1e-12)

    shN = None
    if sh_dim:
        sh_b = np.frombuffer(raw, np.uint8, n * sh_dim * 3, off).reshape(n, sh_dim, 3)
        steps = np.array([_sh_quant_step(i) for i in range(sh_dim)])[None, :, None]
        shN = ((sh_b.astype(np.float64) - 128.0) / steps).astype(np.float32)

    cloud = SplatCloud(means=means, scales=scales.astype(np.float32),
                       quats=quats.astype(np.float32), opacities=opac.astype(np.float32),
                       sh0=sh0.astype(np.float32), shN=shN)
    meta = {"version": version, "count": n, "shDegree": deg,
            "fractionalBits": frac_bits,
            "antialiased": bool(flags & FLAG_ANTIALIASED)}
    return cloud, meta


def read_spz(path: str | Path) -> tuple[SplatCloud, dict[str, Any]]:
    return decode(Path(path).read_bytes())


def peek(path: str | Path) -> dict[str, Any]:
    """Header only, without decoding the body — used by the packaging stage to
    fill wv_asset.splat_count without a full decode."""
    with gzip.open(path, "rb") as fh:
        head = fh.read(SPZ_HEADER.size)
    magic, version, n, deg, frac_bits, flags, _ = SPZ_HEADER.unpack(head)
    if magic != SPZ_MAGIC:
        raise ValueError(f"not an SPZ file: magic 0x{magic:08x}")
    return {"version": version, "count": n, "shDegree": deg,
            "fractionalBits": frac_bits,
            "antialiased": bool(flags & FLAG_ANTIALIASED)}
