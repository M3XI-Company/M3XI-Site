/* ===========================================================================
   scanfacts.js — what a room scan IS, worked out once.

   A Gaussian-splat scan arrives as a few hundred thousand points and nothing
   else: no floor, no walls, no "up". Everything a walker needs has to be
   measured. Until now that measurement happened in every visitor's browser on
   every page load, with the answers differing between visits and no human ever
   seeing them. Here it runs once, when the agent attaches the scan, and the
   result is stored beside it. The viewer reads; it never guesses.

   The maths is ported from public/studio/walkthrough.html, where it was tuned
   against real phone scans over many painful iterations. The comments there
   record what each rule is defending against; the important ones are carried
   over, because every one of them is a bug someone actually shipped.

   Pure and portable: no DOM, no WebGL, no imports. Runs in a worker, in the
   page, and in node.

   CONVENTION. `facts.up = {axis, sign}` is the rotation a renderer must apply
   so that sign*axis becomes +Y. EVERY other number in facts — floor_y, spawn,
   the grid's minx/minz and all floorY/ceilY values — is already expressed in
   that rotated, Y-up frame. Rotate first, then use the facts as they stand.
   =========================================================================== */

/* The body we are making room for, in metres. */
export const KNEE = 0.35;        // a band from knee to head that must be clear
export const HEAD = 1.50;        //   to call a cell walkable
export const STEP_UP = 0.38;     // a stair tread, not a wall
export const BODY_R = 0.20;      // shoulder half-width of a standing person
export const MIN_USABLE_M2 = 2;  // below a doorway landing there is nowhere to go
const MAX_CELLS = 140000;        // keeps the per-cell height histogram sane
const FACTS_VERSION = 1;

/* ---------------------------------------------------------------- utilities */

const isNum = (v) => typeof v === "number" && v === v && Number.isFinite(v);

