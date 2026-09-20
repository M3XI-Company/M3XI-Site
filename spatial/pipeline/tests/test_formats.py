"""PLY and SPZ header handling and round-trips."""
from __future__ import annotations

import gzip
import io
import struct

import numpy as np
import pytest

from worldengine.formats import ply, spz


def make_cloud(n=400, sh_degree=3, seed=0) -> ply.SplatCloud:
    rng = np.random.default_rng(seed)
    q = rng.normal(size=(n, 4)).astype(np.float32)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    k = {0: 0, 1: 3, 2: 8, 3: 15}[sh_degree]
    return ply.SplatCloud(
        means=rng.uniform(-6, 6, (n, 3)).astype(np.float32),
        scales=rng.uniform(-7, -1, (n, 3)).astype(np.float32),
        quats=q, opacities=rng.uniform(-5, 5, n).astype(np.float32),
        sh0=rng.uniform(-1.5, 1.5, (n, 3)).astype(np.float32),
        shN=rng.uniform(-0.4, 0.4, (n, k, 3)).astype(np.float32) if k else None)


# --- PLY --------------------------------------------------------------------

def test_ply_roundtrip_is_exact_for_float32(tmp_path):
    c = make_cloud()
    p = tmp_path / "a.ply"
    ply.write_ply(p, c)
    back = ply.read_ply(p)
    assert back.count == c.count
    assert np.array_equal(back.means, c.means)
    assert np.array_equal(back.scales, c.scales)
    assert np.array_equal(back.sh0, c.sh0)
    assert np.array_equal(back.shN, c.shN)
    assert np.allclose(np.abs((back.quats * c.quats).sum(1)), 1.0, atol=1e-6)


@pytest.mark.parametrize("deg", [0, 1, 2, 3])
def test_ply_roundtrip_all_sh_degrees(tmp_path, deg):
    c = make_cloud(120, sh_degree=deg)
    p = tmp_path / f"d{deg}.ply"
    ply.write_ply(p, c)
    back = ply.read_ply(p)
    assert back.sh_degree == deg
    if deg == 0:
        assert back.shN is None or back.shN.shape[1] == 0
    else:
        assert np.array_equal(back.shN, c.shN)


def test_ply_f_rest_is_channel_major_not_coefficient_major():
    """The ordering that trips everyone up. f_rest_0..f_rest_{k-1} are the k
    red coefficients, then green, then blue."""
    n, k = 3, 15
    shN = np.zeros((n, k, 3), np.float32)
    shN[:, 4, 1] = 7.0            # coefficient 4 of the GREEN channel
    c = ply.SplatCloud(means=np.zeros((n, 3), np.float32),
                       scales=np.zeros((n, 3), np.float32),
                       quats=np.tile([0, 0, 0, 1], (n, 1)).astype(np.float32),
                       opacities=np.zeros(n, np.float32),
                       sh0=np.zeros((n, 3), np.float32), shN=shN)
    import tempfile, pathlib
    p = pathlib.Path(tempfile.mkdtemp()) / "x.ply"
    ply.write_ply(p, c)
    with open(p, "rb") as fh:
        header, offset = ply.read_ply_header(fh)
    names = [nm for _, nm in header["properties"]]
    # green coefficient 4 lands at f_rest_{k + 4} = f_rest_19
    idx = names.index("f_rest_19")
    dtype = np.dtype([(nm, "<f4") for nm in names])
    with open(p, "rb") as fh:
        fh.seek(offset)
        rows = np.frombuffer(fh.read(dtype.itemsize * n), dtype=dtype, count=n)
    assert rows["f_rest_19"][0] == 7.0
    assert rows["f_rest_4"][0] == 0.0


def test_ply_quaternion_order_is_converted_on_the_boundary():
    """The file stores [w,x,y,z]; the contract uses [x,y,z,w]."""
    q_xyzw = np.array([[0.1, 0.2, 0.3, 0.927]], dtype=np.float32)
    wxyz = ply.quat_xyzw_to_wxyz(q_xyzw)
    assert np.allclose(wxyz[0], [0.927, 0.1, 0.2, 0.3])
    assert np.allclose(ply.quat_wxyz_to_xyzw(wxyz), q_xyzw)


