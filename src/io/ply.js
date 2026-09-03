// Lector PLY: ascii, binary_little_endian y binary_big_endian.
// Soporta color en red/green/blue (uchar o float), diffuse_red/... e intensity.

import { readSlice, iterRecords, iterLines } from './reader.js';
import { PointBuffer } from './sample.js';

const TYPE_SIZE = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4,
  float: 4, float32: 4,
  double: 8, float64: 8,
};

const READER = {
  char: (v, o) => v.getInt8(o), int8: (v, o) => v.getInt8(o),
  uchar: (v, o) => v.getUint8(o), uint8: (v, o) => v.getUint8(o),
  short: (v, o, le) => v.getInt16(o, le), int16: (v, o, le) => v.getInt16(o, le),
  ushort: (v, o, le) => v.getUint16(o, le), uint16: (v, o, le) => v.getUint16(o, le),
  int: (v, o, le) => v.getInt32(o, le), int32: (v, o, le) => v.getInt32(o, le),
  uint: (v, o, le) => v.getUint32(o, le), uint32: (v, o, le) => v.getUint32(o, le),
  float: (v, o, le) => v.getFloat32(o, le), float32: (v, o, le) => v.getFloat32(o, le),
  double: (v, o, le) => v.getFloat64(o, le), float64: (v, o, le) => v.getFloat64(o, le),
};

async function parsePlyHeader(blob) {
  // El cabecero es ascii y corto; 64 KB sobra salvo patologias.
  const probe = await blob.slice(0, Math.min(65536, blob.size)).arrayBuffer();
  const text = new TextDecoder('utf-8').decode(probe);
  const endIdx = text.indexOf('end_header');
  if (!text.startsWith('ply')) throw new Error('No es un fichero PLY.');
  if (endIdx < 0) throw new Error('Cabecero PLY incompleto o demasiado largo.');
  const nl = text.indexOf('\n', endIdx);
  const headerText = text.slice(0, nl);
  // Los bytes reales del cabecero, contados en UTF-8 (no en caracteres).
  const dataStart = new TextEncoder().encode(text.slice(0, nl + 1)).byteLength;

  let format = null, littleEndian = true;
  const elements = [];
  let current = null;
  for (const raw of headerText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tok = line.split(/\s+/);
    if (tok[0] === 'format') {
      format = tok[1];
      littleEndian = format !== 'binary_big_endian';
    } else if (tok[0] === 'element') {
      current = { name: tok[1], count: Number(tok[2]), props: [] };
      elements.push(current);
    } else if (tok[0] === 'property' && current) {
      if (tok[1] === 'list') {
        current.props.push({ list: true, countType: tok[2], itemType: tok[3], name: tok[4] });
      } else {
        current.props.push({ list: false, type: tok[1], name: tok[2] });
      }
    }
  }
  const vertex = elements.find((e) => e.name === 'vertex');
  if (!vertex) throw new Error('El PLY no tiene elemento "vertex".');
  return { format, littleEndian, dataStart, elements, vertex };
}

function pickProps(props) {
  const byName = new Map(props.map((p, i) => [p.name.toLowerCase(), i]));
  const find = (...names) => { for (const n of names) if (byName.has(n)) return byName.get(n); return -1; };
  return {
    x: find('x'), y: find('y'), z: find('z'),
    r: find('red', 'r', 'diffuse_red'),
    g: find('green', 'g', 'diffuse_green'),
    b: find('blue', 'b', 'diffuse_blue'),
    i: find('intensity', 'scalar_intensity', 'gray', 'grey'),
  };
}