function b64encode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (typeof Buffer !== "undefined" && Buffer.from) return Buffer.from(u8).toString("base64");
  let s = "";
  const CHUNK = 0x8000;   // apply() has an argument limit; chunk under it
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  return btoa(s);
}
function b64decode(str) {
  if (typeof Buffer !== "undefined" && Buffer.from) {
    const b = Buffer.from(str, "base64");
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice();
  }
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
// Typed arrays go over the wire little-endian, which is every platform this
// runs on. Stated rather than assumed silently.
const packF32 = (a) => b64encode(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
const packU8 = (a) => b64encode(a);
const unpackF32 = (s) => { const u = b64decode(s); return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4); };
const unpackU8 = (s) => b64decode(s);

/* ------------------------------------------------------- up-axis and floors */

/* A room's points pile into one thin dense slab at the floor; along the other
   two axes the spread is broad. The sharpest peak names the up-axis. */
export function axisProfile(vals) {
  const v = Float64Array.from(vals).sort();
  if (v.length < 3) return { peakFrac: 0, peakAt: 0, span: 1 };
  const lo = v[Math.floor(v.length * 0.01)], hi = v[Math.floor(v.length * 0.99)];
  const span = (hi - lo) || 1, B = 100, h = new Float64Array(B);
  for (let i = 0; i < v.length; i++) {
    let b = Math.floor((v[i] - lo) / span * B);
    if (b < 0) b = 0; if (b >= B) b = B - 1;
    h[b]++;
  }
  let peak = 0, peakBin = 0;
  for (let b = 0; b < B; b++) if (h[b] > peak) { peak = h[b]; peakBin = b; }
  return { peakFrac: peak / v.length, peakAt: peakBin / B, span };
}

/* Score a vertical histogram for "is there a room here, and where is its
   floor". A floor is a dense slab with clear headroom above it AND a ceiling
   above that. Requiring the ceiling is what keeps a visitor off the roof: above
   a roof there is sky, sky is empty, and dividing by empty headroom made the
   roof outscore every real floor — which is exactly how the office scan once
   opened with the visitor standing on top of the building. */
export function roomScore(hist, lo, bin) {
  const B = hist.length;
  let total = 0;
  for (let i = 0; i < B; i++) total += hist[i];
  if (total <= 0) return { score: 0, floorY: NaN, indoor: false };
  const at = (y) => { const b = Math.round((y - lo) / bin); return (b < 0 || b >= B) ? 0 : hist[b] / total; };
  const band = (y0, y1) => { let s = 0, n = 0; for (let y = y0; y <= y1; y += bin) { s += at(y); n++; } return n ? s / n : 0; };
  const peak = (y0, y1) => { let m = 0; for (let y = y0; y <= y1; y += bin) m = Math.max(m, at(y)); return m; };
  let best = { score: 0, floorY: NaN, indoor: false };
  let lowestSlab = NaN;
  const hiY = lo + B * bin;
  for (let b = 0; b < B; b++) {
    const f = lo + b * bin;
    if (f > lo + (hiY - lo) * 0.7) break;      // a floor is not up in the roof space
    const floorD = at(f) + at(f + bin);
    if (floorD < 0.004) continue;              // too sparse to be a surface
    if (lowestSlab !== lowestSlab) lowestSlab = f;
    const head = band(f + 0.45, f + 1.65);     // must be clear: a body stands here
    const ceil = peak(f + 2.0, f + 3.6);       // and a room has a lid
    if (ceil < Math.max(0.0015, floorD * 0.10)) continue;
    const score = floorD * ceil / Math.max(head, 0.0025);
    if (score > best.score) best = { score, floorY: f, indoor: true };
  }
  if (best.indoor) return best;
  // Nothing room-shaped. Stand on the LOWEST real surface — the ground — and
  // never the highest, which is the roof.
  return { score: lowestSlab === lowestSlab ? 0.0005 : 0, floorY: lowestSlab, indoor: false };
}

export function scoreHeights(vals) {
  if (!vals || vals.length < 200) return { score: 0, floorY: NaN };
  const s = Float64Array.from(vals).sort();
  const lo = s[Math.floor(s.length * 0.005)], hi = s[Math.floor(s.length * 0.995)];
  const span = (hi - lo) || 1;
  const bin = Math.max(0.05, span / 220);
  const B = Math.ceil(span / bin) + 1;
  const h = new Float64Array(B);
  for (let i = 0; i < s.length; i++) { const b = Math.floor((s[i] - lo) / bin); if (b >= 0 && b < B) h[b]++; }
  return roomScore(h, lo, bin);
}

/* Six candidates: three axes, both directions. Upside down the ceiling ends up
   under the visitor's feet, so the right way up wins clearly.

   The costs are wildly asymmetric. Leaving an already-upright scan alone is
   free; rotating an upright scan is catastrophic — the room hangs from its own
   ceiling. Y-up is the incumbent and only a decisive margin unseats it. */
/* WHICH SIDE OF THAT PLANE IS THE FLOOR.

   Room-shape alone cannot tell: turn a room upside down and its ceiling is
   every bit as flat and open as its floor, with the real floor 2.4 m above
   playing the part of the ceiling. Measured on a plain test room the inverted
   reading actually scores HIGHER (5.56 against 4.52), so scoring alone hangs
   the room from its own ceiling.

   Gravity settles it. Things REST on a floor and hang from nothing, so the
   half-metre above a real floor is full of furniture while the half-metre
   below a ceiling is air. Returns mass-just-above-floor / mass-just-below-top;
   the upright reading is the one where that ratio is larger. */
function restingMassRatio(heights, floorY) {
  const n = heights.length;
  if (!n || floorY !== floorY) return 1;
  const sorted = Float64Array.from(heights).sort();
  const top = sorted[Math.floor(n * 0.995)];
  let rest = 0, hang = 0;
  for (let i = 0; i < n; i++) {
    const h = heights[i];
    if (h >= floorY + 0.05 && h <= floorY + 0.55) rest++;
    if (h >= top - 0.55 && h <= top - 0.05) hang++;
  }
  return (rest + 1) / (hang + 1);
}

export function detectUp(positions, opts = {}) {
  const n = (positions.length / 3) | 0;
  if (n < 1000) return { axis: "y", sign: 1, decisive: false, margin: 1, reason: "too few points to tell which way is up" };
  const step = Math.max(1, Math.floor(n / 80000));
  const X = [], Y = [], Z = [];
  for (let i = 0; i < n; i += step) { X.push(positions[i * 3]); Y.push(positions[i * 3 + 1]); Z.push(positions[i * 3 + 2]); }
  const byAxis = { x: X, y: Y, z: Z };
  const cands = [];
  for (const [axis, arr] of [["x", X], ["y", Y], ["z", Z]]) {
    for (const sign of [1, -1]) {
      const heights = sign === 1 ? arr : arr.map((v) => -v);
      const r = scoreHeights(heights);
      cands.push({ axis, sign, score: r.score, floorY: r.floorY });
    }
  }
  cands.sort((a, b) => b.score - a.score);

  // The axis is decided by room shape; the DIRECTION along it is decided by
  // gravity, because the two directions are near-mirror images and the scores
  // routinely favour the wrong one.
  const axis = cands[0].axis;
  const pair = cands.filter((c) => c.axis === axis);
  const arr = byAxis[axis];
  let win = pair[0];
  let flipReason = null;
  if (pair.length === 2 && pair[0].score < pair[1].score * 3) {
    const ratios = pair.map((c) => restingMassRatio(c.sign === 1 ? arr : arr.map((v) => -v), c.floorY));
    if (ratios[1] > ratios[0]) { win = pair[1]; flipReason = "gravity"; }
    win.restRatio = ratios[win === pair[0] ? 0 : 1];
    win.restRatioOther = ratios[win === pair[0] ? 1 : 0];
  }

  const identity = cands.find((c) => c.axis === "y" && c.sign === 1) || { score: 0 };
  const MARGIN = 1.35;
  const decisive = win.score > identity.score * MARGIN;
  const chosen = decisive ? win : { axis: "y", sign: 1, score: identity.score };
  return {
    axis: chosen.axis, sign: chosen.sign, score: chosen.score, decisive,
    margin: identity.score > 0 ? +(win.score / identity.score).toFixed(2) : 99,
    settled_by: flipReason || "room shape",
    rest_ratio: win.restRatio != null ? +win.restRatio.toFixed(2) : null,
    rest_ratio_other: win.restRatioOther != null ? +win.restRatioOther.toFixed(2) : null,
    profiles: { x: axisProfile(X), y: axisProfile(Y), z: axisProfile(Z) },
    candidates: cands.slice(0, 3),
  };
}

/* The rotation taking sign*axis onto +Y, as a plain function and as a
   quaternion a three.js caller can use directly. All six are proper rotations
   (determinant +1) — a mirrored one would make the room read inside out. */
export function rotateToY(up, x, y, z) {
  const s = up && up.sign === -1 ? -1 : 1;
  switch ((up && up.axis) || "y") {
    case "x": return s === 1 ? [-y, x, z] : [y, -x, z];
    case "z": return s === 1 ? [x, z, -y] : [x, -z, y];
    default:  return s === 1 ? [x, y, z] : [x, -y, -z];
  }
}
export function upQuaternion(up) {
  const H = Math.SQRT1_2;
  const s = up && up.sign === -1 ? -1 : 1;
  switch ((up && up.axis) || "y") {
    case "x": return s === 1 ? { x: 0, y: 0, z: H, w: H } : { x: 0, y: 0, z: -H, w: H };
    case "z": return s === 1 ? { x: -H, y: 0, z: 0, w: H } : { x: H, y: 0, z: 0, w: H };
    default:  return s === 1 ? { x: 0, y: 0, z: 0, w: 1 } : { x: 1, y: 0, z: 0, w: 0 };
  }
}

/* ------------------------------------------------------------ grid builders */

/* A wall is a RUN of cells, not a speck. */
function keepWallRuns(solid, w, h, minRun) {
  const N = w * h, seen = new Uint8Array(N), stack = [];
  for (let s0 = 0; s0 < N; s0++) {
    if (seen[s0] || !solid[s0]) continue;
    const comp = []; stack.length = 0; stack.push(s0); seen[s0] = 1;
    while (stack.length) {
      const i = stack.pop(); comp.push(i);
      const x = i % w, z = (i / w) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const X = x + dx, Z = z + dz;
        if (X < 0 || Z < 0 || X >= w || Z >= h) continue;
        const j = Z * w + X;
        if (seen[j] || !solid[j]) continue;
        seen[j] = 1; stack.push(j);
      }
    }
    if (comp.length < minRun) for (const i of comp) solid[i] = 0;
  }
}

