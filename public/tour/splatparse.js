/* splatparse.js — read the CENTRES out of a Gaussian-splat scan.
 *
 * A tour only needs to know where a splat sits, never what colour it is or how
 * it is shaped: the facts we compute (floor, walls, walkable ground) are made
 * entirely of positions. So this reads x/y/z and throws the other 245 bytes of
 * every vertex away, which is what lets a 91 MB scan be measured in a worker
 * without a GPU anywhere near it.
 *
 * Plain ES module. No DOM, no WebGL, no imports — it runs in a page, in a web
 * worker and in node exactly the same way.
 *
 *   const { positions, count, format, total } = await parseCentres(buf, 'office.ply');
 *   const small = await parseCentres(buf, 'office.ply', { max: 200000 });
 *
 * positions is xyz interleaved: positions[i*3], [i*3+1], [i*3+2].
 */

/* Byte width of every scalar type a PLY header may name. */
const PLY_TYPE_BYTES = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4,
  float: 4, float32: 4,
  double: 8, float64: 8
};

/* Read one scalar of the named type out of a DataView. */
function readScalar(view, offset, type, littleEndian) {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(offset);
    case 'uchar': case 'uint8': return view.getUint8(offset);
    case 'short': case 'int16': return view.getInt16(offset, littleEndian);
    case 'ushort': case 'uint16': return view.getUint16(offset, littleEndian);
    case 'int': case 'int32': return view.getInt32(offset, littleEndian);
    case 'uint': case 'uint32': return view.getUint32(offset, littleEndian);
    case 'float': case 'float32': return view.getFloat32(offset, littleEndian);
    case 'double': case 'float64': return view.getFloat64(offset, littleEndian);
    default: throw new Error('This PLY uses a property type we cannot read: "' + type + '".');
  }
}

/* Decode a byte range as ASCII without TextDecoder, so the module has no
 * environment assumptions at all. PLY headers are ASCII by specification. */
function asciiSlice(bytes, from, to) {
  let s = '';
  for (let i = from; i < to; i += 4096) {
    const end = Math.min(to, i + 4096);
    s += String.fromCharCode.apply(null, bytes.subarray(i, end));
  }
  return s;
}

/* Find "end_header" and return the byte index just past the newline after it. */
function findHeaderEnd(bytes) {
  const limit = Math.min(bytes.length, 1 << 20);   // a header past 1 MB is not a header
  const text = asciiSlice(bytes, 0, limit);
  const at = text.indexOf('end_header');
  if (at < 0) return { text: null, dataStart: -1 };
  let i = at + 'end_header'.length;
  if (bytes[i] === 13) i++;    // \r
  if (bytes[i] === 10) i++;    // \n
  return { text: text.slice(0, at + 'end_header'.length), dataStart: i };
}

/* Turn the header text into { format, littleEndian, elements:[{name,count,props,stride,hasList}] } */
function parsePlyHeader(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length || lines[0].trim().toLowerCase() !== 'ply') {
    throw new Error('This file does not start with "ply", so it is not a PLY scan.');
  }
  let format = null, littleEndian = true;
  const elements = [];
  let current = null;

  for (let li = 1; li < lines.length; li++) {
    const parts = lines[li].trim().split(/\s+/);
    const kw = (parts[0] || '').toLowerCase();
    if (kw === 'comment' || kw === 'obj_info' || kw === '') continue;
    if (kw === 'format') {
      format = (parts[1] || '').toLowerCase();
      if (format === 'binary_little_endian') littleEndian = true;
      else if (format === 'binary_big_endian') littleEndian = false;
      else if (format !== 'ascii') {
        throw new Error('This PLY says format "' + parts[1] + '", which we cannot read. Export it as binary_little_endian or ascii.');
      }
      continue;
    }
    if (kw === 'element') {
      current = { name: parts[1], count: parseInt(parts[2], 10) || 0, props: [], stride: 0, hasList: false };
      elements.push(current);
      continue;
    }
    if (kw === 'property') {
      if (!current) continue;
      if ((parts[1] || '').toLowerCase() === 'list') {
        current.props.push({ list: true, countType: parts[2].toLowerCase(), valType: parts[3].toLowerCase(), name: parts[4] });
        current.hasList = true;
      } else {
        const type = (parts[1] || '').toLowerCase();
        const size = PLY_TYPE_BYTES[type];
        if (!size) throw new Error('This PLY uses a property type we cannot read: "' + parts[1] + '".');
        current.props.push({ list: false, type, name: parts[2], offset: current.stride, size });
        current.stride += size;
      }
      continue;
    }
    if (kw === 'end_header') break;
  }
  if (!format) throw new Error('This PLY header has no "format" line, so we cannot tell how the vertices are stored.');
  return { format, littleEndian, elements };
}

