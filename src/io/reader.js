// Lectura por trozos de un Blob/File sin cargarlo entero en memoria.
// En iOS un `file.arrayBuffer()` de 800 MB es muerte segura de la pestaña.

export async function readSlice(blob, start, end) {
  const buf = await blob.slice(start, Math.min(end, blob.size)).arrayBuffer();
  return new DataView(buf);
}

/**
 * Itera el blob en bloques alineados a `recordSize`.
 * @param {Blob} blob
 * @param {number} start        offset inicial
 * @param {number} totalBytes   bytes a leer desde start
 * @param {number} recordSize   tamaño de registro (los bloques nunca lo parten)
 * @param {number} targetBytes  tamaño objetivo de bloque
 */
export async function* iterRecords(blob, start, totalBytes, recordSize, targetBytes = 4 << 20) {
  const perChunk = Math.max(1, Math.floor(targetBytes / recordSize));
  const chunkBytes = perChunk * recordSize;
  let offset = start;
  const end = start + totalBytes;
  while (offset < end) {
    const size = Math.min(chunkBytes, end - offset);
    const buf = await blob.slice(offset, offset + size).arrayBuffer();
    yield { view: new DataView(buf), records: Math.floor(buf.byteLength / recordSize), byteOffset: offset };
    offset += size;
  }
}

/** Lee el blob entero como texto en trozos, entregando lineas completas. */
export async function* iterLines(blob, chunkBytes = 4 << 20) {
  const dec = new TextDecoder('utf-8');
  let carry = '';
  let offset = 0;
  while (offset < blob.size) {
    const size = Math.min(chunkBytes, blob.size - offset);
    const buf = await blob.slice(offset, offset + size).arrayBuffer();
    offset += size;
    const text = carry + dec.decode(buf, { stream: true });
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) { carry = text; continue; }
    carry = text.slice(lastNl + 1);
    yield text.slice(0, lastNl);
  }
  if (carry.length) yield carry;
}

export function latin1(view, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
