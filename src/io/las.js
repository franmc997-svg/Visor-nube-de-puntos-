// Lector LAS 1.0 - 1.4, formatos de punto 0-10.
// Lee por bloques con Blob.slice(): el fichero nunca esta entero en memoria.

import { readSlice, iterRecords, latin1 } from './reader.js';
import { PointBuffer } from './sample.js';

const HEADER_MAX = 375;

/** Offsets de RGB (y NIR) dentro del registro, por formato. -1 = sin color. */
const RGB_OFFSET = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
/** Longitud minima del registro por formato, segun la especificacion ASPRS. */
const MIN_RECORD_LEN = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];

export async function parseHeader(blob) {
  const v = await readSlice(blob, 0, HEADER_MAX);
  const sig = latin1(v, 0, 4);
  if (sig !== 'LASF') throw new Error('No es un fichero LAS/LAZ (falta la firma LASF).');

  const versionMajor = v.getUint8(24);
  const versionMinor = v.getUint8(25);
  const headerSize = v.getUint16(94, true);
  const offsetToPointData = v.getUint32(96, true);
  const numVlrs = v.getUint32(100, true);
  const rawFormat = v.getUint8(104);
  const compressed = (rawFormat & 0x80) !== 0;   // bit 7 = LAZ
  const pointFormat = rawFormat & 0x3f;
  const recordLength = v.getUint16(105, true);

  let pointCount = v.getUint32(107, true);
  const scale = [v.getFloat64(131, true), v.getFloat64(139, true), v.getFloat64(147, true)];
  const offset = [v.getFloat64(155, true), v.getFloat64(163, true), v.getFloat64(171, true)];
  const max = [v.getFloat64(179, true), v.getFloat64(195, true), v.getFloat64(211, true)];
  const min = [v.getFloat64(187, true), v.getFloat64(203, true), v.getFloat64(219, true)];

  if (versionMajor === 1 && versionMinor >= 4) {
    const big = Number(v.getBigUint64(247, true));
    if (big > 0) pointCount = big;
  }

  if (pointFormat > 10) throw new Error(`Formato de punto LAS ${pointFormat} no soportado.`);
  if (recordLength < MIN_RECORD_LEN[pointFormat]) {
    throw new Error(`Registro LAS incoherente (${recordLength} bytes para el formato ${pointFormat}).`);
  }

  return {
    versionMajor, versionMinor, headerSize, offsetToPointData, numVlrs,
    pointFormat, recordLength, pointCount, compressed,
    scale, offset, min, max,
    rgbOffset: RGB_OFFSET[pointFormat] ?? -1,
    // Formatos 6-10 mueven la clasificacion y usan un angulo de escaneo i16.
    legacyLayout: pointFormat <= 5,
  };
}

/** Lee las VLR del cabecero (necesario para LAZ y para el CRS). */
export async function readVlrs(blob, header) {
  const out = [];
  const start = header.headerSize;
  const bytes = Math.max(0, header.offsetToPointData - start);
  if (bytes === 0 || header.numVlrs === 0) return out;
  const v = await readSlice(blob, start, start + bytes);
  let o = 0;
  for (let i = 0; i < header.numVlrs && o + 54 <= v.byteLength; i++) {
    const userId = latin1(v, o + 2, 16);
    const recordId = v.getUint16(o + 18, true);
    const len = v.getUint16(o + 20, true);
    const dataStart = o + 54;
    if (dataStart + len > v.byteLength) break;
    out.push({
      userId, recordId,
      data: new Uint8Array(v.buffer, v.byteOffset + dataStart, len),
      absoluteOffset: start + dataStart,
    });
    o = dataStart + len;
  }
  return out;
}

/**
 * Decide si el RGB del fichero es de 8 o 16 bits.
 * La especificacion dice 16, pero medio mundo escribe 0-255 ahi dentro.
 * Muestreamos hasta 2000 puntos: si nadie pasa de 255, es de 8 bits.
 */