/* Lone solid cells are scan speckle; a one-cell hole in a wall is not a
   doorway. Promoting speckle to geometry is where "invisible collider" comes
   from: something blocks you and there is nothing there to see. */
function despeckle(solid, w, h) {
  const src = solid.slice();
  const nb = (x, z) => {
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const X = x + dx, Z = z + dz;
      if (X < 0 || Z < 0 || X >= w || Z >= h) continue;
      if (src[Z * w + X]) n++;
    }
    return n;
  };
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const i = z * w + x, n = nb(x, z);
    if (src[i] && n <= 1) solid[i] = 0;
    else if (!src[i] && n >= 7) solid[i] = 1;
  }
}

/* Chamfer distance in cells to the nearest blocked cell: two passes, O(cells). */
function clearanceCells(solid, w, h) {
  const N = w * h, D = 1, D2 = 1.41421356, INF = 1e9, d = new Float32Array(N);
  for (let i = 0; i < N; i++) d[i] = solid[i] ? 0 : INF;
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    const i = z * w + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + D);
    if (z > 0) v = Math.min(v, d[i - w] + D);
    if (x > 0 && z > 0) v = Math.min(v, d[i - w - 1] + D2);
    if (x < w - 1 && z > 0) v = Math.min(v, d[i - w + 1] + D2);
    d[i] = v;
  }
  for (let z = h - 1; z >= 0; z--) for (let x = w - 1; x >= 0; x--) {
    const i = z * w + x; let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + D);
    if (z < h - 1) v = Math.min(v, d[i + w] + D);
    if (x < w - 1 && z < h - 1) v = Math.min(v, d[i + w + 1] + D2);
    if (x > 0 && z < h - 1) v = Math.min(v, d[i + w - 1] + D2);
    d[i] = v;
  }
  return d;
}

