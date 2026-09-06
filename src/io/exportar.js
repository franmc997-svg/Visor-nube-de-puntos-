// Escritura de nubes: PLY binario y LAS 1.2. Se usa para sacar el dibujo (y,
// si se pide, la nube entera con el dibujo dentro) a un fichero que abre
// cualquier software de nubes, incluido este mismo visor.
//
// Los ficheros se montan por trozos y se juntan en un Blob al final. Reservar
// un unico ArrayBuffer de 200 MB en un iPhone es la forma mas rapida de que
// Safari cierre la pestaña; con trozos de pocos MB el navegador puede ir
// llevandolos a disco.

const PUNTOS_POR_TROZO = 100_000;

/**
 * Fuente de puntos para los escritores.
 * @typedef {object} FuenteDePuntos
 * @property {number} count
 * @property {(i:number, destino:Float64Array) => void} leerPosicion  absoluta
 * @property {(i:number, destino:Uint8Array) => void} leerColor       0-255
 */

/** Junta la nube cargada (opcional) y los puntos del dibujo en una sola fuente. */
export function fuenteCombinada({ nube, dibujo, incluirNube }) {
  const nNube = incluirNube && nube ? nube.count : 0;
  const nDibujo = dibujo ? dibujo.count : 0;
  const o = nube ? nube.origin : [0, 0, 0];

  return {
    count: nNube + nDibujo,
    conNube: nNube > 0,
    leerPosicion(i, destino) {
      if (i < nNube) {
        const j = i * 3;
        destino[0] = nube.position[j] + o[0];
        destino[1] = nube.position[j + 1] + o[1];
        destino[2] = nube.position[j + 2] + o[2];
      } else {
        const j = (i - nNube) * 3;
        destino[0] = dibujo.position[j] + o[0];
        destino[1] = dibujo.position[j + 1] + o[1];
        destino[2] = dibujo.position[j + 2] + o[2];
      }
    },
    leerColor(i, destino) {
      if (i < nNube) {
        if (!nube.color) { destino[0] = destino[1] = destino[2] = 200; return; }
        const j = i * 3;
        destino[0] = nube.color[j];
        destino[1] = nube.color[j + 1];
        destino[2] = nube.color[j + 2];
      } else {
        const j = (i - nNube) * 3;
        destino[0] = dibujo.color[j];
        destino[1] = dibujo.color[j + 1];
        destino[2] = dibujo.color[j + 2];
      }
    },
  };
}

/**
 * PLY binario little-endian con x,y,z en `double` y color en `uchar`.
 *
 * Doble precision a proposito: una fachada en UTM esta a 500.000 m del origen,
 * y en Float32 eso son saltos de 6 cm. Un dibujo de fachada con 6 cm de error
 * no vale para nada.
 */
export function escribirPLY(fuente) {
  const cabecera = [
    'ply',
    'format binary_little_endian 1.0',
    'comment Generado por el visor de nube de puntos',
    `element vertex ${fuente.count}`,
    'property double x',
    'property double y',
    'property double z',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'end_header',
    '',
  ].join('\n');

  const trozos = [new TextEncoder().encode(cabecera)];
  const REG = 27;   // 3 doubles + 3 bytes
  const pos = new Float64Array(3);
  const col = new Uint8Array(3);

  for (let inicio = 0; inicio < fuente.count; inicio += PUNTOS_POR_TROZO) {
    const n = Math.min(PUNTOS_POR_TROZO, fuente.count - inicio);
    const buf = new ArrayBuffer(n * REG);
    const vista = new DataView(buf);
    for (let k = 0; k < n; k++) {
      const off = k * REG;
      fuente.leerPosicion(inicio + k, pos);
      fuente.leerColor(inicio + k, col);
      vista.setFloat64(off, pos[0], true);
      vista.setFloat64(off + 8, pos[1], true);
      vista.setFloat64(off + 16, pos[2], true);
      vista.setUint8(off + 24, col[0]);
      vista.setUint8(off + 25, col[1]);
      vista.setUint8(off + 26, col[2]);
    }
    trozos.push(new Uint8Array(buf));
  }
  return new Blob(trozos, { type: 'application/octet-stream' });
}

/**
 * LAS 1.2, formato de punto 2 (XYZ + intensidad + clase + RGB).
 *
 * Las coordenadas van como enteros de 32 bits sobre una escala y un offset,
 * que es como LAS conserva la georreferencia sin perder precision. El offset
 * es el origen de la nube y la escala 1 mm, salvo que la nube sea tan grande
 * que a 1 mm se desborde el entero.
 */
