#!/usr/bin/env node
// Genera una nube de puntos sintetica para probar el visor sin datos reales.
//
//   node tools/generar-nube-de-prueba.mjs prueba.las 500000
//   node tools/generar-nube-de-prueba.mjs prueba.ply 300000
//   node tools/generar-nube-de-prueba.mjs prueba.xyz 200000
//
// Las coordenadas van deliberadamente en un sistema tipo UTM (X ~ 500.000 m)
// para comprobar que el visor resta el origen antes de pasar a Float32: si no
// lo hiciera, la nube "temblaria" al orbitar.

import fs from 'node:fs';

const salida = process.argv[2] || 'prueba.las';
const total = Number(process.argv[3] || 300000);
const ORIGEN = [500000, 4600000, 700];

let s = 987654321;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };

/** Terreno ondulado + un edificio + un arbol. Con color y con intensidad. */
function* generar(n) {
  const lado = 60;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    let x, y, z, r, g, b, cls;
    if (t < 0.6) {
      // Suelo
      x = (rnd() - 0.5) * lado;
      y = (rnd() - 0.5) * lado;
      z = Math.sin(x * 0.18) * 1.4 + Math.cos(y * 0.13) * 1.1 + (rnd() - 0.5) * 0.04;
      const hierba = 0.5 + 0.5 * Math.sin(x * 0.7 + y * 0.5);
      r = 70 + hierba * 60; g = 105 + hierba * 80; b = 55 + hierba * 40;
      cls = 2;
    } else if (t < 0.9) {
      // Edificio: cuatro fachadas y una cubierta a dos aguas
      const w = 14, d = 10, h = 9;
      const cara = Math.floor(rnd() * 5);
      const u = rnd(), v = rnd();
      if (cara === 4) {
        x = -8 + u * w; y = 6 + v * d;
        z = h + (1 - Math.abs(v - 0.5) * 2) * 3;
        r = 150; g = 70; b = 58;
      } else {
        const alto = v * h;
        if (cara === 0) { x = -8 + u * w; y = 6; }
        else if (cara === 1) { x = -8 + u * w; y = 6 + d; }
        else if (cara === 2) { x = -8; y = 6 + u * d; }
        else { x = -8 + w; y = 6 + u * d; }
        z = alto + 1;
        const ventana = (Math.floor(u * 6) % 2 === 0 && alto % 3 > 1.6) ? 0.35 : 1;
        r = 205 * ventana; g = 198 * ventana; b = 180 * ventana;
      }
      z += Math.sin(x * 0.18) * 1.4;
      cls = 6;
    } else {
      // Arbol
      const a = rnd() * Math.PI * 2;
      const rad = Math.pow(rnd(), 0.4) * 3.2;
      x = 14 + Math.cos(a) * rad;
      y = -12 + Math.sin(a) * rad;
      z = 4 + Math.sqrt(Math.max(0, 3.4 * 3.4 - rad * rad)) * 1.3 + rnd() * 0.6;
      r = 45 + rnd() * 40; g = 95 + rnd() * 70; b = 35 + rnd() * 30;
      cls = 5;
    }
    const intensidad = Math.round(3000 + (z + 3) * 2500 + rnd() * 1500);
    yield [
      ORIGEN[0] + x, ORIGEN[1] + y, ORIGEN[2] + z,
      Math.round(r), Math.round(g), Math.round(b),
      Math.min(65535, intensidad), cls,
    ];
  }
}

function escribirLas(ruta, n) {
  const ESCALA = 0.001;
  const REC = 34;                        // PDRF 3: XYZ + intensidad + GPS + RGB
  const CABECERO = 227;
  const puntos = Buffer.alloc(n * REC);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let i = 0;
  for (const [x, y, z, r, g, b, inten, cls] of generar(n)) {
    const o = i * REC;
    puntos.writeInt32LE(Math.round((x - ORIGEN[0]) / ESCALA), o);
    puntos.writeInt32LE(Math.round((y - ORIGEN[1]) / ESCALA), o + 4);
    puntos.writeInt32LE(Math.round((z - ORIGEN[2]) / ESCALA), o + 8);
    puntos.writeUInt16LE(inten, o + 12);
    puntos.writeUInt8(0x11, o + 14);
    puntos.writeUInt8(cls, o + 15);
    puntos.writeInt8(0, o + 16);
    puntos.writeUInt8(0, o + 17);
    puntos.writeUInt16LE(1, o + 18);
    puntos.writeDoubleLE(0, o + 20);
    // RGB de 16 bits, como manda la especificacion (r << 8).
    puntos.writeUInt16LE(r << 8, o + 28);
    puntos.writeUInt16LE(g << 8, o + 30);
    puntos.writeUInt16LE(b << 8, o + 32);
    min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x);
    min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y);
    min[2] = Math.min(min[2], z); max[2] = Math.max(max[2], z);
    i++;
  }

  const h = Buffer.alloc(CABECERO);
  h.write('LASF', 0, 'ascii');
  h.writeUInt8(1, 24); h.writeUInt8(2, 25);           // LAS 1.2
  h.write('generador de prueba', 58, 32, 'ascii');
  h.writeUInt16LE(CABECERO, 94);
  h.writeUInt32LE(CABECERO, 96);                       // offset a los puntos
  h.writeUInt32LE(0, 100);                             // sin VLR
  h.writeUInt8(3, 104);                                // PDRF 3
  h.writeUInt16LE(REC, 105);
  h.writeUInt32LE(n, 107);
  for (let k = 0; k < 3; k++) h.writeDoubleLE(ESCALA, 131 + k * 8);
  for (let k = 0; k < 3; k++) h.writeDoubleLE(ORIGEN[k], 155 + k * 8);
  h.writeDoubleLE(max[0], 179); h.writeDoubleLE(min[0], 187);
  h.writeDoubleLE(max[1], 195); h.writeDoubleLE(min[1], 203);
  h.writeDoubleLE(max[2], 211); h.writeDoubleLE(min[2], 219);

  fs.writeFileSync(ruta, Buffer.concat([h, puntos]));
}

function escribirPly(ruta, n) {
  const REC = 3 * 4 + 3;
  const cuerpo = Buffer.alloc(n * REC);
  let i = 0;
  for (const [x, y, z, r, g, b] of generar(n)) {
    const o = i * REC;
    cuerpo.writeFloatLE(x - ORIGEN[0], o);
    cuerpo.writeFloatLE(y - ORIGEN[1], o + 4);
    cuerpo.writeFloatLE(z - ORIGEN[2], o + 8);
    cuerpo.writeUInt8(r, o + 12); cuerpo.writeUInt8(g, o + 13); cuerpo.writeUInt8(b, o + 14);
    i++;
  }
  const cab = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n`
    + 'property float x\nproperty float y\nproperty float z\n'
    + 'property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
  fs.writeFileSync(ruta, Buffer.concat([Buffer.from(cab, 'ascii'), cuerpo]));
}

function escribirXyz(ruta, n) {
  const salida = fs.createWriteStream(ruta);
  let linea = '';
  let i = 0;
  for (const [x, y, z, r, g, b] of generar(n)) {
    linea += `${x.toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)} ${r} ${g} ${b}\n`;
    if (++i % 5000 === 0) { salida.write(linea); linea = ''; }
  }
  salida.write(linea);
  salida.end();
}

const ext = salida.split('.').pop().toLowerCase();
if (ext === 'las') escribirLas(salida, total);
else if (ext === 'ply') escribirPly(salida, total);
else escribirXyz(salida, total);
console.log(`${salida}: ${total.toLocaleString('es-ES')} puntos`);