/* Biggest set of body-sized cells whose floors connect by steps, not cliffs. */
function largestRegion(walk, floorY, w, h) {
  const N = w * h, seen = new Uint8Array(N), mask = new Uint8Array(N);
  let best = 0; const stack = [];
  for (let s = 0; s < N; s++) {
    if (seen[s] || !walk[s]) continue;
    let n = 0; const comp = []; stack.length = 0; stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(); comp.push(i); n++;
      const x = i % w, z = (i / w) | 0, fy = floorY[i];
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + d[0], Z = z + d[1];
        if (X < 0 || Z < 0 || X >= w || Z >= h) continue;
        const j = Z * w + X;
        if (seen[j] || !walk[j]) continue;
        if (Math.abs(floorY[j] - fy) > STEP_UP) continue;   // a cliff is not a connection
        seen[j] = 1; stack.push(j);
      }
    }
    if (n > best) { best = n; mask.fill(0); for (const i of comp) mask[i] = 1; }
  }
  return { mask, cells: best };
}

/* ------------------------------------------------------------- the measurer */

/**
 * @param positions Float32Array|Array of interleaved xyz, in the file's own frame
 * @param opts {progress?:(stage,detail)=>void, eye?:number, scanned_at?:string, source?:object}
 */
export function computeFacts(positions, opts = {}) {
  const say = typeof opts.progress === "function" ? opts.progress : () => {};
  const warnings = [];
  const total = (positions.length / 3) | 0;
  if (total < 3000) {
    return failed(`this scan holds only ${total.toLocaleString()} points — too sparse to stand on`, warnings, opts);
  }

  say("up", "working out which way is up");
  const up = detectUp(positions);
  if (!up.decisive) warnings.push("Which way is up was not obvious, so the scan is being taken as it came. If the room appears on its side, re-export it from the scanner.");

  say("rotate", `rotating ${total.toLocaleString()} points upright`);
  const P = new Float32Array(total * 3);
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, minz = Infinity, maxz = -Infinity;
  for (let i = 0; i < total; i++) {
    const r = rotateToY(up, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    P[i * 3] = r[0]; P[i * 3 + 1] = r[1]; P[i * 3 + 2] = r[2];
    if (r[0] < minx) minx = r[0]; if (r[0] > maxx) maxx = r[0];
    if (r[1] < miny) miny = r[1]; if (r[1] > maxy) maxy = r[1];
    if (r[2] < minz) minz = r[2]; if (r[2] > maxz) maxz = r[2];
  }

  say("grid", "measuring the floor");
  // Fine enough for doorways, coarse enough to keep the grid small.
  let cs = 0.16;
  let w = Math.ceil((maxx - minx) / cs) + 2, h = Math.ceil((maxz - minz) / cs) + 2;
  while (w * h > MAX_CELLS) { cs *= 1.35; w = Math.ceil((maxx - minx) / cs) + 2; h = Math.ceil((maxz - minz) / cs) + 2; }
  if (w < 4 || h < 4) return failed("this scan covers too little ground to walk on", warnings, opts, up);
  const N = w * h;

  // A vertical histogram per cell — a percentile without keeping every point.
  const yspan = Math.max(0.5, maxy - miny);
  const B = Math.max(8, Math.min(48, Math.ceil(yspan / 0.10)));
  const ybin = yspan / B;
  const hist = new Uint16Array(N * B);
  const cnt = new Uint32Array(N);
  for (let i = 0; i < total; i++) {
    const gx = ((P[i * 3] - minx) / cs) | 0, gz = ((P[i * 3 + 2] - minz) / cs) | 0;
    if (gx < 0 || gz < 0 || gx >= w || gz >= h) continue;
    const ii = gz * w + gx;
    let b = ((P[i * 3 + 1] - miny) / ybin) | 0;
    if (b < 0) b = 0; if (b >= B) b = B - 1;
    const c = hist[ii * B + b]; if (c < 65535) hist[ii * B + b] = c + 1;
    cnt[ii]++;
  }

  // Haze rejection: a real surface leaves a dense column of points, a floater
  // two or three.
  let med = 0;
  {
    const occ = [];
    for (let i = 0; i < N; i++) if (cnt[i] > 0) occ.push(cnt[i]);
    occ.sort((a, b) => a - b);
    med = occ.length ? occ[occ.length >> 1] : 0;
  }
  const MIN_CELL = Math.max(3, Math.floor(med * 0.12));

  const floorY = new Float32Array(N).fill(NaN);
  let occupied = 0;
  for (let i = 0; i < N; i++) {
    const c = cnt[i]; if (c < MIN_CELL) continue;
    const want = Math.max(1, Math.floor(c * 0.15));
    let run = 0, b = 0;
    for (; b < B; b++) { run += hist[i * B + b]; if (run >= want) break; }
    floorY[i] = miny + (Math.min(b, B - 1) + 0.5) * ybin;
    occupied++;
  }
  if (occupied < 12) return failed("no continuous floor was found in this scan", warnings, opts, up);

  // The ground plane, measured by how many POINTS sit at each height rather
  // than how many cells do: a floor owns more points than anything else, while
  // a sparse outdoor halo can own more cells.
  let groundY = NaN;
  {
    const g = new Float64Array(B);
    for (let i = 0; i < N; i++) { if (cnt[i] < MIN_CELL) continue; for (let b = 0; b < B; b++) g[b] += hist[i * B + b]; }
    const r = roomScore(g, miny + ybin * 0.5, ybin);
    if (r.score > 0) groundY = r.floorY;
    else {
      // Outdoors: the ground is the LOWEST slab carrying real mass, never
      // merely the densest — a street's rooftops outweigh its street.
      let gv = -1; for (let b = 0; b < B; b++) if (g[b] > gv) gv = g[b];
      const bar = gv * 0.30;
      for (let b = 0; b < B; b++) if (g[b] >= bar) { groundY = miny + (b + 0.5) * ybin; break; }
      warnings.push("No ceiling was found, so this reads as an outdoor or open space rather than a room.");
    }
  }

  say("walls", "checking what you can walk on");
  const bandFrac = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const c = cnt[i], f = floorY[i];
    if (c < MIN_CELL || f !== f) continue;
    const b0 = Math.max(0, Math.min(B - 1, ((f + KNEE - miny) / ybin) | 0));
    const b1 = Math.max(0, Math.min(B - 1, ((f + HEAD - miny) / ybin) | 0));
    let band = 0; for (let b = b0; b <= b1; b++) band += hist[i * B + b];
    bandFrac[i] = band / c;
  }

  // Self-tuning: a cluttered room and an empty hall do not share one magic
  // number. Take enough structure to enclose the space, then as much room to
  // explore as possible — maximising open space alone was the wrong objective
  // and it let people walk through walls.
  let best = null;
  for (const thr of [0.30, 0.45, 0.60, 0.75, 0.88, 0.96]) {
    const solid = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (cnt[i] >= MIN_CELL && floorY[i] === floorY[i] && bandFrac[i] >= thr) solid[i] = 1;
    despeckle(solid, w, h);
    keepWallRuns(solid, w, h, 6);
    const clear = clearanceCells(solid, w, h);
    const need = BODY_R / cs;
    const walk = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (!solid[i] && cnt[i] >= MIN_CELL && floorY[i] === floorY[i] && clear[i] >= need) walk[i] = 1;
    const reg = largestRegion(walk, floorY, w, h);
    let nSolid = 0; for (let i = 0; i < N; i++) if (solid[i]) nSolid++;
    const hasStructure = nSolid >= Math.max(4, occupied * 0.01);

    /* IS THE SPACE ACTUALLY ENCLOSED?

       "Enough structure" used to mean a flat 2% of occupied cells, which is far
       below what it takes to shut a room in. On a plain 4x5 m test room the
       ladder could therefore keep a threshold that dissolved the walls to 24
       stray cells, still clear the 2% bar, and win on area — reporting 20.2 m2
       of walking in a room whose entire floor is 20 m2. In other words the
       visitor could stroll straight through the walls, which is exactly the
       failure the threshold ladder exists to prevent.

       The bar is now geometric rather than magic: a region needs roughly half
       its own perimeter in solid cells before it counts as enclosed. Derived
       from the region's bounding box, so it scales with the room instead of
       with how much halo the scan happens to carry. */
    let bx0 = w, bx1 = -1, bz0 = h, bz1 = -1;
    for (let i = 0; i < N; i++) {
      if (!reg.mask[i]) continue;
      const gx = i % w, gz = (i / w) | 0;
      if (gx < bx0) bx0 = gx; if (gx > bx1) bx1 = gx;
      if (gz < bz0) bz0 = gz; if (gz > bz1) bz1 = gz;
    }
    const perim = bx1 >= bx0 ? (bx1 - bx0 + 1) + (bz1 - bz0 + 1) : 0;
    const enough = nSolid >= Math.max(12, perim);

    let better;
    if (!best) better = true;
    else if (enough !== (best.enough)) better = enough;   // enclosure first
    else better = reg.cells > best.reg.cells;             // then room to walk
    if (better) best = { thr, solid, walk, reg, hasStructure, nSolid, enough, perim };
  }
  if (!best.hasStructure) warnings.push("No walls were found in this scan, so nothing will stop you walking out of the room. It may not be level, or the capture may be missing its edges.");
  else if (!best.enough) warnings.push("The walls in this scan do not fully enclose the space, so it is possible to walk out through a gap the camera never captured.");

  // The ceiling, per cell: the first meaningfully occupied band above the
  // floor's head band. Without it, jumping put your head through the roof.
  const ceilY = new Float32Array(N).fill(NaN);
  for (let i = 0; i < N; i++) {
    const c = cnt[i], f = floorY[i];
    if (c < MIN_CELL || f !== f) continue;
    const from = Math.max(0, Math.min(B - 1, ((f + HEAD + 0.30 - miny) / ybin) | 0));
    const need = Math.max(2, Math.floor(c * 0.02));   // a shelf edge is not a ceiling
    for (let b = from; b < B; b++) if (hist[i * B + b] >= need) { ceilY[i] = miny + b * ybin; break; }
  }

  // Eye clutter per cell: standing room and seeing room are different things.
  // The spawner reads this to put people somewhere with a view.
  const eye = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const c = cnt[i], f = floorY[i];
    if (c < MIN_CELL || f !== f) continue;
    const e0 = Math.max(0, Math.min(B - 1, ((f + 1.25 - miny) / ybin) | 0));
    const e1 = Math.max(0, Math.min(B - 1, ((f + 1.85 - miny) / ybin) | 0));
    let e = 0; for (let b = e0; b <= e1; b++) e += hist[i * B + b];
    eye[i] = e / c;
  }

  // How much of the walkable region's own bounding box is simply MISSING —
  // the gaps behind furniture the camera never saw. We report them; we never
  // fill them.
  let holePct = 0;
  {
    let x0 = w, x1 = -1, z0 = h, z1 = -1;
    for (let i = 0; i < N; i++) {
      if (!best.reg.mask[i]) continue;
      const gx = i % w, gz = (i / w) | 0;
      if (gx < x0) x0 = gx; if (gx > x1) x1 = gx;
      if (gz < z0) z0 = gz; if (gz > z1) z1 = gz;
    }
    if (x1 >= x0) {
      let tot = 0, hole = 0;
      for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) { tot++; if (cnt[gz * w + gx] < MIN_CELL) hole++; }
      holePct = tot ? +(100 * hole / tot).toFixed(1) : 0;
    }
  }

  const areaM2 = +(best.reg.cells * cs * cs).toFixed(1);
  const usable = areaM2 >= MIN_USABLE_M2;
  if (!usable) warnings.push(`Only ${areaM2} m² of this scan can be walked on, which is less than a doorway landing. Re-scan the room slowly, keeping the floor in view.`);

  const grid = { w, h, cell: +cs.toFixed(4), minx, minz, floorY, ceilY, walk: best.walk, solid: best.solid, reach: best.reg.mask };
  const spawn = chooseSpawn(grid, eye, groundY);
  if (!spawn) warnings.push("No sensible place to stand was found, so the tour will start at the middle of the scan.");

  return {
    version: FACTS_VERSION,
    source: opts.source || null,
    up: { axis: up.axis, sign: up.sign },
    floor_y: isNum(groundY) ? +groundY.toFixed(3) : (spawn ? spawn.y : 0),
    eye: isNum(opts.eye) ? opts.eye : 1.6,
    spawn: spawn || { x: (minx + maxx) / 2, y: isNum(groundY) ? groundY : miny, z: (minz + maxz) / 2, yaw: 0 },
    grid,
    area_m2: areaM2,
    holes_pct: holePct,
    walls: best.nSolid,
    usable,
    warnings,
    diagnostics: {
      splats: total, sampled: total, threshold: best.thr, occupied_cells: occupied,
      enclosed: !!best.enough, solid_cells: best.nSolid, perimeter_needed: best.perim,
      up_margin: up.margin, up_decisive: up.decisive, up_settled_by: up.settled_by,
      up_rest_ratio: up.rest_ratio, up_rest_ratio_other: up.rest_ratio_other,
      up_profiles: { x: +up.profiles.x.peakFrac.toFixed(3), y: +up.profiles.y.peakFrac.toFixed(3), z: +up.profiles.z.peakFrac.toFixed(3) },
      bbox: { minx: +minx.toFixed(2), maxx: +maxx.toFixed(2), miny: +miny.toFixed(2), maxy: +maxy.toFixed(2), minz: +minz.toFixed(2), maxz: +maxz.toFixed(2) },
      ground_y: isNum(groundY) ? +groundY.toFixed(3) : null,
    },
    computed_at: opts.now || new Date().toISOString(),
  };
}

