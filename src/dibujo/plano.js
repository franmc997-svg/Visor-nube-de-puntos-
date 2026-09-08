// Planos de trabajo: el "papel" sobre el que se dibuja.
//
// La decision de fondo del modulo: NO se dibuja sobre la nube, se dibuja sobre
// un plano. Una nube no tiene superficie (son puntos sueltos con huecos), asi
// que pegar el trazo a la profundidad da lineas onduladas que siguen el ruido
// del escaner y se cuelan por las ventanas hasta el muro del fondo. Sobre un
// plano ajustado a la fachada el trazo sale limpio, es estable al orbitar y
// tiene coordenadas 2D reales (u,v en metros) que sirven para exportar.
//
// Todo aqui trabaja en el espacio LOCAL de la nube (el de payload.position, ya
// con el origen restado), no en el mundo de three: asi el dibujo sigue a la
// nube si se cambia el eje vertical.

import * as THREE from 'three';

export class Plano {
  /**
   * @param {THREE.Vector3} origen  punto del plano, en coordenadas locales
   * @param {THREE.Vector3} u       eje horizontal del papel (unitario)
   * @param {THREE.Vector3} v       eje vertical del papel (unitario)
   */
  constructor(origen, u, v) {
    this.origen = origen.clone();
    this.u = u.clone().normalize();
    this.v = v.clone().normalize();
    this.n = new THREE.Vector3().crossVectors(this.u, this.v).normalize();
    // Cuanto se separa el dibujo del plano hacia la camara. Sin esto el trazo
    // se entierra entre los puntos y aparece a parches segun el angulo.
    this.separacion = 0;
    this.id = `p${Math.random().toString(36).slice(2, 9)}`;
    this.rms = 0;
    this.puntosAjuste = 0;
  }

  /** Punto local -> coordenadas del papel. w = distancia con signo al plano. */
  aPlano(p) {
    const d = _v1.copy(p).sub(this.origen);
    return { u: d.dot(this.u), v: d.dot(this.v), w: d.dot(this.n) };
  }

  /** Coordenadas del papel -> punto local, ya separado hacia la camara. */
  desdePlano(u, v, destino = new THREE.Vector3()) {
    return destino.copy(this.origen)
      .addScaledVector(this.u, u)
      .addScaledVector(this.v, v)
      .addScaledVector(this.n, this.separacion);
  }

  /** El plano matematico, para intersecar rayos. */
  comoTHREE(destino = new THREE.Plane()) {
    return destino.setFromNormalAndCoplanarPoint(this.n, this.origen);
  }

  /**
   * Orienta la normal (y la separacion) hacia el lado desde el que se mira.
   * Una fachada se dibuja siempre desde fuera; asi el trazo queda por delante.
   */
  orientarHacia(camaraLocal, separacion) {
    const haciaCamara = _v1.copy(camaraLocal).sub(this.origen);
    if (haciaCamara.dot(this.n) < 0) {
      this.n.negate();
      this.u.negate();   // se mantiene el sistema a derechas
    }
    this.separacion = separacion;
    return this;
  }

  serializar() {
    return {
      id: this.id,
      origen: this.origen.toArray(),
      u: this.u.toArray(),
      v: this.v.toArray(),
      separacion: this.separacion,
      rms: this.rms,
      puntosAjuste: this.puntosAjuste,
    };
  }

  static deserializar(o) {
    const p = new Plano(
      new THREE.Vector3().fromArray(o.origen),
      new THREE.Vector3().fromArray(o.u),
      new THREE.Vector3().fromArray(o.v),
    );
    p.id = o.id || p.id;
    p.separacion = o.separacion || 0;
    p.rms = o.rms || 0;
    p.puntosAjuste = o.puntosAjuste || 0;
    return p;
  }
}

const _v1 = new THREE.Vector3();

/**
 * Construye la base (u,v) de un plano a partir de su normal.
 *
 * `arriba` es la vertical de la nube en coordenadas locales. El eje v del papel
 * se alinea con ella siempre que se pueda: al dibujar una fachada, "arriba" en
 * el papel es arriba en el edificio, que es lo unico que no desorienta.
 */
export function baseDesdeNormal(normal, arriba) {
  const n = normal.clone().normalize();
  let v = arriba.clone().addScaledVector(n, -arriba.dot(n));
  if (v.lengthSq() < 1e-8) {
    // Plano horizontal (suelo o techo): no hay "arriba" proyectable. Se toma
    // un eje cualquiera perpendicular y estable.
    const alterno = Math.abs(n.x) < 0.9 ? _AUX_X : _AUX_Y;
    v = alterno.clone().addScaledVector(n, -alterno.dot(n));
  }
  v.normalize();
  const u = new THREE.Vector3().crossVectors(v, n).normalize();
  return { u, v };
}

const _AUX_X = new THREE.Vector3(1, 0, 0);
const _AUX_Y = new THREE.Vector3(0, 1, 0);

/**
 * Ajusta un plano a los puntos de la nube alrededor de `centro`.
 *
 * Es un PCA sobre la covarianza de los vecinos: el autovector de menor valor
 * propio es la normal. Se hace en dos pasadas, descartando en la segunda los
 * puntos a mas de 2 sigma del plano inicial; sin eso, un balcon o un arbol
 * delante de la fachada inclinan el papel varios grados.
 *
 * El recorrido es lineal sobre todo el buffer (no hay octree). A 8 M de puntos
 * son ~40 ms, aceptable para una accion puntual; por encima de `MUESTRAS_MAX`
 * se avanza a saltos, y como el buffer viene barajado de la carga, el salto es
 * un muestreo uniforme y no un corte por franjas.
 *
 * @returns {{plano: Plano, ok: boolean, motivo?: string}}
 */
