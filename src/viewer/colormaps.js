// Mapas de color generados como LUT de 256x1 (RGBA8) y consumidos por el shader.

function hex(h) {
  return [(h >> 16) & 255, (h >> 8) & 255, h & 255];
}

function ramp(stops) {
  const data = new Uint8Array(256 * 4);
  const n = stops.length - 1;
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * n;
    const k = Math.min(n - 1, Math.floor(t));
    const f = t - k;
    const a = hex(stops[k]), b = hex(stops[k + 1]);
    data[i * 4] = a[0] + (b[0] - a[0]) * f;
    data[i * 4 + 1] = a[1] + (b[1] - a[1]) * f;
    data[i * 4 + 2] = a[2] + (b[2] - a[2]) * f;
    data[i * 4 + 3] = 255;
  }
  return data;
}

export const COLORMAPS = {
  turbo: {
    label: 'Turbo',
    data: ramp([0x30123b, 0x4145ab, 0x4675ed, 0x39a2fc, 0x1bcfd4, 0x24eca6, 0x61fc6c,
      0xa4fc3b, 0xd1e834, 0xf3c63a, 0xfe9b2d, 0xf36315, 0xd93806, 0xb11901, 0x7a0403]),
  },
  viridis: {
    label: 'Viridis',
    data: ramp([0x440154, 0x482878, 0x3e4a89, 0x31688e, 0x26828e, 0x1f9e89, 0x35b779, 0x6ece58, 0xfde725]),
  },
  inferno: {
    label: 'Inferno',
    data: ramp([0x000004, 0x1b0c41, 0x4a0c6b, 0x781c6d, 0xa52c60, 0xcf4446, 0xed6925, 0xfb9b06, 0xf7d13d, 0xfcffa4]),
  },
  gris: {
    label: 'Escala de grises',
    data: ramp([0x101010, 0xffffff]),
  },
  terreno: {
    label: 'Terreno',
    data: ramp([0x2b5a2b, 0x6d8f3a, 0xc2b280, 0x9c6b4f, 0x8a8a8a, 0xffffff]),
  },
};

/** Paleta discreta de clases ASPRS (LAS). El indice del LUT es la clase. */
export function classificationLut() {
  const data = new Uint8Array(256 * 4);
  const base = [
    [0, 0xa0a0a0], [1, 0xc8c8c8], [2, 0x8b5a2b], [3, 0x7bbf5a], [4, 0x3f9e3f],
    [5, 0x1f6b1f], [6, 0xd4513a], [7, 0xff00ff], [8, 0xffff00], [9, 0x2a7ad4],
    [10, 0xb87333], [11, 0x5a5a5a], [12, 0xdddddd], [13, 0xffa500], [14, 0xffd700],
    [15, 0x00ced1], [16, 0xff69b4], [17, 0x8fbc8f], [18, 0xdc143c],
  ];
  // Cualquier clase no listada: un gris neutro en vez de negro (se vería como un agujero).
  for (let i = 0; i < 256; i++) {
    data[i * 4] = 0x77; data[i * 4 + 1] = 0x77; data[i * 4 + 2] = 0x77; data[i * 4 + 3] = 255;
  }
  for (const [idx, color] of base) {
    const c = hex(color);
    data[idx * 4] = c[0]; data[idx * 4 + 1] = c[1]; data[idx * 4 + 2] = c[2]; data[idx * 4 + 3] = 255;
  }
  return data;
}

export const CLASS_NAMES = {
  0: 'Sin clasificar', 1: 'No asignado', 2: 'Suelo', 3: 'Vegetacion baja',
  4: 'Vegetacion media', 5: 'Vegetacion alta', 6: 'Edificacion', 7: 'Ruido bajo',
  8: 'Punto clave', 9: 'Agua', 10: 'Ferrocarril', 11: 'Superficie de carretera',
  12: 'Solape', 13: 'Cable guarda', 14: 'Conductor', 15: 'Torre',
  16: 'Conector', 17: 'Tablero de puente', 18: 'Ruido alto',
};