def test_ply_header_written_records_the_quaternion_gotcha(tmp_path):
    p = tmp_path / "h.ply"
    ply.write_ply(p, make_cloud(10))
    with open(p, "rb") as fh:
        header, _ = ply.read_ply_header(fh)
    assert any("rot_* is [w,x,y,z]" in c for c in header["comments"])
    assert header["format"] == "binary_little_endian"
    assert header["count"] == 10


def test_ply_header_rejects_ascii_and_non_ply(tmp_path):
    p = tmp_path / "ascii.ply"
    p.write_bytes(b"ply\nformat ascii 1.0\nelement vertex 1\n"
                  b"property float x\nend_header\n0.0\n")
    with pytest.raises(ValueError, match="binary_little_endian"):
        ply.read_ply(p)
    q = tmp_path / "nope.bin"
    q.write_bytes(b"NOTPLY")
    with pytest.raises(ValueError, match="not a PLY"):
        ply.read_ply(q)


def test_ply_rejects_a_non_splat_cloud(tmp_path):
    p = tmp_path / "plain.ply"
    p.write_bytes(b"ply\nformat binary_little_endian 1.0\nelement vertex 1\n"
                  b"property float x\nproperty float y\nproperty float z\n"
                  b"end_header\n" + struct.pack("<fff", 1, 2, 3))
    with pytest.raises(ValueError, match="not a gaussian splat cloud"):
        ply.read_ply(p)


def test_splat_cloud_validates_shapes():
    with pytest.raises(ValueError, match="scales must be"):
        ply.SplatCloud(means=np.zeros((5, 3), np.float32),
                       scales=np.zeros((4, 3), np.float32),
                       quats=np.zeros((5, 4), np.float32),
                       opacities=np.zeros(5, np.float32),
                       sh0=np.zeros((5, 3), np.float32))


def test_sh_degree_from_rest():
    assert ply.sh_degree_from_rest(0) == 0
    assert ply.sh_degree_from_rest(9) == 1
    assert ply.sh_degree_from_rest(45) == 3
    with pytest.raises(ValueError):
        ply.sh_degree_from_rest(7)
    with pytest.raises(ValueError):
        ply.sh_degree_from_rest(12)


# --- SPZ --------------------------------------------------------------------

def test_spz_header_fields():
    c = make_cloud(250, sh_degree=2)
    blob = spz.encode(c, fractional_bits=12, antialiased=True)
    raw = gzip.decompress(blob)
    magic, version, n, deg, frac, flags, res = spz.SPZ_HEADER.unpack_from(raw, 0)
    assert magic == spz.SPZ_MAGIC == 0x5053474E
    assert version == 2 and n == 250 and deg == 2 and frac == 12
    assert flags & spz.FLAG_ANTIALIASED and res == 0
    assert len(raw) == spz.SPZ_HEADER.size + n * (9 + 1 + 3 + 3 + 3 + 8 * 3)


def test_spz_roundtrip_within_quantisation_error():
    c = make_cloud(900)
    back, meta = spz.decode(spz.encode(c))
    assert meta["count"] == c.count and meta["shDegree"] == 3
    # Positions at 12 fractional bits: quantisation step is 1/4096 m = 0.24 mm,
    # so half a step is the bound. Well inside the 50 mm wall tolerance.
    assert np.abs(back.means - c.means).max() < 1.0 / 4096.0
    # Opacity is stored as an 8-bit alpha, so compare in alpha space.
    sig = lambda x: 1 / (1 + np.exp(-x))
    assert np.abs(sig(back.opacities) - sig(c.opacities)).max() < 1.5 / 255.0
    assert np.abs(back.scales - c.scales).max() < 1.0 / 32.0
    assert np.abs(np.abs((back.quats * c.quats).sum(1)) - 1.0).max() < 0.01