function failed(reason, warnings, opts, up) {
  return {
    version: FACTS_VERSION, source: opts.source || null,
    up: up ? { axis: up.axis, sign: up.sign } : { axis: "y", sign: 1 },
    floor_y: 0, eye: isNum(opts.eye) ? opts.eye : 1.6,
    spawn: { x: 0, y: 0, z: 0, yaw: 0 },
    grid: { w: 0, h: 0, cell: 0.16, minx: 0, minz: 0, floorY: new Float32Array(0), ceilY: new Float32Array(0), walk: new Uint8Array(0), solid: new Uint8Array(0), reach: new Uint8Array(0) },
    area_m2: 0, holes_pct: 0, walls: 0, usable: false,
    warnings: warnings.concat([reason]),
    diagnostics: { failed: reason },
    computed_at: opts.now || new Date().toISOString(),
  };
}

/* Where to put someone when they arrive. Central AND clear-sighted: a cell in
   the middle of two metres of grass is legal to stand in and useless to spawn
   in, and the biggest connected patch is not reliably the floor you should
   stand on — on the office scan it once put the visitor 3.2 m up, inside the
   furniture. Prefer cells sitting on the measured ground plane. */
export function chooseSpawn(grid, eye, groundY) {
  const { w, h, cell: cs, minx, minz, floorY } = grid;
  const N = w * h;
  if (!N) return null;
  /* Stand them inside the region we ADVERTISE. area_m2 is measured from
     `reach` — the largest patch whose floors connect by steps — so spawning
     from the looser `walk` mask could drop a buyer on a cell that is not part
     of the space they were promised. Measured on the real office scan: the
     old choice landed on a cell with walk=1 and reach=0. */
  const walk = (grid.reach && grid.reach.length === N && grid.reach.some((v) => v)) ? grid.reach : grid.walk;
  const onGround = isNum(groundY) ? (i) => { const f = floorY[i]; return f === f && Math.abs(f - groundY) <= 0.5; } : (i) => floorY[i] === floorY[i];
  let sx = 0, sz = 0, n = 0;
  for (let i = 0; i < N; i++) { if (!walk[i] || !onGround(i)) continue; sx += minx + ((i % w) + 0.5) * cs; sz += minz + (((i / w) | 0) + 0.5) * cs; n++; }
  if (!n) return null;
  const cx = sx / n, cz = sz / n;
  const diag2 = (w * cs) * (w * cs) + (h * cs) * (h * cs);
  let bi = -1, bs = Infinity;
  for (let i = 0; i < N; i++) {
    if (!walk[i] || !onGround(i)) continue;
    const x = minx + ((i % w) + 0.5) * cs, z = minz + (((i / w) | 0) + 0.5) * cs;
    const d = ((x - cx) * (x - cx) + (z - cz) * (z - cz)) / diag2;
    const s = d + (eye ? eye[i] * 3 : 0);
    if (s < bs) { bs = s; bi = i; }
  }
  if (bi < 0) return null;
  return {
    x: +(minx + ((bi % w) + 0.5) * cs).toFixed(3),
    y: +floorY[bi].toFixed(3),
    z: +(minz + (((bi / w) | 0) + 0.5) * cs).toFixed(3),
    yaw: 0,
  };
}

