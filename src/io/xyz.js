// Lector de texto plano: XYZ / TXT / CSV / PTS / ASC.
// Detecta el separador y adivina las columnas de color e intensidad.

import { iterLines } from './reader.js';
import { PointBuffer } from './sample.js';

function sniff(lines) {
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    const seps = [
      { re: /[ \t]+/, name: 'espacio' },
      { re: /\s*,\s*/, name: 'coma' },
      { re: /\s*;\s*/, name: 'punto y coma' },
    ];
    for (const s of seps) {
      const f = t.split(s.re).filter((x) => x.length);
      if (f.length >= 3 && f.slice(0, 3).every((x) => isFinite(Number(x)))) {
        return { sep: s.re, name: s.name, fields: f };
      }
    }
  }
  return null;
}

export async function loadXyz(blob, { budget, onProgress }) {
  const probe = new TextDecoder('utf-8').decode(await blob.slice(0, 65536).arrayBuffer());
  const probeLines = probe.split(/\r?\n/).slice(0, 200);
  const s = sniff(probeLines);
  if (!s) throw new Error('No se reconocen columnas numericas X Y Z en el fichero de texto.');

  const nCols = s.fields.length;
  // Heuristica de columnas:
  //   3 -> x y z
  //   4 -> x y z intensidad
  //   6 -> x y z r g b
  //   7+ -> x y z intensidad r g b   (formato PTS clasico)
  let ci = -1, cr = -1, cg = -1, cb = -1;
  if (nCols === 4) ci = 3;
  else if (nCols === 6) { cr = 3; cg = 4; cb = 5; }
  else if (nCols >= 7) { ci = 3; cr = 4; cg = 5; cb = 6; }

  // Color en 0-1 (float) o en 0-255 (entero): se decide muestreando.
  let colorMax = 0;
  if (cr >= 0) {
    for (const line of probeLines) {
      const f = line.trim().split(s.sep).filter((x) => x.length);
      if (f.length < nCols) continue;
      colorMax = Math.max(colorMax, +f[cr], +f[cg], +f[cb]);
    }
  }
  const colorGain = cr >= 0 && colorMax <= 1.001 ? 255 : 1;
  const hasColor = cr >= 0;

  const buf = new PointBuffer(budget, { color: hasColor, intensity: ci >= 0 });
  // No sabemos cuantos puntos trae el fichero hasta terminarlo, asi que en vez
  // de estimar se empieza aceptando todo y se decima a la mitad cada vez que el
  // buffer se llena. El resultado es uniforme y el techo de memoria es firme.

  let bytesRead = 0;
  let n = 0;
  for await (const block of iterLines(blob)) {
    bytesRead += block.length + 1;
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (!t || t.charCodeAt(0) === 35 || t.startsWith('//')) continue;
      const f = t.split(s.sep);
      if (f.length < 3) continue;
      const x = +f[0], y = +f[1], z = +f[2];
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
      if (buf.count >= buf.capacity) buf.halve();
      buf.add(
        x, y, z,
        hasColor ? Math.min(255, Math.max(0, Math.round(+f[cr] * colorGain))) : 255,
        hasColor ? Math.min(255, Math.max(0, Math.round(+f[cg] * colorGain))) : 255,
        hasColor ? Math.min(255, Math.max(0, Math.round(+f[cb] * colorGain))) : 255,
        ci >= 0 ? Math.max(0, Math.min(65535, Math.round(+f[ci]))) : 0, 0,
      );
      n++;
    }
    onProgress?.(bytesRead / blob.size);
  }

  const out = buf.finish();
  out.hasColor = hasColor;
  out.sourceCount = n;
  out.format = `Texto (${nCols} columnas, separador: ${s.name})`;
  out.upAxis = 'z';
  return out;
}
