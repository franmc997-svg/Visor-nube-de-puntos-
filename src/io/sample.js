// Acumulador de puntos con submuestreo aleatorio en streaming.
//
// Dos decisiones importantes aqui:
//  1. Las posiciones se guardan en Float32 RELATIVAS a un origen. Un LAS en UTM
//     tiene coordenadas de ~500.000 m; en Float32 el epsilon a esa magnitud es
//     ~6 cm y la nube "vibra" al orbitar. Restando el origen el error baja a
//     micras dentro del bbox tipico.
//  2. Si el fichero trae mas puntos que el presupuesto, se descartan DURANTE el
//     parseo (no despues), para no tocar nunca el pico de memoria que mata la
//     pestaña en iOS.

/** PRNG xorshift32: determinista, sin allocaciones, ~10x mas rapido que Math.random. */
export function makeRandom(seed = 0x9e3779b9) {
  let s = seed >>> 0 || 1;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

export class PointBuffer {
  /**
   * @param {number} capacity  numero maximo de puntos a retener
   * @param {object} opts      { color, intensity, classification }
   */
  constructor(capacity, opts = {}) {
    this.capacity = Math.max(1, capacity | 0);
    this.count = 0;
    this.position = new Float32Array(this.capacity * 3);
    this.color = opts.color ? new Uint8Array(this.capacity * 3) : null;
    this.intensity = opts.intensity ? new Uint16Array(this.capacity) : null;
    this.classification = opts.classification ? new Uint8Array(this.capacity) : null;

    this.origin = null;                     // [x,y,z] en coordenadas del fichero
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];

    this.acceptProb = 1;                    // fijado por setSourceCount()
    this.seen = 0;                          // puntos leidos del fichero
    this._rand = makeRandom();
    this._intHist = new Uint32Array(1024);  // histograma de intensidad (para percentiles)
  }

  /** Fija la probabilidad de aceptacion sabiendo cuantos puntos trae el fichero. */
  setSourceCount(total) {
    this.sourceCount = total;
    if (total > this.capacity) {
      // 0.98 de margen: evita que la varianza binomial llene el buffer antes de
      // tiempo y acabemos recortando la cola (sesgo espacial hacia el principio).
      this.acceptProb = (this.capacity * 0.98) / total;
    } else {
      this.acceptProb = 1;
    }
  }

  /** Fija el origen a partir del bbox del cabecero, si se conoce. */
  setOrigin(x, y, z) {
    this.origin = [x, y, z];
  }

  /**
   * Añade un punto. Devuelve true si se retuvo.
   * r,g,b en 0-255. intensity en 0-65535.
   */
  add(x, y, z, r, g, b, intensity, classification) {
    this.seen++;
    if (this.acceptProb < 1 && this._rand() >= this.acceptProb) return false;
    const i = this.count;
    if (i >= this.capacity) return false;

    if (this.origin === null) this.origin = [x, y, z];
    const o = this.origin;

    const p = i * 3;
    this.position[p] = x - o[0];
    this.position[p + 1] = y - o[1];
    this.position[p + 2] = z - o[2];

    if (x < this.min[0]) this.min[0] = x;
    if (y < this.min[1]) this.min[1] = y;
    if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x;
    if (y > this.max[1]) this.max[1] = y;
    if (z > this.max[2]) this.max[2] = z;

    if (this.color) {
      this.color[p] = r;
      this.color[p + 1] = g;
      this.color[p + 2] = b;
    }
    if (this.intensity) {
      const iv = intensity | 0;
      this.intensity[i] = iv;
      this._intHist[(iv >>> 6) & 1023]++;
    }
    if (this.classification) this.classification[i] = classification | 0;

    this.count = i + 1;
    return true;
  }

  /**
   * Reduce el buffer a la mitad y baja la probabilidad de aceptacion.
   *
   * Se usa con formatos de texto, donde no se sabe cuantos puntos trae el
   * fichero hasta terminarlo: en vez de adivinar, se va decimando sobre la
   * marcha. Conservar los indices pares de un subconjunto ya aleatorio sigue
   * siendo un submuestreo uniforme.
   */
  halve() {
    const n = this.count;
    const pos = this.position, col = this.color, int = this.intensity, cls = this.classification;
    let w = 0;
    for (let r = 0; r < n; r += 2, w++) {
      const a = w * 3, b = r * 3;
      pos[a] = pos[b]; pos[a + 1] = pos[b + 1]; pos[a + 2] = pos[b + 2];
      if (col) { col[a] = col[b]; col[a + 1] = col[b + 1]; col[a + 2] = col[b + 2]; }
      if (int) int[w] = int[r];
      if (cls) cls[w] = cls[r];
    }
    this.count = w;
    this.acceptProb /= 2;
  }

  /** Percentiles de intensidad (2%-98%) para no quemar el rango con outliers. */
  intensityRange() {
    if (!this.intensity || this.count === 0) return [0, 65535];
    const h = this._intHist;
    let total = 0;
    for (let i = 0; i < h.length; i++) total += h[i];
    if (total === 0) return [0, 65535];
    const lo = total * 0.02, hi = total * 0.98;
    let acc = 0, a = 0, b = 1023;
    for (let i = 0; i < h.length; i++) { acc += h[i]; if (acc >= lo) { a = i; break; } }
    acc = 0;
    for (let i = 0; i < h.length; i++) { acc += h[i]; if (acc >= hi) { b = i; break; } }
    if (b <= a) b = a + 1;
    return [a << 6, Math.min(65535, ((b + 1) << 6) - 1)];
  }

  /** Recorta los arrays al tamaño real y devuelve el payload transferible. */
  finish() {
    const n = this.count;
    const out = {
      count: n,
      origin: this.origin || [0, 0, 0],
      min: this.min,
      max: this.max,
      sourceCount: this.sourceCount || this.seen,
      position: this.position.length === n * 3 ? this.position : this.position.slice(0, n * 3),
    };
    if (this.color) out.color = this.color.length === n * 3 ? this.color : this.color.slice(0, n * 3);
    if (this.intensity) {
      out.intensity = this.intensity.length === n ? this.intensity : this.intensity.slice(0, n);
      out.intensityRange = this.intensityRange();
    }
    if (this.classification) {
      out.classification = this.classification.length === n ? this.classification : this.classification.slice(0, n);
    }
    // Liberamos referencias grandes por si el worker sobrevive a la transferencia.
    this.position = new Float32Array(0);
    this.color = this.intensity = this.classification = null;
    return out;
  }
}