/** El color puede venir como uchar 0-255 o como float 0-1. */
function colorScaler(prop) {
  if (!prop) return () => 255;
  const t = prop.type;
  if (t === 'float' || t === 'float32' || t === 'double' || t === 'float64') {
    return (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  if (t === 'ushort' || t === 'uint16' || t === 'short' || t === 'int16') {
    return (v) => Math.max(0, Math.min(255, v > 255 ? v >> 8 : v));
  }
  return (v) => Math.max(0, Math.min(255, v | 0));
}

export async function loadPly(blob, { budget, onProgress }) {
  const h = await parsePlyHeader(blob);
  const props = h.vertex.props;
  const idx = pickProps(props);
  if (idx.x < 0 || idx.y < 0 || idx.z < 0) throw new Error('El PLY no tiene propiedades x/y/z.');

  const hasColor = idx.r >= 0 && idx.g >= 0 && idx.b >= 0;
  const hasIntensity = idx.i >= 0;
  const count = h.vertex.count;

  const buf = new PointBuffer(budget, { color: hasColor, intensity: hasIntensity });
  buf.setSourceCount(count);

  const scaleR = colorScaler(props[idx.r]);
  const scaleG = colorScaler(props[idx.g]);
  const scaleB = colorScaler(props[idx.b]);

  if (h.format === 'ascii') {
    let n = 0;
    for await (const block of iterLines(blob)) {
      for (const line of block.split('\n')) {
        if (n >= count) break;
        const t = line.trim();
        if (!t) continue;
        const f = t.split(/[\s,]+/);
        if (f.length < props.length) continue;
        n++;
        buf.add(
          +f[idx.x], +f[idx.y], +f[idx.z],
          hasColor ? scaleR(+f[idx.r]) : 255,
          hasColor ? scaleG(+f[idx.g]) : 255,
          hasColor ? scaleB(+f[idx.b]) : 255,
          hasIntensity ? +f[idx.i] : 0, 0,
        );
      }
      onProgress?.(n / count);
      if (n >= count) break;
    }
  } else {
    // Longitud fija por vertice: si hay propiedades de lista no podemos saltar.
    let stride = 0;
    for (const p of props) {
      if (p.list) throw new Error('PLY binario con propiedades de lista en "vertex": no soportado.');
      const s = TYPE_SIZE[p.type];
      if (!s) throw new Error(`Tipo PLY desconocido: ${p.type}`);
      p._offset = stride;
      stride += s;
    }
    const le = h.littleEndian;
    const rx = READER[props[idx.x].type], ry = READER[props[idx.y].type], rz = READER[props[idx.z].type];
    const rr = hasColor ? READER[props[idx.r].type] : null;
    const rg = hasColor ? READER[props[idx.g].type] : null;
    const rb = hasColor ? READER[props[idx.b].type] : null;
    const ri = hasIntensity ? READER[props[idx.i].type] : null;
    const ox = props[idx.x]._offset, oy = props[idx.y]._offset, oz = props[idx.z]._offset;
    const or_ = hasColor ? props[idx.r]._offset : 0;
    const og = hasColor ? props[idx.g]._offset : 0;
    const ob = hasColor ? props[idx.b]._offset : 0;
    const oi = hasIntensity ? props[idx.i]._offset : 0;

    let done = 0;
    for await (const chunk of iterRecords(blob, h.dataStart, count * stride, stride)) {
      const { view, records } = chunk;
      for (let k = 0; k < records; k++) {
        const base = k * stride;
        buf.add(
          rx(view, base + ox, le), ry(view, base + oy, le), rz(view, base + oz, le),
          hasColor ? scaleR(rr(view, base + or_, le)) : 255,
          hasColor ? scaleG(rg(view, base + og, le)) : 255,
          hasColor ? scaleB(rb(view, base + ob, le)) : 255,
          hasIntensity ? ri(view, base + oi, le) : 0, 0,
        );
      }
      done += records;
      onProgress?.(done / count);
    }
  }

  const out = buf.finish();
  out.hasColor = hasColor;
  out.format = `PLY ${h.format}`;
  // Los PLY de fotogrametria suelen venir en Y-up; los de escaner, en Z-up.
  out.upAxis = 'auto';
  return out;
}