/* ------------------------------------------------------------- the queries */

export function cellIndex(facts, x, z) {
  const g = facts.grid;
  if (!g || !g.w) return -1;
  const gx = ((x - g.minx) / g.cell) | 0, gz = ((z - g.minz) / g.cell) | 0;
  return (gx < 0 || gz < 0 || gx >= g.w || gz >= g.h) ? -1 : gz * g.w + gx;
}
export function cellFloor(facts, x, z) {
  const i = cellIndex(facts, x, z);
  if (i < 0) return null;
  const f = facts.grid.floorY[i];
  return f !== f ? null : f;
}
export function cellCeil(facts, x, z) {
  const i = cellIndex(facts, x, z);
  if (i < 0) return null;
  const c = facts.grid.ceilY[i];
  return c !== c ? null : c;
}
/**
 * May a body stand here? Clearance is already baked into `walk`, so this is a
 * lookup plus a step check.
 *
 * Two deliberate leniencies, both learned the hard way: a grid that found
 * almost nowhere to stand must not become a cage (refusing every step is
 * indistinguishable from the page hanging), and `walk` — not `reach` — governs
 * where you may GO, because gating on the largest region locked visitors out of
 * every side room whose doorway was judged a shade too narrow.
 */
export function canStand(facts, x, z, feetY) {
  if (!facts || !facts.grid || !facts.grid.w) return true;
  if (!facts.usable) return true;
  const i = cellIndex(facts, x, z);
  if (i < 0) return false;
  if (!walkableMask(facts)[i]) return false;
  const f = facts.grid.floorY[i];
  if (f !== f) return false;
  if (isNum(feetY) && f - feetY > STEP_UP) return false;   // stairs, one tread at a time
  return true;
}

