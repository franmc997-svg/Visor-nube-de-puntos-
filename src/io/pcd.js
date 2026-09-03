// Lector PCD (Point Cloud Library): ascii, binary y binary_compressed (LZF).

import { iterRecords, iterLines } from './reader.js';
import { PointBuffer } from './sample.js';

const READER = {
  'I1': (v, o) => v.getInt8(o), 'I2': (v, o) => v.getInt16(o, true), 'I4': (v, o) => v.getInt32(o, true),
  'U1': (v, o) => v.getUint8(o), 'U2': (v, o) => v.getUint16(o, true), 'U4': (v, o) => v.getUint32(o, true),
  'F4': (v, o) => v.getFloat32(o, true), 'F8': (v, o) => v.getFloat64(o, true),
};

/** LZF (variante liblzf usada por PCL). */
function lzfDecompress(input, outputLength) {
  const out = new Uint8Array(outputLength);
  let ip = 0, op = 0;
  while (ip < input.length) {
    let ctrl = input[ip++];
    if (ctrl < 32) {
      ctrl++;
      if (op + ctrl > outputLength) throw new Error('LZF: desbordamiento de salida.');
      while (ctrl--) out[op++] = input[ip++];
    } else {
      let len = ctrl >> 5;
      let ref = op - ((ctrl & 0x1f) << 8) - 1;
      if (len === 7) len += input[ip++];
      ref -= input[ip++];
      if (ref < 0) throw new Error('LZF: referencia invalida.');
      if (op + len + 2 > outputLength) throw new Error('LZF: desbordamiento de salida.');
      out[op++] = out[ref++];
      out[op++] = out[ref++];
      while (len--) out[op++] = out[ref++];
    }
  }
  return out;
}

function parsePcdHeader(text) {
  const h = { fields: [], size: [], type: [], count: [], width: 0, height: 1, points: 0, data: 'ascii' };
  let dataStart = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    dataStart += raw.length + 1;
    if (!line || line.startsWith('#')) continue;
    const t = line.split(/\s+/);
    const key = t[0].toUpperCase();
    if (key === 'FIELDS') h.fields = t.slice(1);
    else if (key === 'SIZE') h.size = t.slice(1).map(Number);
    else if (key === 'TYPE') h.type = t.slice(1);
    else if (key === 'COUNT') h.count = t.slice(1).map(Number);
    else if (key === 'WIDTH') h.width = Number(t[1]);
    else if (key === 'HEIGHT') h.height = Number(t[1]);
    else if (key === 'POINTS') h.points = Number(t[1]);
    else if (key === 'DATA') { h.data = t[1].toLowerCase(); break; }
  }
  if (!h.points) h.points = h.width * h.height;
  if (!h.count.length) h.count = h.fields.map(() => 1);
  h.dataStart = dataStart;
  return h;
}

function fieldLayout(h) {
  const layout = [];
  let offset = 0;
  for (let i = 0; i < h.fields.length; i++) {
    const size = h.size[i], n = h.count[i] || 1;
    layout.push({ name: h.fields[i].toLowerCase(), offset, size, type: h.type[i], code: h.type[i] + size, n, bytes: size * n });
    offset += size * n;
  }
  return { layout, stride: offset };
}

/** Desempaqueta el campo rgb/rgba de PCL (0x00RRGGBB, a veces bit-cast a float). */
function unpackRgb(value, code) {
  let u;
  if (code === 'F4') {
    const f = new Float32Array(1); f[0] = value;
    u = new Uint32Array(f.buffer)[0];
  } else {
    u = value >>> 0;
  }
  return [(u >> 16) & 255, (u >> 8) & 255, u & 255];
}

