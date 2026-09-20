/**
 * A minimal, dependency-free ZIP writer.
 *
 * Why write one rather than pull a library in: this file runs in a Deno edge
 * function and its output is the artefact the permanence promise rests on. A
 * customer who leaves must be able to open their bundle in ten years with
 * whatever unzip they have. That argues for the oldest, dullest possible
 * format -- STORE, no compression, no ZIP64, no encryption, no extra fields --
 * and for code we can read in one sitting rather than a transitive tree we
 * cannot audit.
 *
 * Splats and meshes are already compressed; deflating them again would buy
 * almost nothing and cost CPU in a function with a wall-clock budget. Text
 * files are small. So STORE is not a shortcut here, it is the right choice.
 *
 * The one real limit: ZIP without ZIP64 cannot address beyond 4 GiB, and the
 * writer refuses rather than emitting a corrupt archive.
 */

const MAX_ARCHIVE_BYTES = 0xFFFF_FFFF;

/** Standard CRC-32 (IEEE 802.3), table built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB8_8320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xFFFF_FFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xFF]! ^ (c >>> 8);
  }
  return (c ^ 0xFFFF_FFFF) >>> 0;
}

export interface ZipEntry {
  /** Forward slashes only, no leading slash, no "..". */
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Defaults to the archive's build time. */
  readonly modified?: Date;
}

interface Placed {
  path: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

const encoder = new TextEncoder();

/**
 * Reject anything that could escape the extraction directory. Zip-slip is
 * decades old and still works, and this archive is opened by people we will
 * never meet on machines we will never see.
 */
function normalisePath(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (p.length === 0 || p.length > 512) throw new Error(`bad zip path: '${path}'`);
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error(`unsafe zip path: '${path}'`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(p)) throw new Error(`control character in zip path: '${path}'`);
  return p;
}

function dosDateTime(d: Date): { dosTime: number; dosDate: number } {
  // MS-DOS timestamps start in 1980 and have two-second resolution.
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    dosTime: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    dosDate: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export function buildZip(entries: readonly ZipEntry[], now: Date = new Date()): Uint8Array {
  const placed: Placed[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const e of entries) {
    const path = normalisePath(e.path);
    if (seen.has(path)) throw new Error(`duplicate zip entry: '${path}'`);
    seen.add(path);
    total += 30 + encoder.encode(path).length + e.bytes.length;
    total += 46 + encoder.encode(path).length;
  }
  if (total > MAX_ARCHIVE_BYTES) {
    throw new Error('archive would exceed the 4 GiB limit of non-ZIP64 archives');
  }

  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (b: Uint8Array): void => { chunks.push(b); offset += b.length; };

  for (const e of entries) {
    const path = normalisePath(e.path);
    const nameBytes = encoder.encode(path);
    const crc = crc32(e.bytes);
    const { dosTime, dosDate } = dosDateTime(e.modified ?? now);
    placed.push({ path: nameBytes, crc, size: e.bytes.length, offset, dosTime, dosDate });

    const header = new Uint8Array(30);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x0403_4B50, true);   // local file header
    h.setUint16(4, 20, true);            // version needed: 2.0
    h.setUint16(6, 0x0800, true);        // UTF-8 filename flag
    h.setUint16(8, 0, true);             // method: STORE
    h.setUint16(10, dosTime, true);
    h.setUint16(12, dosDate, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, e.bytes.length, true);
    h.setUint32(22, e.bytes.length, true);
    h.setUint16(26, nameBytes.length, true);
    h.setUint16(28, 0, true);
    push(header);
    push(nameBytes);
    push(e.bytes);
  }

  const centralStart = offset;
  for (const p of placed) {
    const header = new Uint8Array(46);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x0201_4B50, true);   // central directory header
    h.setUint16(4, 20, true);            // version made by
    h.setUint16(6, 20, true);            // version needed
    h.setUint16(8, 0x0800, true);
    h.setUint16(10, 0, true);
    h.setUint16(12, p.dosTime, true);
    h.setUint16(14, p.dosDate, true);
    h.setUint32(16, p.crc, true);
    h.setUint32(20, p.size, true);
    h.setUint32(24, p.size, true);
    h.setUint16(28, p.path.length, true);
    h.setUint32(42, p.offset, true);
    push(header);
    push(p.path);
  }
  const centralSize = offset - centralStart;

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x0605_4B50, true);    // end of central directory
  ev.setUint16(8, placed.length, true);
  ev.setUint16(10, placed.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  push(end);

  const out = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** SHA-256 hex, for the bundle's own checksum manifest. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}