export function escribirLAS(fuente, { min, max, origen }) {
  const extension = Math.max(
    max[0] - min[0], max[1] - min[1], max[2] - min[2], 1,
  );
  const escala = Math.max(0.001, extension / 2_000_000_000);
  const offset = origen || [0, 0, 0];

  const CAB = 227;
  const REG = 26;
  const cab = new ArrayBuffer(CAB);
  const v = new DataView(cab);
  const bytes = new Uint8Array(cab);
  const texto = (s, off, largo) => {
    const b = new TextEncoder().encode(s.slice(0, largo));
    bytes.set(b, off);
  };

  texto('LASF', 0, 4);
  v.setUint8(24, 1);                       // version 1.2
  v.setUint8(25, 2);
  texto('visor-nube-de-puntos', 26, 32);
  texto('visor-nube-de-puntos', 58, 32);
  const hoy = new Date();
  const inicioAno = Date.UTC(hoy.getUTCFullYear(), 0, 0);
  v.setUint16(90, Math.floor((hoy.getTime() - inicioAno) / 86400000), true);
  v.setUint16(92, hoy.getUTCFullYear(), true);
  v.setUint16(94, CAB, true);
  v.setUint32(96, CAB, true);
  v.setUint32(100, 0, true);               // sin VLR
  v.setUint8(104, 2);                      // formato de punto 2: con RGB
  v.setUint16(105, REG, true);
  v.setUint32(107, fuente.count, true);
  v.setUint32(111, fuente.count, true);    // todos en el primer retorno
  v.setFloat64(131, escala, true);
  v.setFloat64(139, escala, true);
  v.setFloat64(147, escala, true);
  v.setFloat64(155, offset[0], true);
  v.setFloat64(163, offset[1], true);
  v.setFloat64(171, offset[2], true);
  v.setFloat64(179, max[0] + offset[0], true); v.setFloat64(187, min[0] + offset[0], true);
  v.setFloat64(195, max[1] + offset[1], true); v.setFloat64(203, min[1] + offset[1], true);
  v.setFloat64(211, max[2] + offset[2], true); v.setFloat64(219, min[2] + offset[2], true);

  const trozos = [bytes];
  const pos = new Float64Array(3);
  const col = new Uint8Array(3);

  for (let inicio = 0; inicio < fuente.count; inicio += PUNTOS_POR_TROZO) {
    const n = Math.min(PUNTOS_POR_TROZO, fuente.count - inicio);
    const buf = new ArrayBuffer(n * REG);
    const vista = new DataView(buf);
    for (let k = 0; k < n; k++) {
      const off = k * REG;
      fuente.leerPosicion(inicio + k, pos);
      fuente.leerColor(inicio + k, col);
      vista.setInt32(off, Math.round((pos[0] - offset[0]) / escala), true);
      vista.setInt32(off + 4, Math.round((pos[1] - offset[1]) / escala), true);
      vista.setInt32(off + 8, Math.round((pos[2] - offset[2]) / escala), true);
      vista.setUint16(off + 12, 0, true);      // intensidad
      vista.setUint8(off + 14, 0b0001_0001);   // 1 retorno de 1
      vista.setUint8(off + 15, 0);             // clasificacion
      vista.setInt8(off + 16, 0);              // angulo de escaneo
      vista.setUint8(off + 17, 0);             // datos de usuario
      vista.setUint16(off + 18, 0, true);      // id de fuente
      // LAS guarda el color en 16 bits; se replica el byte (0xAB -> 0xABAB)
      // para que 255 sea el maximo real y no un 0,4 % de gris.
      vista.setUint16(off + 20, col[0] * 257, true);
      vista.setUint16(off + 22, col[1] * 257, true);
      vista.setUint16(off + 24, col[2] * 257, true);
    }
    trozos.push(new Uint8Array(buf));
  }
  return new Blob(trozos, { type: 'application/octet-stream' });
}

/** Extremos (relativos al origen) de una fuente, para el cabecero del LAS. */
export function extremos(fuente, origen) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const pos = new Float64Array(3);
  for (let i = 0; i < fuente.count; i++) {
    fuente.leerPosicion(i, pos);
    for (let k = 0; k < 3; k++) {
      const x = pos[k] - (origen?.[k] || 0);
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/** Dispara la descarga de un Blob con el nombre dado. */
export function descargar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safari necesita que la URL siga viva un momento despues del click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