/* The element that actually carries x/y/z — normally "vertex". */
function findVertexElement(elements) {
  for (const el of elements) {
    const names = el.props.map(p => p.name);
    if (names.indexOf('x') >= 0 && names.indexOf('y') >= 0 && names.indexOf('z') >= 0) return el;
  }
  return null;
}

function strideFor(total, max) {
  if (!max || max <= 0 || total <= max) return 1;
  return Math.max(1, Math.ceil(total / max));
}

function keptCount(total, stride) {
  return stride <= 1 ? total : Math.ceil(total / stride);
}

function parsePlyBinary(arrayBuffer, bytes, header, dataStart, opts) {
  const el = findVertexElement(header.elements);
  if (!el) throw new Error('This PLY has no x/y/z properties, so there are no splat centres in it.');
  if (el.hasList) throw new Error('This PLY stores its vertices with a variable-length list property, which we cannot read. Export it as a standard 3D Gaussian-splat PLY.');

  // Skip whole elements that come before the vertex block.
  let offset = dataStart;
  for (const other of header.elements) {
    if (other === el) break;
    if (other.hasList) throw new Error('This PLY has a variable-length "' + other.name + '" block before its vertices, so we cannot find where the vertices start.');
    offset += other.count * other.stride;
  }

  const px = el.props.find(p => p.name === 'x');
  const py = el.props.find(p => p.name === 'y');
  const pz = el.props.find(p => p.name === 'z');
  const total = el.count;
  const stride = el.stride;
  const need = offset + total * stride;
  if (need > bytes.length) {
    throw new Error('This PLY is cut short: the header promises ' + total + ' vertices (' +
      need + ' bytes) but the file is only ' + bytes.length + ' bytes. Re-export or re-upload it.');
  }

  const step = strideFor(total, opts && opts.max);
  const kept = keptCount(total, step);
  const out = new Float32Array(kept * 3);
  const view = new DataView(arrayBuffer);
  const LE = header.littleEndian;

  // Fast path: the usual 3DGS layout — little-endian float x,y,z first, native
  // byte order — can be read straight through DataView.getFloat32 anyway, but
  // hoisting the type test out of the loop is what keeps 369k vertices quick.
  const allFloat = px.type === 'float' || px.type === 'float32';
  const sameFloat = allFloat && (py.type === px.type) && (pz.type === px.type);

  let w = 0;
  if (sameFloat) {
    const ox = px.offset, oy = py.offset, oz = pz.offset;
    for (let i = 0; i < total; i += step) {
      const base = offset + i * stride;
      out[w++] = view.getFloat32(base + ox, LE);
      out[w++] = view.getFloat32(base + oy, LE);
      out[w++] = view.getFloat32(base + oz, LE);
    }
  } else {
    for (let i = 0; i < total; i += step) {
      const base = offset + i * stride;
      out[w++] = readScalar(view, base + px.offset, px.type, LE);
      out[w++] = readScalar(view, base + py.offset, py.type, LE);
      out[w++] = readScalar(view, base + pz.offset, pz.type, LE);
    }
  }
  return { positions: out, count: w / 3, format: 'ply', total, sampled: step > 1, sampleStride: step };
}

function parsePlyAscii(bytes, header, dataStart, opts) {
  const el = findVertexElement(header.elements);
  if (!el) throw new Error('This PLY has no x/y/z properties, so there are no splat centres in it.');
  if (el.hasList) throw new Error('This PLY stores its vertices with a variable-length list property, which we cannot read. Export it as a standard 3D Gaussian-splat PLY.');

  const names = el.props.map(p => p.name);
  const xi = names.indexOf('x'), yi = names.indexOf('y'), zi = names.indexOf('z');
  const body = asciiSlice(bytes, dataStart, bytes.length);
  const lines = body.split(/\r?\n/);

  // Rows belonging to elements declared before the vertex block.
  let skip = 0;
  for (const other of header.elements) {
    if (other === el) break;
    if (other.hasList) throw new Error('This PLY has a variable-length "' + other.name + '" block before its vertices, so we cannot find where the vertices start.');
    skip += other.count;
  }

  const rows = [];
  for (let i = 0; i < lines.length && rows.length < skip + el.count; i++) {
    const t = lines[i].trim();
    if (t) rows.push(t);
  }
  const verts = rows.slice(skip);
  const total = verts.length;
  if (!total) throw new Error('This PLY header promises ' + el.count + ' vertices but the file has none after the header.');

  const step = strideFor(total, opts && opts.max);
  const kept = keptCount(total, step);
  const out = new Float32Array(kept * 3);
  let w = 0;
  for (let i = 0; i < total; i += step) {
    const f = verts[i].split(/\s+/);
    out[w++] = parseFloat(f[xi]);
    out[w++] = parseFloat(f[yi]);
    out[w++] = parseFloat(f[zi]);
  }
  return { positions: out, count: w / 3, format: 'ply', total, sampled: step > 1, sampleStride: step };
}

