// Descompresion LAZ mediante laz-perf (WASM).
//
// Limitacion consciente: laz-perf necesita el fichero comprimido ENTERO en el
// heap de WASM (su API JS no expone la tabla de chunks, asi que no se puede
// descomprimir por bloques). El pico de memoria es ~1x el tamaño del .laz, no
// del .las descomprimido, asi que en un iPhone 14 aguanta comodo hasta ~250 MB
// de LAZ (≈ 60-80 M de puntos). Por encima de eso, convierte a COPC en
// escritorio: ver el README.

import createLazPerf from 'laz-perf/lib/laz-perf.js';
import wasmUrl from 'laz-perf/lib/laz-perf.wasm?url';
import { parseHeader, makeRecordReader } from './las.js';
import { PointBuffer } from './sample.js';

/**
 * laz-perf esta compilado sin captura de excepciones, asi que cualquier fallo
 * interno del descompresor llega como un numero y un parrafo sobre flags de
 * emscripten. Eso no le sirve de nada a quien esta intentando abrir un fichero.
 */
function abrir(laszip, ptr, bytes) {
  try {
    laszip.open(ptr, bytes);
  } catch (err) {
    const bruto = String(err?.message || err);
    if (/exception|abort|memory access|unreachable/i.test(bruto)) {
      throw new Error('El descompresor LAZ no ha podido leer el fichero. '
        + 'Suele significar que esta truncado o corrupto, o que usa una variante '
        + 'de compresion que laz-perf no soporta. Prueba a convertirlo con '
        + '"pdal translate entrada.laz salida.las".');
    }
    throw err;
  }
}

let modulePromise = null;
export function getLazPerf() {
  if (!modulePromise) {
    modulePromise = createLazPerf({ locateFile: () => wasmUrl });
  }
  return modulePromise;
}

export async function loadLaz(blob, { budget, onProgress }) {
  const header = await parseHeader(blob);
  if (!header.compressed) {
    throw new Error('El fichero se llama .laz pero su carga util no esta comprimida. '
      + 'Renombralo a .las y vuelve a abrirlo.');
  }
  const LazPerf = await getLazPerf();

  onProgress?.(0, 'Descomprimiendo LAZ…');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const filePtr = LazPerf._malloc(bytes.byteLength);
  LazPerf.HEAPU8.set(bytes, filePtr);
  const fileBytes = bytes.byteLength;

  const laszip = new LazPerf.LASZip();
  let pointPtr = 0;
  try {
    abrir(laszip, filePtr, fileBytes);
    const recordLength = laszip.getPointLength();
    const count = header.pointCount || laszip.getCount();
    pointPtr = LazPerf._malloc(recordLength);
    const rec = new DataView(LazPerf.HEAPU8.buffer, pointPtr, recordLength);

    const hasColor = header.rgbOffset >= 0;
    const buf = new PointBuffer(budget, { color: hasColor, intensity: true, classification: true });
    buf.setSourceCount(count);
    if (isFinite(header.min[0]) && header.max[0] >= header.min[0]) {
      buf.setOrigin(
        (header.min[0] + header.max[0]) / 2,
        (header.min[1] + header.max[1]) / 2,
        (header.min[2] + header.max[2]) / 2,
      );
    }

    // No se puede rebobinar el stream, asi que para decidir si el RGB es de 8 o
    // 16 bits guardamos los primeros registros crudos, decidimos, y los
    // reproducimos con el desplazamiento correcto.
    const probeCount = hasColor ? Math.min(2000, count) : 0;
    const probe = new Uint8Array(probeCount * recordLength);
    let maxRgb = 0;
    for (let i = 0; i < probeCount; i++) {
      try {
        laszip.getPoint(pointPtr);
      } catch {
        throw new Error('El fichero LAZ se corta en el primer bloque de puntos: '
          + 'esta truncado o corrupto.');
      }
      probe.set(new Uint8Array(LazPerf.HEAPU8.buffer, pointPtr, recordLength), i * recordLength);
      const o = header.rgbOffset;
      maxRgb = Math.max(maxRgb, rec.getUint16(o, true), rec.getUint16(o + 2, true), rec.getUint16(o + 4, true));
    }
    const colorShift = hasColor && maxRgb > 255 ? 8 : 0;
    const readRecord = makeRecordReader(header, colorShift);

    const probeView = new DataView(probe.buffer);
    for (let i = 0; i < probeCount; i++) readRecord(probeView, i * recordLength, buf);

    try {
      for (let i = probeCount; i < count; i++) {
        laszip.getPoint(pointPtr);
        readRecord(rec, 0, buf);
        if ((i & 0xffff) === 0) onProgress?.(i / count);
      }
    } catch (err) {
      // Un fichero cortado a mitad es recuperable: nos quedamos con lo leido en
      // vez de tirar toda la carga a la basura.
      if (buf.count < 1000) throw err;
      onProgress?.(1, 'Fichero incompleto: se muestra la parte legible');
    }

    const out = buf.finish();
    out.hasColor = hasColor;
    out.format = `LAZ ${header.versionMajor}.${header.versionMinor} (PDRF ${header.pointFormat}${hasColor ? colorShift ? ', RGB 16 bit' : ', RGB 8 bit' : ''})`;
    out.upAxis = 'z';
    return out;
  } finally {
    try { laszip.delete(); } catch { /* ya liberado */ }
    if (pointPtr) LazPerf._free(pointPtr);
    LazPerf._free(filePtr);
  }
}
