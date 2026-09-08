// Dibujo sobre la nube: gestos, herramientas, deshacer y persistencia.
//
// Reglas de gesto (son la mitad del producto en un movil):
//
//   Lapiz (Apple Pencil / stylus)  dibuja SIEMPRE, este el modo que este.
//                                  El dedo sigue orbitando. Es el reparto de
//                                  las apps de croquis y no hay que aprenderlo.
//   Dedo, modo Navegar             orbita como siempre.
//   Dedo, modo Dibujar             un dedo dibuja, DOS dedos siguen girando y
//                                  haciendo zoom. Si aparece el segundo dedo a
//                                  mitad de un trazo, el trazo se cancela.
//   Raton, modo Dibujar            boton izquierdo dibuja, derecho desplaza.
//
// El "un dedo no orbita" se consigue poniendo controls.touches.ONE fuera de los
// valores de THREE.TOUCH: OrbitControls sigue contando los punteros (por eso
// los dos dedos funcionan bien) pero no hace nada con uno solo.

import * as THREE from 'three';
import { Plano, ajustarPlano, baseDesdeNormal } from './plano.js';
import { Trazo, simplificar, suavizar, rectangulo } from './trazos.js';

const UNO_INACTIVO = -1;   // cualquier valor que no sea de THREE.TOUCH/THREE.MOUSE
const SENO_MINIMO = Math.sin(THREE.MathUtils.degToRad(15));
const PASO_ANGULO = Math.PI / 4;                                   // enganche cada 45 grados
const TOLERANCIA_ANGULO = THREE.MathUtils.degToRad(7);
const DESPLAZAMIENTO_TACTIL = 46;                                  // px por encima del dedo

export const COLORES = [
  { id: '#ff3b30', label: 'Rojo' },
  { id: '#ffcc00', label: 'Amarillo' },
  { id: '#34c759', label: 'Verde' },
  { id: '#4da3ff', label: 'Azul' },
  { id: '#ffffff', label: 'Blanco' },
  { id: '#12161c', label: 'Negro' },
];

export class Dibujo {
  constructor(viewer) {
    this.viewer = viewer;
    this.canvas = viewer.canvas;

    this.overlay = viewer.overlay;
    this.planos = new Map();
    this.planoActivo = null;
    this.trazos = [];

    this.modo = 'navegar';
    // Con el dedo, el trazo libre no da precision: la herramienta util por
    // defecto es la polilinea con enganche.
    this.herramienta = 'polilinea';
    this.color = COLORES[0].id;
    this.grosor = 3;
    this.suavizado = 1;
    this.ajustarAPuntos = true;
    this.modoPlano = 'ajuste';    // ajuste | vertical | horizontal | camara
    this.radioAjuste = 0;         // 0 = automatico segun el tamaño de la nube
    this.engancheOrtogonal = true;
    this.desplazamientoTactil = DESPLAZAMIENTO_TACTIL;

    this.pila = [];               // acciones para deshacer
    this.rehacerPila = [];
    this.onCambio = null;
    this.onMensaje = null;
    this.onMira = null;           // mira de puntería: (x,y) de pantalla o null
    this.onCota = null;           // medida en vivo: texto o null

    this.rejilla = null;
    this.verRejilla = true;
    this._punteros = new Set();
    this._trazoActivo = null;
    this._trazoEnCurso = null;    // polilinea a medias entre toques
    this._pendiente = null;       // vertice que se esta arrastrando
    this._vistaPrevia = null;     // linea fantasma hasta el dedo
    this._ultimoRebuild = 0;
    this._rayo = new THREE.Raycaster();
    this._planoTHREE = new THREE.Plane();
    this._inversaRaiz = new THREE.Matrix4();
    this._resolucion = new THREE.Vector2();

    this._conectar();
  }

  // --- ciclo de vida ---------------------------------------------------------

  /** Se llama al cargar una nube nueva: fuera todo lo dibujado. */
  reiniciar() {
    for (const t of this.trazos) t.destruir();
    this._quitarVistaPrevia();
    this._pendiente = null;
    this._cota(null);
    this.trazos = [];
    this.planos.clear();
    this.planoActivo = null;
    this._actualizarRejilla();   // sin plano activo, se limpia y libera sola
    this.pila = [];
    this.rehacerPila = [];
    this._trazoActivo = null;
    this._trazoEnCurso = null;
    this.viewer.needsRender = true;
    this._avisarCambio();
  }

