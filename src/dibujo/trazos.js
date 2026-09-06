// Un trazo es una polilinea en coordenadas del papel (u,v en metros sobre su
// plano). Guardar 2D y no 3D no es un detalle de implementacion: es lo que
// permite reconstruir el dibujo exactamente igual aunque cambie la camara, el
// eje vertical o la separacion del plano, y lo que dejaria salir un alzado a
// escala el dia que se añada exportacion a DXF.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

let contador = 0;

export class Trazo {
  /**
   * @param {object} o {plano, puntos: [u,v,u,v...], color: '#rrggbb', grosor: px, cerrado}
   */
  constructor(o) {
    this.id = o.id || `t${Date.now().toString(36)}${(contador++).toString(36)}`;
    this.plano = o.plano;
    this.puntos = o.puntos ? Array.from(o.puntos) : [];
    this.color = o.color || '#ff3b30';
    this.grosor = o.grosor ?? 3;
    this.cerrado = !!o.cerrado;
    this.objeto = null;
    this.material = null;
  }

  get numeroDePuntos() { return this.puntos.length / 2; }

  añadir(u, v) { this.puntos.push(u, v); }

  /** Punto 3D local del vertice i. */
  punto3D(i, destino = new THREE.Vector3()) {
    return this.plano.desdePlano(this.puntos[i * 2], this.puntos[i * 2 + 1], destino);
  }

  /** Longitud real del trazo, en metros. */
  longitud() {
    let l = 0;
    for (let i = 1; i < this.numeroDePuntos; i++) {
      const du = this.puntos[i * 2] - this.puntos[i * 2 - 2];
      const dv = this.puntos[i * 2 + 1] - this.puntos[i * 2 - 1];
      l += Math.hypot(du, dv);
    }
    if (this.cerrado && this.numeroDePuntos > 2) {
      const n = this.numeroDePuntos;
      l += Math.hypot(this.puntos[0] - this.puntos[n * 2 - 2], this.puntos[1] - this.puntos[n * 2 - 1]);
    }
    return l;
  }

  /** Distancia 2D minima del punto (u,v) al trazo, en metros. Para el borrador. */
  distanciaA(u, v) {
    const n = this.numeroDePuntos;
    if (n === 0) return Infinity;
    if (n === 1) return Math.hypot(u - this.puntos[0], v - this.puntos[1]);
    let mejor = Infinity;
    const tramos = this.cerrado ? n : n - 1;
    for (let i = 0; i < tramos; i++) {
      const j = (i + 1) % n;
      mejor = Math.min(mejor, distanciaASegmento(
        u, v,
        this.puntos[i * 2], this.puntos[i * 2 + 1],
        this.puntos[j * 2], this.puntos[j * 2 + 1],
      ));
      if (mejor === 0) break;
    }
    return mejor;
  }

  /** Crea o actualiza el objeto de three. Devuelve el objeto listo para la escena. */
  construir(resolucion) {
    const n = this.numeroDePuntos;
    if (n < 2) { this.destruir(); return null; }

    const vertices = [];
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      this.punto3D(i, p);
      vertices.push(p.x, p.y, p.z);
    }
    if (this.cerrado) {
      this.punto3D(0, p);
      vertices.push(p.x, p.y, p.z);
    }

    if (!this.objeto) {
      // El visor trabaja en sRGB directo (THREE.ColorManagement desactivado en
      // Viewer.js), asi que el color del trazo sale igual que el del boton.
      this.material = new LineMaterial({
        color: new THREE.Color(this.color),
        linewidth: this.grosor,
        worldUnits: false,          // grosor en pixeles: legible de cerca y de lejos
        alphaToCoverage: false,
        dashed: false,
      });
      const geom = new LineGeometry();
      geom.setPositions(vertices);
      this.objeto = new Line2(geom, this.material);
      this.objeto.frustumCulled = false;
      this.objeto.renderOrder = 10;
      this.objeto.userData.trazo = this;
    } else {
      this.objeto.geometry.dispose();
      const geom = new LineGeometry();
      geom.setPositions(vertices);
      this.objeto.geometry = geom;
    }
    if (resolucion) this.material.resolution.copy(resolucion);
    this.material.linewidth = this.grosor;
    return this.objeto;
  }

  destruir() {
    if (!this.objeto) return;
    this.objeto.geometry.dispose();
    this.objeto.material.dispose();
    this.objeto.parent?.remove(this.objeto);
    this.objeto = null;
    this.material = null;
  }

  serializar() {
    return {
      id: this.id,
      plano: this.plano.id,
      // 4 decimales = 0,1 mm. Mas que suficiente y deja el JSON a la mitad.
      puntos: this.puntos.map((x) => Number(x.toFixed(4))),
      color: this.color,
      grosor: this.grosor,
      cerrado: this.cerrado,
    };
  }
}

function distanciaASegmento(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * vx + (py - ay) * vy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * Simplificacion Ramer-Douglas-Peucker sobre la polilinea 2D.
 *
 * Un trazo a mano libre llega con cientos de muestras casi colineales: sin
 * simplificar, cada trazo son cientos de segmentos que hay que reconstruir en
 * la GPU y guardar en el JSON. Con una tolerancia del orden del pixel no se
 * nota ninguna diferencia en pantalla.
 */
export function simplificar(puntos, tolerancia) {
  const n = puntos.length / 2;
  if (n < 3 || tolerancia <= 0) return Array.from(puntos);
  const conservar = new Uint8Array(n);
  conservar[0] = 1;
  conservar[n - 1] = 1;
  const pila = [[0, n - 1]];
  while (pila.length) {
    const [ini, fin] = pila.pop();
    if (fin - ini < 2) continue;
    let peor = 0, indice = -1;
    const ax = puntos[ini * 2], ay = puntos[ini * 2 + 1];
    const bx = puntos[fin * 2], by = puntos[fin * 2 + 1];
    for (let i = ini + 1; i < fin; i++) {
      const d = distanciaASegmento(puntos[i * 2], puntos[i * 2 + 1], ax, ay, bx, by);
      if (d > peor) { peor = d; indice = i; }
    }
    if (peor > tolerancia && indice > 0) {
      conservar[indice] = 1;
      pila.push([ini, indice], [indice, fin]);
    }
  }
  const salida = [];
  for (let i = 0; i < n; i++) {
    if (conservar[i]) salida.push(puntos[i * 2], puntos[i * 2 + 1]);
  }
  return salida;
}

/**
 * Suavizado de Chaikin. Con el dedo (sin lapiz) el trazo llega tembloroso y
 * esto es lo unico que lo hace presentable; con lapiz basta una iteracion.
 */
export function suavizar(puntos, iteraciones = 1) {
  let actual = Array.from(puntos);
  for (let it = 0; it < iteraciones; it++) {
    const n = actual.length / 2;
    if (n < 3) return actual;
    const salida = [actual[0], actual[1]];
    for (let i = 0; i < n - 1; i++) {
      const ax = actual[i * 2], ay = actual[i * 2 + 1];
      const bx = actual[i * 2 + 2], by = actual[i * 2 + 3];
      salida.push(ax + 0.25 * (bx - ax), ay + 0.25 * (by - ay));
      salida.push(ax + 0.75 * (bx - ax), ay + 0.75 * (by - ay));
    }
    salida.push(actual[actual.length - 2], actual[actual.length - 1]);
    actual = salida;
  }
  return actual;
}

/** Puntos de un rectangulo (dos esquinas opuestas) en coordenadas del papel. */
export function rectangulo(u0, v0, u1, v1) {
  return [u0, v0, u1, v0, u1, v1, u0, v1];
}