async function detectColorDepth(blob, header) {
  if (header.rgbOffset < 0) return 8;
  const n = Math.min(2000, header.pointCount);
  if (n === 0) return 8;
  const step = Math.max(1, Math.floor(header.pointCount / n));
  const probes = Math.min(n, 512);
  let maxVal = 0;
  // Una sola lectura contigua del principio suele bastar y evita 500 slices.
  const span = Math.min(probes * step * header.recordLength, 8 << 20, header.pointCount * header.recordLength);
  const v = await readSlice(blob, header.offsetToPointData, header.offsetToPointData + span);
  const records = Math.floor(v.byteLength / header.recordLength);
  const stride = Math.max(1, Math.floor(records / probes));
  for (let i = 0; i < records; i += stride) {
    const o = i * header.recordLength + header.rgbOffset;
    if (o + 6 > v.byteLength) break;
    maxVal = Math.max(maxVal, v.getUint16(o, true), v.getUint16(o + 2, true), v.getUint16(o + 4, true));
    if (maxVal > 255) return 16;
  }
  return maxVal > 255 ? 16 : 8;
}

/**
 * Lee un registro de punto ya posicionado y lo mete en el buffer.
 * Se pasa como funcion suelta porque LAZ reutiliza exactamente el mismo layout.
 */
export function makeRecordReader(header, colorShift) {
  const { scale, offset, rgbOffset, legacyLayout, recordLength } = header;
  const sx = scale[0], sy = scale[1], sz = scale[2];
  const ox = offset[0], oy = offset[1], oz = offset[2];
  const clsOffset = legacyLayout ? 15 : 16;
  const clsMask = legacyLayout ? 0x1f : 0xff;   // en 0-5 los 3 bits altos son flags

  return function readRecord(v, base, buf) {
    const x = v.getInt32(base, true) * sx + ox;
    const y = v.getInt32(base + 4, true) * sy + oy;
    const z = v.getInt32(base + 8, true) * sz + oz;
    const intensity = v.getUint16(base + 12, true);
    const cls = v.getUint8(base + clsOffset) & clsMask;
    let r = 255, g = 255, b = 255;
    if (rgbOffset >= 0 && base + rgbOffset + 6 <= v.byteLength) {
      r = v.getUint16(base + rgbOffset, true) >> colorShift;
      g = v.getUint16(base + rgbOffset + 2, true) >> colorShift;
      b = v.getUint16(base + rgbOffset + 4, true) >> colorShift;
    }
    buf.add(x, y, z, r, g, b, intensity, cls);
  };
}

export async function loadLas(blob, { budget, onProgress }) {
  const header = await parseHeader(blob);
  if (header.compressed) {
    // No deberia llegar aqui: el worker enruta por el bit de compresion.
    throw new Error('El fichero esta comprimido (LAZ): usa la ruta de laz.js.');
  }

  const depth = await detectColorDepth(blob, header);
  const colorShift = depth === 16 ? 8 : 0;

  const buf = new PointBuffer(budget, {
    color: header.rgbOffset >= 0,
    intensity: true,
    classification: true,
  });
  buf.setSourceCount(header.pointCount);
  if (isFinite(header.min[0]) && header.max[0] >= header.min[0]) {
    buf.setOrigin(
      (header.min[0] + header.max[0]) / 2,
      (header.min[1] + header.max[1]) / 2,
      (header.min[2] + header.max[2]) / 2,
    );
  }

  const readRecord = makeRecordReader(header, colorShift);
  const totalBytes = header.pointCount * header.recordLength;
  let done = 0;

  for await (const chunk of iterRecords(blob, header.offsetToPointData, totalBytes, header.recordLength)) {
    const { view, records } = chunk;
    for (let i = 0; i < records; i++) readRecord(view, i * header.recordLength, buf);
    done += records;
    onProgress?.(done / header.pointCount);
  }

  const out = buf.finish();
  out.hasColor = header.rgbOffset >= 0;
  out.format = `LAS ${header.versionMajor}.${header.versionMinor} (PDRF ${header.pointFormat}${depth === 16 ? ', RGB 16 bit' : header.rgbOffset >= 0 ? ', RGB 8 bit' : ''})`;
  out.upAxis = 'z';
  return out;
}
