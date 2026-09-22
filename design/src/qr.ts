/**
 * A QR code, drawn here rather than fetched or installed.
 *
 * The studio needs exactly one QR: `https://www.m3xi.com/p/<10 characters>`,
 * which is 33 bytes. That fits a version 3 symbol at error correction level M
 * (29x29 modules, one block, 44 data codewords, 26 error codewords, so up to
 * 42 bytes in byte mode). Fixing the version to 3 removes every interleaving
 * and version-information rule from the encoder and leaves something small
 * enough to read in one sitting.
 *
 * No npm package, so nothing new on the build server and nothing third-party
 * runs on an origin that will hold creator uploads.
 *
 * Structure follows Project Nayuki's reference implementation of ISO/IEC
 * 18004, written out for this one version.
 */

const VERSION = 3;
const SIZE = 29;              // 4 * VERSION + 17
const DATA_CODEWORDS = 44;    // version 3, level M, one block
const EC_CODEWORDS = 26;
const ALIGN = [6, 22];        // alignment pattern centres for version 3
const ECL_BITS = 0;           // level M

export const QR_MAX_BYTES = 42;

/* ── GF(256), primitive polynomial 0x11D ───────────────────────────── */

function gfMul(a: number, b: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0x1ff;
    z ^= ((b >>> i) & 1) * a;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

/* ── The symbol ────────────────────────────────────────────────────── */

type Grid = boolean[][];

function blank(): Grid {
  return Array.from({ length: SIZE }, () => new Array<boolean>(SIZE).fill(false));
}

function setF(m: Grid, fn: Grid, row: number, col: number, dark: boolean): void {
  if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return;
  m[row][col] = dark;
  fn[row][col] = true;
}

function drawFinder(m: Grid, fn: Grid, row: number, col: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setF(m, fn, row + dy, col + dx, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(m: Grid, fn: Grid, row: number, col: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setF(m, fn, row + dy, col + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function formatBits(mask: number): number {
  const data = (ECL_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(m: Grid, fn: Grid, mask: number): void {
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  // First copy, around the top-left finder.
  for (let i = 0; i <= 5; i++) setF(m, fn, i, 8, bit(i));
  setF(m, fn, 7, 8, bit(6));
  setF(m, fn, 8, 8, bit(7));
  setF(m, fn, 8, 7, bit(8));
  for (let i = 9; i < 15; i++) setF(m, fn, 8, 14 - i, bit(i));
  // Second copy, split between the other two finders.
  for (let i = 0; i < 8; i++) setF(m, fn, 8, SIZE - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) setF(m, fn, SIZE - 15 + i, 8, bit(i));
  // The module that is always dark.
  setF(m, fn, SIZE - 8, 8, true);
}

function drawFunctionPatterns(m: Grid, fn: Grid): void {
  for (let i = 0; i < SIZE; i++) {
    setF(m, fn, 6, i, i % 2 === 0);
    setF(m, fn, i, 6, i % 2 === 0);
  }
  drawFinder(m, fn, 3, 3);
  drawFinder(m, fn, 3, SIZE - 4);
  drawFinder(m, fn, SIZE - 4, 3);
  // Version 3 has one alignment pattern; the other three centres sit under
  // the finders and are skipped.
  drawAlignment(m, fn, ALIGN[1], ALIGN[1]);
  drawFormat(m, fn, 0);
}

function codewords(bytes: number[]): number[] {
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);              // byte mode
  push(bytes.length, 8);        // character count, 8 bits for versions 1-9
  for (const b of bytes) push(b, 8);
  const capacity = DATA_CODEWORDS * 8;
  push(0, Math.min(4, capacity - bits.length));       // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  for (let pad = 0xec; data.length < DATA_CODEWORDS; pad ^= 0xec ^ 0x11) data.push(pad);
  return data.concat(rsRemainder(data, rsDivisor(EC_CODEWORDS)));
}

function drawCodewords(m: Grid, fn: Grid, all: number[]): void {
  let i = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < SIZE; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? SIZE - 1 - vert : vert;
        if (!fn[row][col] && i < all.length * 8) {
          m[row][col] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (col + row) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (col + row) % 3 === 0;
    case 4: return (Math.floor(col / 3) + Math.floor(row / 2)) % 2 === 0;
    case 5: return ((col * row) % 2) + ((col * row) % 3) === 0;
    case 6: return (((col * row) % 2) + ((col * row) % 3)) % 2 === 0;
    default: return (((col + row) % 2) + ((col * row) % 3)) % 2 === 0;
  }
}

function applyMask(m: Grid, fn: Grid, mask: number): void {
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      if (!fn[row][col] && maskAt(mask, row, col)) m[row][col] = !m[row][col];
    }
  }
}

/**
 * Rule 3's two shapes: the 1:1:3:1:1 finder run with four light modules on one
 * side. The quiet zone counts as light, which is why each line is padded.
 */
const D = true;
const L = false;
const FINDER_A = [D, L, D, D, D, L, D, L, L, L, L];
const FINDER_B = [L, L, L, L, D, L, D, D, D, L, D];

function penalty(m: Grid): number {
  let score = 0;
  const lineScore = (line: boolean[]): number => {
    let s = 0;
    // Rule 1: runs of five or more of one colour.
    let runLen = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) { runLen++; continue; }
      if (runLen >= 5) s += 3 + (runLen - 5);
      runLen = 1;
    }
    // Rule 3.
    const padded = [L, L, L, L, ...line, L, L, L, L];
    for (let i = 0; i + 11 <= padded.length; i++) {
      let a = true;
      let b = true;
      for (let k = 0; k < 11; k++) {
        if (padded[i + k] !== FINDER_A[k]) a = false;
        if (padded[i + k] !== FINDER_B[k]) b = false;
        if (!a && !b) break;
      }
      if (a || b) s += 40;
    }
    return s;
  };
  for (let row = 0; row < SIZE; row++) score += lineScore(m[row]);
  for (let col = 0; col < SIZE; col++) score += lineScore(m.map((r) => r[col]));
  // Rule 2: blocks of one colour.
  for (let row = 0; row < SIZE - 1; row++) {
    for (let col = 0; col < SIZE - 1; col++) {
      const c = m[row][col];
      if (c === m[row][col + 1] && c === m[row + 1][col] && c === m[row + 1][col + 1]) score += 3;
    }
  }
  // Rule 4: how far the balance of dark to light is from half.
  let dark = 0;
  for (let row = 0; row < SIZE; row++) for (let col = 0; col < SIZE; col++) if (m[row][col]) dark++;
  const total = SIZE * SIZE;
  const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
  return score + k * 10;
}

/** The modules of a QR code for `text`, as rows of booleans. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  if (bytes.length > QR_MAX_BYTES) {
    throw new Error('That is too long for this QR code (' + bytes.length + ' bytes).');
  }
  const all = codewords(bytes);
  let best: Grid | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = blank();
    const fn = blank();
    drawFunctionPatterns(m, fn);
    drawCodewords(m, fn, all);
    drawFormat(m, fn, mask);
    applyMask(m, fn, mask);
    const s = penalty(m);
    if (s < bestScore) { bestScore = s; best = m; }
  }
  return best as Grid;
}

const SVGNS = 'http://www.w3.org/2000/svg';

/**
 * The QR as an SVG element: one path of dark squares on a cream field, with
 * the four-module quiet zone the standard asks for. Built with the DOM, never
 * with innerHTML.
 */
export function qrSvg(text: string, opts?: { label?: string; light?: string; dark?: string }): SVGElement {
  const m = qrMatrix(text);
  const quiet = 4;
  const side = m.length + quiet * 2;
  let d = '';
  for (let row = 0; row < m.length; row++) {
    for (let col = 0; col < m.length; col++) {
      if (m[row][col]) d += 'M' + (col + quiet) + ' ' + (row + quiet) + 'h1v1h-1z';
    }
  }
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + side + ' ' + side);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', opts?.label || 'A code to scan with CallMe');
  const bg = document.createElementNS(SVGNS, 'rect');
  bg.setAttribute('width', String(side));
  bg.setAttribute('height', String(side));
  bg.setAttribute('fill', opts?.light || '#FFFDF8');
  svg.appendChild(bg);
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', opts?.dark || '#19150F');
  svg.appendChild(path);
  return svg;
}