export async function loadPcd(blob, { budget, onProgress }) {
  const probe = await blob.slice(0, Math.min(16384, blob.size)).arrayBuffer();
  const headText = new TextDecoder('utf-8').decode(probe);
  if (!/(^|\n)\s*(#|VERSION|FIELDS)/.test(headText)) throw new Error('No parece un fichero PCD.');
  const h = parsePcdHeader(headText);
  const { layout, stride } = fieldLayout(h);

  const get = (n) => layout.find((f) => f.name === n);
  const fx = get('x'), fy = get('y'), fz = get('z');
  if (!fx || !fy || !fz) throw new Error('El PCD no tiene campos x/y/z.');
  const frgb = get('rgb') || get('rgba');
  const fi = get('intensity');
  const hasColor = !!frgb;

  const buf = new PointBuffer(budget, { color: hasColor, intensity: !!fi });
  buf.setSourceCount(h.points);

  if (h.data === 'ascii') {
    const ix = h.fields.indexOf(fx.name), iy = h.fields.indexOf(fy.name), iz = h.fields.indexOf(fz.name);
    const irgb = frgb ? h.fields.indexOf(frgb.name) : -1;
    const iint = fi ? h.fields.indexOf(fi.name) : -1;
    const body = blob.slice(h.dataStart);
    let n = 0;
    for await (const block of iterLines(body)) {
      for (const line of block.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const f = t.split(/\s+/);
        let r = 255, g = 255, b = 255;
        if (irgb >= 0) [r, g, b] = unpackRgb(+f[irgb], frgb.code);
        buf.add(+f[ix], +f[iy], +f[iz], r, g, b, iint >= 0 ? +f[iint] : 0, 0);
        n++;
      }
      onProgress?.(n / h.points);
    }
  } else if (h.data === 'binary') {
    let done = 0;
    for await (const chunk of iterRecords(blob, h.dataStart, h.points * stride, stride)) {
      const { view, records } = chunk;
      for (let k = 0; k < records; k++) {
        const base = k * stride;
        let r = 255, g = 255, b = 255;
        if (frgb) [r, g, b] = unpackRgb(READER[frgb.code](view, base + frgb.offset), frgb.code);
        buf.add(
          READER[fx.code](view, base + fx.offset),
          READER[fy.code](view, base + fy.offset),
          READER[fz.code](view, base + fz.offset),
          r, g, b, fi ? READER[fi.code](view, base + fi.offset) : 0, 0,
        );
      }
      done += records;
      onProgress?.(done / h.points);
    }
  } else if (h.data === 'binary_compressed') {
    const rest = new Uint8Array(await blob.slice(h.dataStart).arrayBuffer());
    const meta = new DataView(rest.buffer, rest.byteOffset, 8);
    const compressed = meta.getUint32(0, true);
    const uncompressed = meta.getUint32(4, true);
    const raw = lzfDecompress(rest.subarray(8, 8 + compressed), uncompressed);
    // Ojo: binary_compressed guarda los datos por campos (SoA), no por punto.
    const rv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const n = h.points;
    const base = {};
    let acc = 0;
    for (const f of layout) { base[f.name] = acc; acc += f.bytes * n; }
    for (let k = 0; k < n; k++) {
      let r = 255, g = 255, b = 255;
      if (frgb) [r, g, b] = unpackRgb(READER[frgb.code](rv, base[frgb.name] + k * frgb.bytes), frgb.code);
      buf.add(
        READER[fx.code](rv, base[fx.name] + k * fx.bytes),
        READER[fy.code](rv, base[fy.name] + k * fy.bytes),
        READER[fz.code](rv, base[fz.name] + k * fz.bytes),
        r, g, b, fi ? READER[fi.code](rv, base[fi.name] + k * fi.bytes) : 0, 0,
      );
      if ((k & 0xffff) === 0) onProgress?.(k / n);
    }
  } else {
    throw new Error(`Modo DATA de PCD no soportado: ${h.data}`);
  }

  const out = buf.finish();
  out.hasColor = hasColor;
  out.format = `PCD ${h.data}`;
  out.upAxis = 'z';
  return out;
}