/* WHICH CELLS A BODY MAY OCCUPY.

   `walk` is every cell with a floor and room for shoulders; `reach` is the
   largest patch of those whose floors actually connect by steps rather than
   cliffs. They can differ enormously. On the real office scan `walk` holds
   3,401 cells (87 m2) whose floors span seventeen metres — most of it the
   sparse outdoor halo a phone capture throws off — while `reach` holds 327
   cells (8.4 m2), all within a metre of the room's floor.

   The original viewer deliberately used `walk`, because gating on `reach`
   locked visitors out of side rooms whose doorway the clearance test judged a
   shade too narrow. That trade made sense for whole-building worlds. It does
   not make sense here: a Phase 2 scan is ONE ROOM, there are no side rooms to
   lose, and `area_m2` — the number the agent is shown and the buyer is
   promised — is measured from `reach`. Letting someone walk somewhere we never
   measured means walking off the floor and falling metres into scan noise.

   So: the promised region governs, and the two ends of the contract agree.
   Where a scan produced no connected region at all we fall back to `walk`
   rather than freezing the visitor in place. */
export function walkableMask(facts) {
  const g = facts.grid;
  if (g.reach && g.reach.length === g.w * g.h) {
    for (let i = 0; i < g.reach.length; i++) if (g.reach[i]) return g.reach;
  }
  return g.walk;
}

