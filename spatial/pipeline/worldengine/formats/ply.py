"""3D Gaussian splat PLY, read and write.

The de-facto interchange layout, as written by gsplat's exporter and read by
every viewer: binary_little_endian 1.0, one `vertex` element, float32
properties in this order:

    x y z                       centre, metres, world frame
    nx ny nz                    normal (written as zeros by most trainers;
                                DN-Splatter actually populates it, which is why
                                we keep the slots rather than dropping them)
    f_dc_0 f_dc_1 f_dc_2        SH degree-0 colour coefficients
    f_rest_0 .. f_rest_{3k-1}   higher SH bands, PLANAR: all R, then all G,
                                then all B. This ordering trips people up
                                constantly; it is channel-major, not
                                coefficient-major.
    opacity                     logit, pre-sigmoid
    scale_0 scale_1 scale_2     log scale, pre-exp, metres
    rot_0 rot_1 rot_2 rot_3     quaternion as [w, x, y, z]  <-- NOT our order

Note the last line. The world contract uses [x, y, z, w]; this file format uses
[w, x, y, z]. Everything that crosses this boundary goes through
`quat_wxyz_to_xyzw` / `quat_xyzw_to_wxyz` so the conversion is one place and
one test rather than a guess at each call site.

This module deliberately does not depend on plyfile: the header is twenty lines
of text and the body is a single numpy structured read, and an extra dependency
in the delivery path is an extra thing that can break a paid export.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Sequence

import numpy as np

SH_COEFFS_FOR_DEGREE = {0: 1, 1: 4, 2: 9, 3: 16}


def sh_degree_from_rest(n_rest: int) -> int:
    """f_rest count -> SH degree. n_rest = 3 * (coeffs - 1)."""
    if n_rest % 3 != 0:
        raise ValueError(f"f_rest count {n_rest} is not a multiple of 3")
    coeffs = n_rest // 3 + 1
    for deg, c in SH_COEFFS_FOR_DEGREE.items():
        if c == coeffs:
            return deg
    raise ValueError(f"f_rest count {n_rest} implies {coeffs} SH coefficients, "
                     "which is not a valid SH degree (1, 4, 9 or 16)")


def quat_wxyz_to_xyzw(q: np.ndarray) -> np.ndarray:
    q = np.asarray(q)
    return np.stack([q[..., 1], q[..., 2], q[..., 3], q[..., 0]], axis=-1)


def quat_xyzw_to_wxyz(q: np.ndarray) -> np.ndarray:
    q = np.asarray(q)
    return np.stack([q[..., 3], q[..., 0], q[..., 1], q[..., 2]], axis=-1)


@dataclass(slots=True)
class SplatCloud:
    """Gaussians in the world frame, in the parameterisation the trainer uses.

    means      (N, 3) metres
    scales     (N, 3) log-scale, pre-exp
    quats      (N, 4) [x, y, z, w], normalised
    opacities  (N,)   logit, pre-sigmoid
    sh0        (N, 3) degree-0 SH coefficients
    shN        (N, K, 3) higher bands, K = coeffs-1, coefficient-major here
               (we store the sane ordering internally and transpose on write)
    normals    (N, 3) or None
    """
    means: np.ndarray
    scales: np.ndarray
    quats: np.ndarray
    opacities: np.ndarray
    sh0: np.ndarray
    shN: np.ndarray | None = None
    normals: np.ndarray | None = None

    def __post_init__(self) -> None:
        n = self.means.shape[0]
        if self.means.shape != (n, 3):
            raise ValueError(f"means must be (N,3), got {self.means.shape}")
        for name, arr, shape in (("scales", self.scales, (n, 3)),
                                 ("quats", self.quats, (n, 4)),
                                 ("sh0", self.sh0, (n, 3))):
            if arr.shape != shape:
                raise ValueError(f"{name} must be {shape}, got {arr.shape}")
        if self.opacities.shape not in ((n,), (n, 1)):
            raise ValueError(f"opacities must be (N,), got {self.opacities.shape}")
        self.opacities = self.opacities.reshape(n)
        if self.shN is not None and (self.shN.ndim != 3 or self.shN.shape[0] != n
                                     or self.shN.shape[2] != 3):
            raise ValueError(f"shN must be (N,K,3), got {self.shN.shape}")
        if self.normals is not None and self.normals.shape != (n, 3):
            raise ValueError(f"normals must be (N,3), got {self.normals.shape}")

    @property
    def count(self) -> int:
        return int(self.means.shape[0])

    @property
    def sh_degree(self) -> int:
        if self.shN is None or self.shN.shape[1] == 0:
            return 0
        return sh_degree_from_rest(self.shN.shape[1] * 3)


def _field_names(sh_rest: int) -> list[str]:
    names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
    names += [f"f_rest_{i}" for i in range(sh_rest)]
    names += ["opacity", "scale_0", "scale_1", "scale_2",
              "rot_0", "rot_1", "rot_2", "rot_3"]
    return names


def write_ply(path: str | Path, cloud: SplatCloud, *,
              extra_comments: Sequence[str] = ()) -> int:
    n = cloud.count
    k = 0 if cloud.shN is None else int(cloud.shN.shape[1])
    sh_rest = k * 3
    names = _field_names(sh_rest)

    cols: list[np.ndarray] = [cloud.means.astype(np.float32)]
    normals = cloud.normals if cloud.normals is not None else np.zeros((n, 3), np.float32)
    cols.append(normals.astype(np.float32))
    cols.append(cloud.sh0.astype(np.float32))
    if k:
        # (N, K, 3) -> channel-major (N, 3*K): all R coefficients, then G, then B.
        cols.append(np.ascontiguousarray(
            cloud.shN.astype(np.float32).transpose(0, 2, 1).reshape(n, sh_rest)))
    cols.append(cloud.opacities.astype(np.float32).reshape(n, 1))
    cols.append(cloud.scales.astype(np.float32))
    cols.append(quat_xyzw_to_wxyz(cloud.quats).astype(np.float32))

    body = np.concatenate(cols, axis=1).astype("<f4", copy=False)
    if body.shape[1] != len(names):
        raise AssertionError(f"built {body.shape[1]} columns for {len(names)} names")

    header = ["ply", "format binary_little_endian 1.0"]
    header += [f"comment {c}" for c in
               ("generated by m3xi worldengine", f"sh_degree {cloud.sh_degree}",
                "world frame: right-handed, +Y up, metres",
                "rot_* is [w,x,y,z]; the world contract uses [x,y,z,w]",
                *extra_comments)]
    header.append(f"element vertex {n}")
    header += [f"property float {nm}" for nm in names]
    header.append("end_header")

    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "wb") as fh:
        fh.write(("\n".join(header) + "\n").encode("ascii"))
        fh.write(body.tobytes(order="C"))
    return p.stat().st_size


def read_ply_header(fh: BinaryIO) -> tuple[dict[str, Any], int]:
    """Parse the ASCII header. Returns (header, byte offset of the body)."""
    magic = fh.readline().strip()
    if magic != b"ply":
        raise ValueError(f"not a PLY file: magic {magic!r}")
    fmt: str | None = None
    count: int | None = None
    props: list[tuple[str, str]] = []
    comments: list[str] = []
    in_vertex = False
    while True:
        raw = fh.readline()
        if not raw:
            raise ValueError("PLY header ended without end_header")
        line = raw.decode("ascii", "replace").strip()
        if line == "end_header":
            break
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "format":
            fmt = parts[1]
        elif parts[0] == "comment":
            comments.append(line[len("comment "):])
        elif parts[0] == "element":
            in_vertex = parts[1] == "vertex"
            if in_vertex:
                count = int(parts[2])
        elif parts[0] == "property" and in_vertex:
            if parts[1] == "list":
                raise ValueError("list properties are not supported on vertex elements")
            props.append((parts[1], parts[2]))
    if fmt != "binary_little_endian":
        raise ValueError(f"only binary_little_endian is supported, got {fmt!r}")
    if count is None:
        raise ValueError("PLY has no vertex element")
    return ({"count": count, "properties": props, "comments": comments,
             "format": fmt}, fh.tell())


_NP_FOR_PLY = {"float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8",
               "uchar": "u1", "uint8": "u1", "char": "i1", "int8": "i1",
               "short": "<i2", "int16": "<i2", "ushort": "<u2", "uint16": "<u2",
               "int": "<i4", "int32": "<i4", "uint": "<u4", "uint32": "<u4"}


def read_ply(path: str | Path) -> SplatCloud:
    with open(path, "rb") as fh:
        header, offset = read_ply_header(fh)
        props = header["properties"]
        dtype = np.dtype([(name, _NP_FOR_PLY[ptype]) for ptype, name in props])
        fh.seek(offset)
        raw = np.frombuffer(fh.read(dtype.itemsize * header["count"]), dtype=dtype,
                            count=header["count"])

    names = [n for _, n in props]
    missing = [r for r in ("x", "y", "z", "opacity", "scale_0", "rot_0") if r not in names]
    if missing:
        raise ValueError(f"PLY is not a gaussian splat cloud; missing {missing}")

    def col(*keys: str) -> np.ndarray:
        return np.stack([raw[k].astype(np.float32) for k in keys], axis=1)

    means = col("x", "y", "z")
    normals = col("nx", "ny", "nz") if "nx" in names else None
    sh0 = col("f_dc_0", "f_dc_1", "f_dc_2")
    rest_names = sorted((n for n in names if n.startswith("f_rest_")),
                        key=lambda s: int(s.split("_")[-1]))
    shN = None
    if rest_names:
        flat = col(*rest_names)                      # (N, 3K) channel-major
        k = len(rest_names) // 3
        shN = flat.reshape(-1, 3, k).transpose(0, 2, 1).copy()   # -> (N, K, 3)
    opac = raw["opacity"].astype(np.float32)
    scales = col("scale_0", "scale_1", "scale_2")
    quats = quat_wxyz_to_xyzw(col("rot_0", "rot_1", "rot_2", "rot_3"))
    return SplatCloud(means=means, scales=scales, quats=quats, opacities=opac,
                      sh0=sh0, shN=shN, normals=normals)