/* .splat — 32 bytes per splat:
 *   0..11  position float32[3]
 *  12..23  scale    float32[3]
 *  24..27  rgba     uint8[4]
 *  28..31  rotation uint8[4]
 * Always little-endian; that is what every exporter writes. */
function parseSplat(arrayBuffer, opts) {
  const REC = 32;
  const bytes = arrayBuffer.byteLength;
  if (bytes === 0) throw new Error('This .splat file is empty.');
  if (bytes % REC !== 0) {
    throw new Error('This .splat file is ' + bytes + ' bytes, which is not a whole number of 32-byte splats. It may be truncated or may not be a .splat at all.');
  }
  const total = bytes / REC;
  const step = strideFor(total, opts && opts.max);
  const kept = keptCount(total, step);
  const out = new Float32Array(kept * 3);
  const view = new DataView(arrayBuffer);
  let w = 0;
  for (let i = 0; i < total; i += step) {
    const base = i * REC;
    out[w++] = view.getFloat32(base, true);
    out[w++] = view.getFloat32(base + 4, true);
    out[w++] = view.getFloat32(base + 8, true);
  }
  return { positions: out, count: w / 3, format: 'splat', total, sampled: step > 1, sampleStride: step };
}

/* The formats we deliberately do not open. Saying so plainly, in one place, is
 * what lets a caller catch this and fall back to a real splat renderer instead
 * of shipping a half-implemented decoder nobody has tested against a real file. */
const UNSUPPORTED = {
  spz: 'compressed .spz',
  ksplat: '.ksplat'
};

export function unsupportedFormatMessage(ext) {
  const what = UNSUPPORTED[ext] || ('.' + ext);
  return 'We can only measure a room from a .ply or a .splat scan, and this is a ' + what +
    ' file. Export the scan as .ply (Scaniverse: Share → Export → PLY) and attach that instead.';
}

/* Which reader does this file want? Extension first, magic bytes as the check. */
export function detectFormat(arrayBuffer, filename) {
  const name = String(filename || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  let ext = dot >= 0 ? name.slice(dot + 1) : '';
  const bytes = new Uint8Array(arrayBuffer, 0, Math.min(arrayBuffer.byteLength, 4));
  const isPly = bytes.length >= 3 && bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79; // "ply"
  if (isPly) return 'ply';
  if (ext === 'ply') return 'ply';          // header check happens in the reader
  if (ext === 'splat') return 'splat';
  if (UNSUPPORTED[ext]) return ext;
  if (arrayBuffer.byteLength > 0 && arrayBuffer.byteLength % 32 === 0) return 'splat';
  return ext || 'unknown';
}

/**
 * Extract splat centres from a scan file.
 *
 * @param {ArrayBuffer} arrayBuffer  the whole file
 * @param {string} filename          used to pick the reader (".ply" / ".splat")
 * @param {{max?:number}} [opts]     max centres to keep; evenly strided, deterministic
 * @returns {Promise<{positions:Float32Array,count:number,format:string,total:number,
 *                    sampled:boolean,sampleStride:number}>}
 */
export async function parseCentres(arrayBuffer, filename, opts) {
  if (!arrayBuffer || typeof arrayBuffer.byteLength !== 'number') {
    throw new Error('parseCentres needs the scan file as an ArrayBuffer.');
  }
  const fmt = detectFormat(arrayBuffer, filename);

  if (UNSUPPORTED[fmt]) throw new Error(unsupportedFormatMessage(fmt));

  if (fmt === 'ply') {
    const bytes = new Uint8Array(arrayBuffer);
    const { text, dataStart } = findHeaderEnd(bytes);
    if (dataStart < 0) throw new Error('This PLY has no "end_header" line in its first megabyte, so it is not a PLY we can read.');
    const header = parsePlyHeader(text);
    return header.format === 'ascii'
      ? parsePlyAscii(bytes, header, dataStart, opts)
      : parsePlyBinary(arrayBuffer, bytes, header, dataStart, opts);
  }

  if (fmt === 'splat') return parseSplat(arrayBuffer, opts);

  throw new Error('We can only measure a room from a .ply or a .splat scan, and we could not tell what "' +
    (filename || 'this file') + '" is. Export the scan as .ply and attach that instead.');
}

export default { parseCentres, detectFormat, unsupportedFormatMessage };