/**
 * Baraja el resultado in-place (Fisher-Yates).
 *
 * Esto es lo que hace posible el LOD gratis: con el buffer barajado,
 * dibujar los primeros N puntos es un submuestreo uniforme y espacialmente
 * insesgado de la nube entera. Sin barajar, dibujar el 30% te deja un tercio
 * del edificio y el resto vacio.
 */
export function shuffleResult(result) {
  const n = result.count;
  const pos = result.position, col = result.color, int = result.intensity, cls = result.classification;
  const rand = makeRandom(0x1234567);
  for (let i = n - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    if (j === i) continue;
    const a = i * 3, b = j * 3;
    let t;
    t = pos[a];     pos[a] = pos[b];         pos[b] = t;
    t = pos[a + 1]; pos[a + 1] = pos[b + 1]; pos[b + 1] = t;
    t = pos[a + 2]; pos[a + 2] = pos[b + 2]; pos[b + 2] = t;
    if (col) {
      t = col[a];     col[a] = col[b];         col[b] = t;
      t = col[a + 1]; col[a + 1] = col[b + 1]; col[b + 1] = t;
      t = col[a + 2]; col[a + 2] = col[b + 2]; col[b + 2] = t;
    }
    if (int) { t = int[i]; int[i] = int[j]; int[j] = t; }
    if (cls) { t = cls[i]; cls[i] = cls[j]; cls[j] = t; }
  }
  return result;
}