/* ------------------------------------------------------------ (de)serialise */

export function serialiseFacts(facts) {
  const g = facts.grid;
  return {
    ...facts,
    grid: {
      w: g.w, h: g.h, cell: g.cell, minx: g.minx, minz: g.minz,
      floorY: packF32(g.floorY), ceilY: packF32(g.ceilY),
      walk: packU8(g.walk), solid: packU8(g.solid), reach: packU8(g.reach),
    },
  };
}
export function deserialiseFacts(json) {
  const o = typeof json === "string" ? JSON.parse(json) : json;
  const g = o.grid || {};
  return {
    ...o,
    grid: {
      w: g.w | 0, h: g.h | 0, cell: +g.cell, minx: +g.minx, minz: +g.minz,
      floorY: typeof g.floorY === "string" ? unpackF32(g.floorY) : g.floorY,
      ceilY: typeof g.ceilY === "string" ? unpackF32(g.ceilY) : g.ceilY,
      walk: typeof g.walk === "string" ? unpackU8(g.walk) : g.walk,
      solid: typeof g.solid === "string" ? unpackU8(g.solid) : g.solid,
      reach: typeof g.reach === "string" ? unpackU8(g.reach) : g.reach,
    },
  };
}

/** What the room row stores, and what the dashboard shows the agent. */
export function factsSummary(facts) {
  return {
    area_m2: facts.area_m2,
    holes_pct: facts.holes_pct,
    usable: !!facts.usable,
    up: facts.up.axis + (facts.up.sign === -1 ? "-" : "+"),
  };
}

export default { computeFacts, walkableMask, serialiseFacts, deserialiseFacts, canStand, cellFloor, cellCeil, cellIndex, upQuaternion, rotateToY, factsSummary, detectUp, KNEE, HEAD, STEP_UP, BODY_R };