  get hayDibujo() { return this.trazos.length > 0; }

  // --- modo y herramientas ---------------------------------------------------

  setModo(modo) {
    if (this.modo === modo) return;
    this.modo = modo;
    this._terminarPolilinea();
    const c = this.viewer.controls;
    if (modo === 'dibujar') {
      c.touches.ONE = UNO_INACTIVO;
      c.mouseButtons.LEFT = UNO_INACTIVO;
      this.canvas.style.cursor = 'crosshair';
    } else {
      c.touches.ONE = THREE.TOUCH.ROTATE;
      c.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      this.canvas.style.cursor = '';
    }
    this._actualizarRejilla();
    this._avisarCambio();
  }

  /**
   * Rejilla del papel. Es lo unico que dice de un vistazo donde esta el plano y
   * como esta orientado; sin ella el primer trazo siempre sorprende.
   */
  _actualizarRejilla() {
    if (this.rejilla) {
      this.overlay.remove(this.rejilla);
      this.rejilla.geometry.dispose();
      this.rejilla.material.dispose();
      this.rejilla = null;
    }
    const plano = this.planoActivo;
    if (!plano || !this.verRejilla || this.modo !== 'dibujar') { this.viewer.needsRender = true; return; }

    const radio = (this.radioAjuste || this._radioPorDefecto()) * 3;
    const divisiones = 12;
    const paso = (radio * 2) / divisiones;
    const vertices = [];
    const p = new THREE.Vector3();
    for (let i = 0; i <= divisiones; i++) {
      const d = -radio + i * paso;
      plano.desdePlano(d, -radio, p); vertices.push(p.x, p.y, p.z);
      plano.desdePlano(d, radio, p); vertices.push(p.x, p.y, p.z);
      plano.desdePlano(-radio, d, p); vertices.push(p.x, p.y, p.z);
      plano.desdePlano(radio, d, p); vertices.push(p.x, p.y, p.z);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x4da3ff, transparent: true, opacity: 0.28, depthWrite: false,
    });
    this.rejilla = new THREE.LineSegments(geom, mat);
    this.rejilla.frustumCulled = false;
    this.rejilla.renderOrder = 9;
    this.overlay.add(this.rejilla);
    this.viewer.needsRender = true;
  }

  setHerramienta(h) {
    if (this.herramienta === h) return;
    this._terminarPolilinea();
    this.herramienta = h;
    this._avisarCambio();
  }

  setColor(c) { this.color = c; this._avisarCambio(); }
  setGrosor(g) { this.grosor = g; this._avisarCambio(); }

  // --- plano de trabajo ------------------------------------------------------

  /**
   * Fija el papel a partir de un toque en pantalla.
   * @returns {boolean} si se ha podido fijar
   */
  fijarPlanoEn(clientX, clientY) {
    const mundo = this.viewer.pickAt(clientX, clientY);
    if (!mundo) {
      this._mensaje('No hay ningun punto de la nube bajo el dedo: apunta a la superficie donde quieras dibujar.');
      return false;
    }
    const centro = this._aLocal(mundo.clone());
    const arriba = this._verticalLocal();
    const camaraLocal = this._aLocal(this.viewer.camera.position.clone());

    let plano = null;
    if (this.modoPlano === 'ajuste') {
      const radio = this.radioAjuste || this._radioPorDefecto();
      const r = ajustarPlano(this.viewer.cloud.position, this.viewer.cloud.count, centro, radio, arriba);
      if (!r.ok) {
        this._mensaje(`Muy pocos puntos alrededor (${r.puntos}) para ajustar un plano. `
          + 'Acercate, sube el radio de ajuste en el panel, o usa un plano vertical.');
        return false;
      }
      plano = r.plano;
    } else if (this.modoPlano === 'horizontal') {
      const { u, v } = baseDesdeNormal(arriba, arriba);
      plano = new Plano(centro, u, v);
    } else if (this.modoPlano === 'vertical') {
      // Plano vertical que mira a la camara: contiene la vertical de la nube y
      // es perpendicular a la direccion de vista proyectada en horizontal.
      const haciaCamara = camaraLocal.clone().sub(centro);
      haciaCamara.addScaledVector(arriba, -haciaCamara.dot(arriba));
      if (haciaCamara.lengthSq() < 1e-9) haciaCamara.set(1, 0, 0);
      const normal = haciaCamara.normalize();
      const u = new THREE.Vector3().crossVectors(arriba, normal).normalize();
      plano = new Plano(centro, u, arriba);
    } else {
      // 'camara': el papel perpendicular a la vista, como un cristal delante.
      const normal = camaraLocal.clone().sub(centro).normalize();
      const v = arriba.clone().addScaledVector(normal, -arriba.dot(normal));
      if (v.lengthSq() < 1e-9) v.set(0, 1, 0);
      v.normalize();
      const u = new THREE.Vector3().crossVectors(v, normal).normalize();
      plano = new Plano(centro, u, v);
    }

    plano.orientarHacia(camaraLocal, this._separacion());
    this.planos.set(plano.id, plano);
    this.planoActivo = plano;
    this._actualizarRejilla();
    this.viewer.needsRender = true;

    const inclinacion = this.modoPlano === 'ajuste' && plano.rms
      ? ` Ajuste: ${(plano.rms * 1000).toFixed(0)} mm de desviacion.` : '';
    this._mensaje(`Papel fijado.${inclinacion} Ya puedes dibujar.`);
    this._avisarCambio();
    return true;
  }

  /** Radio de vecindad para el ajuste PCA, proporcional al tamaño de la nube. */
  _radioPorDefecto() {
    const r = this.viewer.points?.geometry.boundingSphere?.radius || 10;
    return Math.max(0.15, r * 0.03);
  }

  /** Separacion del dibujo respecto al plano: unos pocos radios de punto. */
  _separacion() {
    const tam = this.viewer.pointMaterial.uniforms.uWorldSize.value || 0.01;
    const r = this.viewer.points?.geometry.boundingSphere?.radius || 10;
    return Math.max(tam * 1.5, r * 1e-4);
  }

  _verticalLocal() {
    const eje = this.viewer.upAxis;
    return new THREE.Vector3(eje === 'x' ? 1 : 0, eje === 'y' ? 1 : 0, eje === 'z' ? 1 : 0);
  }

  _aLocal(pMundo) { return this.viewer.root.worldToLocal(pMundo); }

  // --- conversion pantalla -> papel ------------------------------------------

  /**
   * Punto (u,v) del papel bajo el dedo.
   *
   * Es una interseccion rayo-plano, no una lectura de profundidad: por eso el
   * trazo sale liso aunque debajo haya huecos, ventanas o ruido.
   */
  _puntoEnPapel(clientX, clientY, conAjuste = false) {
    const plano = this.planoActivo;
    if (!plano) return null;

    if (conAjuste && this.ajustarAPuntos) {
      const mundo = this.viewer.pickAt(clientX, clientY);
      if (mundo) {
        const local = this._aLocal(mundo.clone());
        const c = plano.aPlano(local);
        // Solo se acepta si el punto real esta razonablemente cerca del papel:
        // si no, estariamos enganchando el trazo a algo que hay detras.
        if (Math.abs(c.w) < this._radioPorDefecto()) return { u: c.u, v: c.v, ajustado: true };
      }
    }

    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    this._rayo.setFromCamera(ndc, this.viewer.camera);
    this._inversaRaiz.copy(this.viewer.root.matrixWorld).invert();
    const rayo = this._rayo.ray.clone().applyMatrix4(this._inversaRaiz);

    // Papel de canto: por debajo de ~15 grados de incidencia, un pixel de
    // pantalla son metros de papel y el trazo se va al horizonte. Es el fallo
    // clasico de dibujar sobre un plano; mas vale no dejar dibujar.
    if (Math.abs(rayo.direction.dot(plano.n)) < SENO_MINIMO) return null;

    plano.comoTHREE(this._planoTHREE);
    const destino = new THREE.Vector3();
    if (!rayo.intersectPlane(this._planoTHREE, destino)) return null;

    // Aunque la incidencia sea aceptable, cerca del horizonte del plano la
    // interseccion se va muy lejos de la nube. Fuera del volumen de la nube no
    // hay nada que anotar.
    const esfera = this.viewer.points?.geometry.boundingSphere;
    if (esfera && destino.distanceTo(esfera.center) > esfera.radius * 1.5) return null;

    const c = plano.aPlano(destino);
    return { u: c.u, v: c.v, ajustado: false };
  }

  /** Cuantos metros del papel mide un pixel de pantalla, a la distancia actual. */
  _metrosPorPixel() {
    const cam = this.viewer.camera;
    const centro = this.planoActivo
      ? this.viewer.root.localToWorld(this.planoActivo.origen.clone())
      : this.viewer.controls.target.clone();
    const dist = cam.position.distanceTo(centro);
    const alto = this.canvas.getBoundingClientRect().height || 1;
    return (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * dist) / alto;
  }

  // --- eventos ---------------------------------------------------------------

  _conectar() {
    // El lapiz tiene que ganarle la mano a OrbitControls, que escucha en el
    // propio canvas y se registro antes. Un listener en captura sobre window se
    // ejecuta primero y desactiva los controles justo para ese gesto.
    window.addEventListener('pointerdown', (e) => {
      if (e.target !== this.canvas) return;
      if (e.pointerType === 'pen' && this.viewer.points) this.viewer.controls.enabled = false;
    }, { capture: true });

    this.canvas.addEventListener('pointerdown', (e) => this._abajo(e));
    this.canvas.addEventListener('pointermove', (e) => this._mover(e));
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
      this.canvas.addEventListener(ev, (e) => this._arriba(e));
    }
    window.addEventListener('resize', () => this._actualizarResolucion());
  }

  _dibujaEste(e) {
    if (!this.viewer.points) return false;
    if (e.pointerType === 'pen') return true;
    if (this.modo !== 'dibujar') return false;
    if (e.pointerType === 'mouse' && e.button !== 0) return false;
    return true;
  }

  /**
   * Punto de pantalla efectivo.
   *
   * Con el dedo se apunta unos milimetros POR ENCIMA del contacto. La yema tapa
   * exactamente lo que estas señalando: en un movil eso son 8-10 mm de
   * incertidumbre, y es la razon de que el trazo "no caiga donde apuntas". Con
   * el desplazamiento y la mira dibujada, apuntas mirando en vez de adivinando.
   * Con lapiz o raton no hace falta y no se aplica.
   */
  _puntoPantalla(e) {
    const dy = e.pointerType === 'touch' ? this.desplazamientoTactil : 0;
    return { x: e.clientX, y: e.clientY - dy };
  }

  /**
   * Enganches, en orden de prioridad.
   *
   *  1. A vertices ya dibujados, para que las lineas se toquen de verdad y no
   *     "casi".
   *  2. A los ejes del papel cada 45 grados. En una fachada, recto significa a
   *     nivel y a plomo, y eso a pulso no sale nunca.
   *
   * @param {object} p    punto libre en coordenadas del papel
   * @param {object} ref  vertice anterior, si lo hay (para el enganche angular)
   */
  _enganchar(p, ref) {
    const mpp = this._metrosPorPixel();
    let mejor = null, mejorD = mpp * 16;
    for (const t of this.trazos) {
      if (t.plano !== this.planoActivo) continue;
      for (let i = 0; i < t.numeroDePuntos; i++) {
        const u = t.puntos[i * 2], v = t.puntos[i * 2 + 1];
        const d = Math.hypot(p.u - u, p.v - v);
        if (d < mejorD) { mejorD = d; mejor = { u, v }; }
      }
    }
    if (mejor) return { u: mejor.u, v: mejor.v, tipo: 'vertice' };

    if (ref && this.engancheOrtogonal) {
      const du = p.u - ref.u, dv = p.v - ref.v;
      if (Math.hypot(du, dv) > mpp) {
        const angulo = Math.atan2(dv, du);
        const objetivo = Math.round(angulo / PASO_ANGULO) * PASO_ANGULO;
        let desvio = angulo - objetivo;
        while (desvio > Math.PI) desvio -= 2 * Math.PI;
        while (desvio < -Math.PI) desvio += 2 * Math.PI;
        if (Math.abs(desvio) < TOLERANCIA_ANGULO) {
          // Se proyecta sobre el eje en vez de girar el punto: asi la linea se
          // queda donde has parado el dedo, no se alarga sola.
          const proy = du * Math.cos(objetivo) + dv * Math.sin(objetivo);
          return {
            u: ref.u + Math.cos(objetivo) * proy,
            v: ref.v + Math.sin(objetivo) * proy,
            tipo: 'recto',
          };
        }
      }
    }
    return { u: p.u, v: p.v, tipo: null };
  }

  _abajo(e) {
    this._punteros.add(e.pointerId);
    if (this._punteros.size > 1) {
      // Segundo dedo: manda el gesto de camara y se tira lo que hubiera a medias.
      this._cancelarTrazo();
      this._pendiente = null;
      this._quitarVistaPrevia();
      this._mira(null);
      return;
    }
    if (!this._dibujaEste(e)) return;

    const s = this._puntoPantalla(e);
    this._mira(s);

    if (!this.planoActivo) {
      // Sin papel no se puede dibujar: el primer toque lo fija.
      this.fijarPlanoEn(s.x, s.y);
      this._mira(null);
      return;
    }

    const libre = this._puntoEnPapel(s.x, s.y, true);
    if (!libre) {
      this._mensaje('El papel esta de canto desde aqui: gira un poco la vista.');
      this._mira(null);
      return;
    }
    e.preventDefault();

    if (this.herramienta === 'borrador') { this._borrarEn(libre); this._mira(null); return; }

    if (this.herramienta === 'polilinea') {
      // El vertice no se coloca al tocar, sino al levantar: mientras tanto se
      // arrastra con la linea a la vista. En tactil no hay puntero flotando, y
      // sin esto se colocan los vertices a ciegas.
      this._pendiente = this._enganchar(libre, this._ultimoVertice());
      this._pintarVistaPrevia();
      return;
    }

    const p = this._enganchar(libre, null);
    this._trazoActivo = new Trazo({
      plano: this.planoActivo,
      puntos: this.herramienta === 'rectangulo'
        ? [p.u, p.v, p.u, p.v, p.u, p.v, p.u, p.v]
        : [p.u, p.v],
      color: this.color,
      grosor: this.grosor,
      cerrado: this.herramienta === 'rectangulo',
    });
    this._origenRect = p;
    this._añadirALaEscena(this._trazoActivo);
  }

  _mover(e) {
    if (this._punteros.size > 1 || !this._punteros.has(e.pointerId)) return;
    if (!this.planoActivo) return;
    const s = this._puntoPantalla(e);

    if (this.herramienta === 'polilinea') {
      if (!this._pendiente) return;
      const libre = this._puntoEnPapel(s.x, s.y, false);
      if (!libre) return;
      e.preventDefault();
      this._mira(s);
      this._pendiente = this._enganchar(libre, this._ultimoVertice());
      this._pintarVistaPrevia();
      return;
    }

    if (!this._trazoActivo) return;
    const p = this._puntoEnPapel(s.x, s.y, false);
    if (!p) return;
    e.preventDefault();
    this._mira(s);

    if (this.herramienta === 'rectangulo') {
      const o = this._origenRect;
      const esquina = this._enganchar(p, null);
      this._trazoActivo.puntos = rectangulo(o.u, o.v, esquina.u, esquina.v);
      this._cota(`${formatoMetros(Math.abs(esquina.u - o.u))} x ${formatoMetros(Math.abs(esquina.v - o.v))}`);
    } else {
      const n = this._trazoActivo.numeroDePuntos;
      const du = p.u - this._trazoActivo.puntos[n * 2 - 2];
      const dv = p.v - this._trazoActivo.puntos[n * 2 - 1];
      // Muestras a menos de 2 px no aportan forma y multiplican el coste.
      if (Math.hypot(du, dv) < this._metrosPorPixel() * 2) return;
      this._trazoActivo.añadir(p.u, p.v);
      this._cota(formatoMetros(this._trazoActivo.longitud()));
    }

    // Reconstruir la geometria en cada evento de puntero satura el movil:
    // basta con una vez por fotograma.
    const ahora = performance.now();
    if (ahora - this._ultimoRebuild > 16) {
      this._ultimoRebuild = ahora;
      this._añadirALaEscena(this._trazoActivo, true);
      this.viewer.needsRender = true;
    }
  }

  _arriba(e) {
    this._punteros.delete(e.pointerId);
    if (e.pointerType === 'pen') this.viewer.controls.enabled = true;
    this._mira(null);

    if (this.herramienta === 'polilinea') {
      if (this._pendiente) this._confirmarVertice();
      return;
    }

    if (!this._trazoActivo) return;
    this._cota(null);

    const t = this._trazoActivo;
    this._trazoActivo = null;

    if (this.herramienta === 'lapiz') {
      const tolerancia = this._metrosPorPixel() * 0.8;
      t.puntos = simplificar(t.puntos, tolerancia);
      // Con el dedo el trazo llega tembloroso; con lapiz ya viene fino.
      const iteraciones = e.pointerType === 'pen' ? Math.min(1, this.suavizado) : this.suavizado;
      if (iteraciones > 0 && t.numeroDePuntos > 2) t.puntos = suavizar(t.puntos, iteraciones);
    }

    if (t.numeroDePuntos < 2 || t.longitud() < this._metrosPorPixel() * 3) {
      // Un toque suelto no es un trazo. Sin esto la nube se llena de motas.
      t.destruir();
      this.trazos = this.trazos.filter((x) => x !== t);
      this.viewer.needsRender = true;
      this._avisarCambio();
      return;
    }

    this._añadirALaEscena(t, true);
    this._apilar({ tipo: 'añadir', trazo: t });
    this.viewer.needsRender = true;
    this._avisarCambio();
  }

  _cancelarTrazo() {
    this._cota(null);
    if (!this._trazoActivo) return;
    this._quitarDeLaEscena(this._trazoActivo);
    this._trazoActivo = null;
    this.viewer.needsRender = true;
  }

  // --- polilinea: se arrastra el vertice y se suelta donde toca --------------

  /** Ultimo vertice colocado de la polilinea en curso, si la hay. */
  _ultimoVertice() {
    const t = this._trazoEnCurso;
    if (!t || !t.numeroDePuntos) return null;
    const n = t.numeroDePuntos;
    return { u: t.puntos[n * 2 - 2], v: t.puntos[n * 2 - 1] };
  }

  /** Linea fantasma entre el ultimo vertice y el dedo, con su medida. */
  _pintarVistaPrevia() {
    const p = this._pendiente;
    const desde = this._ultimoVertice();
    if (!p || !desde) {
      this._quitarVistaPrevia();
      this._cota(p ? 'Suelta para poner el primer vertice' : null);
      this.viewer.needsRender = true;
      return;
    }
    if (!this._vistaPrevia) {
      this._vistaPrevia = new Trazo({
        plano: this.planoActivo, puntos: [], color: this.color, grosor: this.grosor,
      });
    }
    const vp = this._vistaPrevia;
    vp.plano = this.planoActivo;
    vp.puntos = [desde.u, desde.v, p.u, p.v];
    const obj = vp.construir(this._actualizarResolucion());
    if (obj) {
      vp.material.color.set(this.color);
      vp.material.transparent = true;
      vp.material.opacity = 0.5;
      if (obj.parent !== this.overlay) this.overlay.add(obj);
    }

    const largo = Math.hypot(p.u - desde.u, p.v - desde.v);
    const grados = (Math.atan2(p.v - desde.v, p.u - desde.u) * 180) / Math.PI;
    const marca = p.tipo === 'vertice' ? ' · vertice' : p.tipo === 'recto' ? ' · recto' : '';
    this._cota(`${formatoMetros(largo)} · ${grados.toFixed(0)}°${marca}`);
    this.viewer.needsRender = true;
  }

  _quitarVistaPrevia() {
    if (!this._vistaPrevia) return;
    this._vistaPrevia.destruir();
    this._vistaPrevia = null;
  }

  /** Fija el vertice que se estaba arrastrando. */
  _confirmarVertice() {
    const p = this._pendiente;
    this._pendiente = null;
    this._quitarVistaPrevia();
    this._cota(null);
    if (!p) return;

    if (!this._trazoEnCurso) {
      this._trazoEnCurso = new Trazo({
        plano: this.planoActivo,
        puntos: [p.u, p.v],
        color: this.color,
        grosor: this.grosor,
      });
      this._añadirALaEscena(this._trazoEnCurso, true);
      this._mensaje('Arrastra y suelta cada vertice. Suelta sobre el ultimo para terminar, '
        + 'o sobre el primero para cerrar la figura.');
      this._avisarCambio();
      return;
    }

    const t = this._trazoEnCurso;
    const n = t.numeroDePuntos;
    const cerca = this._metrosPorPixel() * 14;
    const alUltimo = Math.hypot(p.u - t.puntos[n * 2 - 2], p.v - t.puntos[n * 2 - 1]);
    const alPrimero = Math.hypot(p.u - t.puntos[0], p.v - t.puntos[1]);

    if (n >= 2 && alPrimero < cerca) { t.cerrado = true; this._terminarPolilinea(); return; }
    if (n >= 2 && alUltimo < cerca) { this._terminarPolilinea(); return; }
    if (alUltimo < cerca) return;   // dos toques en el mismo sitio: no es un vertice

    t.añadir(p.u, p.v);
    this._añadirALaEscena(t, true);
    this.viewer.needsRender = true;
    this._avisarCambio();
  }

  /** Cierra la polilinea a medias, si la hay. La expone la barra de dibujo. */
  _terminarPolilinea() {
    this._pendiente = null;
    this._quitarVistaPrevia();
    this._cota(null);
    const t = this._trazoEnCurso;
    if (!t) return;
    this._trazoEnCurso = null;
    if (t.numeroDePuntos < 2) {
      this._quitarDeLaEscena(t);
      t.destruir();
    } else {
      this._añadirALaEscena(t, true);
      this._apilar({ tipo: 'añadir', trazo: t });
    }
    this.viewer.needsRender = true;
    this._avisarCambio();
  }

  terminarPolilinea() { this._terminarPolilinea(); }

  _mira(s) { this.onMira?.(s); }
  _cota(texto) { this.onCota?.(texto); }


  get hayPolilineaAbierta() { return !!this._trazoEnCurso; }

  // --- borrador --------------------------------------------------------------

  _borrarEn(p) {
    const umbral = this._metrosPorPixel() * 22;   // ~22 px alrededor del dedo
    let mejor = null, mejorD = Infinity;
    for (const t of this.trazos) {
      if (t.plano !== this.planoActivo) continue;
      const d = t.distanciaA(p.u, p.v);
      if (d < mejorD) { mejorD = d; mejor = t; }
    }
    if (!mejor || mejorD > umbral) { this._mensaje('Ahi no hay ningun trazo que borrar.'); return; }
    this._quitarDeLaEscena(mejor);
    this._apilar({ tipo: 'borrar', trazo: mejor });
    this.viewer.needsRender = true;
    this._avisarCambio();
  }

  // --- deshacer / rehacer ----------------------------------------------------

  _apilar(accion) {
    this.pila.push(accion);
    this.rehacerPila = [];
    if (this.pila.length > 200) this.pila.shift();
  }

  deshacer() {
    const a = this.pila.pop();
    if (!a) return false;
    if (a.tipo === 'añadir') this._quitarDeLaEscena(a.trazo);
    else if (a.tipo === 'borrarVarios') for (const t of a.trazos) this._añadirALaEscena(t, true);
    else this._añadirALaEscena(a.trazo, true);
    this.rehacerPila.push(a);
    this.viewer.needsRender = true;
    this._avisarCambio();
    return true;
  }

  rehacer() {
    const a = this.rehacerPila.pop();
    if (!a) return false;
    if (a.tipo === 'añadir') this._añadirALaEscena(a.trazo, true);
    else if (a.tipo === 'borrarVarios') for (const t of a.trazos) this._quitarDeLaEscena(t);
    else this._quitarDeLaEscena(a.trazo);
    this.pila.push(a);
    this.viewer.needsRender = true;
    this._avisarCambio();
    return true;
  }

  borrarTodo() {
    if (!this.trazos.length) return;
    const copia = this.trazos.slice();
    for (const t of copia) this._quitarDeLaEscena(t);
    this._apilar({ tipo: 'borrarVarios', trazos: copia });
    this.viewer.needsRender = true;
    this._avisarCambio();
  }

  /**
   * Mete el trazo en la escena, reconstruyendo su geometria si hace falta.
   *
   * Todo paso por aqui: un trazo recien empezado tiene un solo punto y todavia
   * no tiene objeto de three (no hay linea de un punto), asi que hay que
   * reintentar el alta en cada reconstruccion, no solo al crearlo.
   */
  _añadirALaEscena(t, reconstruir = false) {
    if (!this.trazos.includes(t)) this.trazos.push(t);
    const obj = reconstruir || !t.objeto ? t.construir(this._actualizarResolucion()) : t.objeto;
    if (obj && obj.parent !== this.overlay) this.overlay.add(obj);
  }

  _quitarDeLaEscena(t) {
    this.trazos = this.trazos.filter((x) => x !== t);
    if (t.objeto) this.overlay.remove(t.objeto);
  }

  _actualizarResolucion() {
    const size = this.viewer.renderer.getDrawingBufferSize(new THREE.Vector2());
    this._resolucion.set(size.x, size.y);
    for (const t of this.trazos) t.material?.resolution.copy(this._resolucion);
    return this._resolucion;
  }

  // --- persistencia ----------------------------------------------------------

  serializar() {
    return {
      version: 1,
      creado: new Date().toISOString(),
      upAxis: this.viewer.upAxis,
      origen: this.viewer.cloud ? Array.from(this.viewer.cloud.origin) : [0, 0, 0],
      planos: [...this.planos.values()].map((p) => p.serializar()),
      trazos: this.trazos.map((t) => t.serializar()),
    };
  }

  /**
   * Carga un dibujo guardado.
   *
   * `origen` importa: las coordenadas locales dependen del origen que se resto
   * al leer el fichero. Si el dibujo viene de otra carga de la MISMA nube el
   * origen coincide; si no, se corrige por diferencia para que no se vaya a
   * kilometros de distancia.
   */
  cargar(datos) {
    if (!datos?.trazos) return 0;
    this.reiniciar();

    const o = this.viewer.cloud?.origin || [0, 0, 0];
    const d = datos.origen || o;
    const ajuste = new THREE.Vector3(d[0] - o[0], d[1] - o[1], d[2] - o[2]);

    for (const po of datos.planos || []) {
      const plano = Plano.deserializar(po);
      plano.origen.add(ajuste);
      plano.separacion = this._separacion();
      this.planos.set(plano.id, plano);
    }
    this.planoActivo = this.planos.values().next().value || null;
    this._actualizarRejilla();

    let n = 0;
    for (const to of datos.trazos) {
      const plano = this.planos.get(to.plano) || this.planoActivo;
      if (!plano) continue;
      const t = new Trazo({ ...to, plano });
      this._añadirALaEscena(t, true);
      n++;
    }
    this.viewer.needsRender = true;
    this._avisarCambio();
    return n;
  }

  /**
   * Muestrea los trazos como puntos coloreados, para meterlos en un PLY/LAS.
   *
   * @param {number} paso  separacion entre puntos, en metros
   * @returns {{position: Float64Array, color: Uint8Array, count: number}} en
   *          coordenadas LOCALES (hay que sumarles cloud.origin al escribir)
   */
  puntosParaExportar(paso) {
    const separacion = paso > 0 ? paso : Math.max(0.002, this._separacion());
    const pos = [];
    const col = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const t of this.trazos) {
      const c = new THREE.Color(t.color);
      const r = Math.round(c.r * 255), g = Math.round(c.g * 255), bl = Math.round(c.b * 255);
      const n = t.numeroDePuntos;
      const tramos = t.cerrado ? n : n - 1;
      for (let i = 0; i < tramos; i++) {
        t.punto3D(i, a);
        t.punto3D((i + 1) % n, b);
        const largo = a.distanceTo(b);
        const pasos = Math.max(1, Math.ceil(largo / separacion));
        for (let k = 0; k < pasos; k++) {
          const s = k / pasos;
          pos.push(a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s, a.z + (b.z - a.z) * s);
          col.push(r, g, bl);
        }
      }
      // El ultimo vertice de una polilinea abierta se quedaria fuera del bucle.
      if (!t.cerrado && n >= 2) {
        t.punto3D(n - 1, a);
        pos.push(a.x, a.y, a.z);
        col.push(r, g, bl);
      }
    }
    return { position: Float64Array.from(pos), color: Uint8Array.from(col), count: col.length / 3 };
  }

  // --- avisos ----------------------------------------------------------------

  _mensaje(texto) { this.onMensaje?.(texto); }
  _avisarCambio() { this.onCambio?.(); }
}

/** Longitudes con la unidad que toca, para la medida en vivo. */
function formatoMetros(m) {
  if (m < 1) return `${(m * 100).toFixed(1)} cm`;
  return `${m.toFixed(2)} m`;
}