export function ajustarPlano(posiciones, total, centro, radio, arriba) {
  const MUESTRAS_MAX = 400_000;
  const paso = Math.max(1, Math.ceil(total / MUESTRAS_MAX));
  const r2 = radio * radio;
  const cx = centro.x, cy = centro.y, cz = centro.z;

  // --- primera pasada: centroide y covarianza -------------------------------
  let n = 0, sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < total; i += paso) {
    const j = i * 3;
    const dx = posiciones[j] - cx, dy = posiciones[j + 1] - cy, dz = posiciones[j + 2] - cz;
    if (dx * dx + dy * dy + dz * dz > r2) continue;
    sx += dx; sy += dy; sz += dz; n++;
  }
  if (n < 12) return { plano: null, ok: false, motivo: 'pocos', puntos: n };

  const mx = sx / n, my = sy / n, mz = sz / n;
  let ajuste = covarianza(posiciones, total, paso, cx, cy, cz, r2, mx, my, mz, null, 0);
  let normal = normalDeCovarianza(ajuste.c);

  // --- segunda pasada: se repite sin los puntos que se salen del plano ------
  const rms1 = rmsAlPlano(posiciones, total, paso, cx, cy, cz, r2, mx, my, mz, normal);
  if (rms1 > 0) {
    const refinado = covarianza(
      posiciones, total, paso, cx, cy, cz, r2, mx, my, mz, normal, 2 * rms1,
    );
    if (refinado.n >= 12) {
      ajuste = refinado;
      normal = normalDeCovarianza(refinado.c);
    }
  }

  const origen = new THREE.Vector3(cx + ajuste.mx, cy + ajuste.my, cz + ajuste.mz);
  const { u, v } = baseDesdeNormal(normal, arriba);
  const plano = new Plano(origen, u, v);
  plano.rms = rmsAlPlano(posiciones, total, paso, cx, cy, cz, r2, ajuste.mx, ajuste.my, ajuste.mz, normal);
  plano.puntosAjuste = ajuste.n * paso;
  return { plano, ok: true, puntos: ajuste.n };
}

/** Covarianza de los vecinos, opcionalmente filtrando por distancia al plano. */
function covarianza(pos, total, paso, cx, cy, cz, r2, mx, my, mz, normal, corte) {
  let n = 0, sx = 0, sy = 0, sz = 0;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  const nx = normal?.x || 0, ny = normal?.y || 0, nz = normal?.z || 0;
  for (let i = 0; i < total; i += paso) {
    const j = i * 3;
    const dx = pos[j] - cx, dy = pos[j + 1] - cy, dz = pos[j + 2] - cz;
    if (dx * dx + dy * dy + dz * dz > r2) continue;
    if (normal) {
      const d = (dx - mx) * nx + (dy - my) * ny + (dz - mz) * nz;
      if (Math.abs(d) > corte) continue;
    }
    sx += dx; sy += dy; sz += dz;
    n++;
  }
  if (n < 3) return { n: 0, c: null, mx, my, mz };
  const px = sx / n, py = sy / n, pz = sz / n;
  for (let i = 0; i < total; i += paso) {
    const j = i * 3;
    const dx = pos[j] - cx, dy = pos[j + 1] - cy, dz = pos[j + 2] - cz;
    if (dx * dx + dy * dy + dz * dz > r2) continue;
    if (normal) {
      const d = (dx - mx) * nx + (dy - my) * ny + (dz - mz) * nz;
      if (Math.abs(d) > corte) continue;
    }
    const ax = dx - px, ay = dy - py, az = dz - pz;
    xx += ax * ax; xy += ax * ay; xz += ax * az;
    yy += ay * ay; yz += ay * az; zz += az * az;
  }
  return { n, mx: px, my: py, mz: pz, c: [xx / n, xy / n, xz / n, yy / n, yz / n, zz / n] };
}

function rmsAlPlano(pos, total, paso, cx, cy, cz, r2, mx, my, mz, normal) {
  let n = 0, s = 0;
  for (let i = 0; i < total; i += paso) {
    const j = i * 3;
    const dx = pos[j] - cx, dy = pos[j + 1] - cy, dz = pos[j + 2] - cz;
    if (dx * dx + dy * dy + dz * dz > r2) continue;
    const d = (dx - mx) * normal.x + (dy - my) * normal.y + (dz - mz) * normal.z;
    s += d * d; n++;
  }
  return n ? Math.sqrt(s / n) : 0;
}

/** Autovector del menor autovalor de una covarianza simetrica 3x3 (Jacobi). */
function normalDeCovarianza(c) {
  if (!c) return new THREE.Vector3(0, 0, 1);
  const a = [[c[0], c[1], c[2]], [c[1], c[3], c[4]], [c[2], c[4], c[5]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let barrido = 0; barrido < 24; barrido++) {
    let fuera = 0;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) fuera += a[p][q] * a[p][q];
    if (fuera < 1e-24) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(t * t + 1), sin = t * cos;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = cos * akp - sin * akq;
          a[k][q] = sin * akp + cos * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = cos * apk - sin * aqk;
          a[q][k] = sin * apk + cos * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = cos * vkp - sin * vkq;
          v[k][q] = sin * vkp + cos * vkq;
        }
      }
    }
  }
  let menor = 0;
  for (let i = 1; i < 3; i++) if (a[i][i] < a[menor][menor]) menor = i;
  return new THREE.Vector3(v[0][menor], v[1][menor], v[2][menor]).normalize();
}
