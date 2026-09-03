// Worker de carga: todo el parseo ocurre fuera del hilo principal, de forma que
// la UI sigue respondiendo mientras se leen cientos de MB.

import { shuffleResult } from './sample.js';
import { loadLas, parseHeader } from './las.js';
import { loadPly } from './ply.js';
import { loadPcd } from './pcd.js';
import { loadXyz } from './xyz.js';

const TEXT_EXT = new Set(['xyz', 'txt', 'csv', 'asc', 'pts']);

async function sniffFormat(blob, name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'e57') {
    throw new Error('E57 no esta soportado. Conviertelo a LAS/LAZ con CloudCompare o pdal translate.');
  }

  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const magic = String.fromCharCode(...head);

  // LAS y LAZ comparten cabecero: quien manda es el bit 7 del formato de punto,
  // no la extension. Hay bastantes ficheros .laz sin comprimir y .las comprimidos
  // circulando por ahi, y fiarse del nombre cuelga el descompresor.
  if (magic.startsWith('LASF') || ext === 'las' || ext === 'laz') {
    const header = await parseHeader(blob);
    return header.compressed ? 'laz' : 'las';
  }
  if (magic.startsWith('ply') || ext === 'ply') return 'ply';
  if (magic.startsWith('#') || ext === 'pcd') return 'pcd';
  if (TEXT_EXT.has(ext)) return 'xyz';
  return 'xyz';
}

async function run(blob, name, budget, post) {
  const onProgress = (value, label) => post({ type: 'progress', value, label });
  const fmt = await sniffFormat(blob, name);

  if (fmt === 'laz') {
    const { loadLaz } = await import('./laz.js');
    return loadLaz(blob, { budget, onProgress });
  }
  if (fmt === 'las') return loadLas(blob, { budget, onProgress });
  if (fmt === 'ply') return loadPly(blob, { budget, onProgress });
  if (fmt === 'pcd') return loadPcd(blob, { budget, onProgress });
  return loadXyz(blob, { budget, onProgress });
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== 'load') return;
  const post = (m) => self.postMessage(m);
  try {
    let blob = msg.file;
    let name = msg.name || '';
    if (msg.url) {
      post({ type: 'progress', value: 0, label: 'Descargando…' });
      const res = await fetch(msg.url);
      if (!res.ok) throw new Error(`HTTP ${res.status} al descargar el fichero.`);
      blob = await res.blob();
      name = name || new URL(msg.url, self.location.href).pathname.split('/').pop();
    }

    const t0 = performance.now();
    const result = await run(blob, name, msg.budget, post);
    if (result.count === 0) throw new Error('El fichero no contiene puntos legibles.');

    post({ type: 'progress', value: 0.99, label: 'Reordenando para LOD…' });
    shuffleResult(result);
    result.name = name;
    result.parseMs = Math.round(performance.now() - t0);

    const transfer = [result.position.buffer];
    if (result.color) transfer.push(result.color.buffer);
    if (result.intensity) transfer.push(result.intensity.buffer);
    if (result.classification) transfer.push(result.classification.buffer);
    self.postMessage({ type: 'done', payload: result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