@pytest.mark.parametrize("deg", [0, 1, 2, 3])
def test_spz_all_sh_degrees(deg):
    c = make_cloud(64, sh_degree=deg)
    back, meta = spz.decode(spz.encode(c))
    assert meta["shDegree"] == deg
    assert back.count == 64
    if deg:
        assert back.shN.shape == c.shN.shape
        assert np.abs(back.shN - c.shN).max() < 0.15


def test_spz_is_substantially_smaller_than_ply(tmp_path):
    c = make_cloud(20_000)
    p = tmp_path / "big.ply"
    ply_bytes = ply.write_ply(p, c)
    spz_bytes = len(spz.encode(c))
    assert spz_bytes * 5 < ply_bytes, (spz_bytes, ply_bytes)


def test_spz_encoding_is_deterministic():
    """Byte-identical rebuilds are what make the worker's checksum-keyed
    upload able to skip a re-upload."""
    c = make_cloud(500)
    assert spz.encode(c) == spz.encode(c)


def test_spz_quaternion_sign_is_canonicalised():
    """Only xyz is stored and w is recovered non-negative, so a quaternion with
    w < 0 must be negated before the w is dropped."""
    q = np.array([[0.2, -0.3, 0.1, -0.927]], dtype=np.float32)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    c = ply.SplatCloud(means=np.zeros((1, 3), np.float32),
                       scales=np.full((1, 3), -3.0, np.float32), quats=q,
                       opacities=np.zeros(1, np.float32),
                       sh0=np.zeros((1, 3), np.float32))
    back, _ = spz.decode(spz.encode(c))
    assert back.quats[0, 3] >= 0
    assert abs(abs(float((back.quats[0] * q[0]).sum())) - 1.0) < 0.02


def test_spz_rejects_a_world_outside_fixed_point_range():
    c = make_cloud(4)
    c.means[0, 0] = 5000.0            # 5 km from the datum
    with pytest.raises(ValueError, match="24-bit fixed-point range"):
        spz.encode(c)


def test_spz_rejects_bad_magic_and_version():
    raw = bytearray(gzip.decompress(spz.encode(make_cloud(4))))
    bad = bytearray(raw)
    struct.pack_into("<I", bad, 0, 0xDEADBEEF)
    with pytest.raises(ValueError, match="not an SPZ file"):
        spz.decode(gzip.compress(bytes(bad)))
    bad2 = bytearray(raw)
    struct.pack_into("<I", bad2, 4, 99)
    with pytest.raises(ValueError, match="unsupported SPZ version"):
        spz.decode(gzip.compress(bytes(bad2)))


def test_spz_rejects_a_truncated_body():
    raw = gzip.decompress(spz.encode(make_cloud(100)))
    with pytest.raises(ValueError, match="truncated"):
        spz.decode(gzip.compress(raw[:-50]))


def test_spz_peek_reads_the_header_without_decoding(tmp_path):
    c = make_cloud(777, sh_degree=1)
    p = tmp_path / "w.spz"
    spz.write_spz(p, c)
    meta = spz.peek(p)
    assert meta == {"version": 2, "count": 777, "shDegree": 1,
                    "fractionalBits": 12, "antialiased": True}


def test_spz_fractional_bits_trade_range_for_precision():
    c = make_cloud(50)
    fine, _ = spz.decode(spz.encode(c, fractional_bits=16))
    coarse, _ = spz.decode(spz.encode(c, fractional_bits=8))
    assert np.abs(fine.means - c.means).max() < np.abs(coarse.means - c.means).max()


def test_i24_packing_handles_negatives():
    vals = np.array([0, 1, -1, (1 << 23) - 1, -(1 << 23)], dtype=np.int64)
    packed = spz._pack_i24(vals)
    assert len(packed) == 5 * 3
    assert np.array_equal(spz._unpack_i24(packed, 5), vals)
