import { Viewer } from '../viewer/Viewer.js';
import { COLORMAPS } from '../viewer/colormaps.js';
import { Dibujo, COLORES } from '../dibujo/Dibujo.js';
import {
  fuenteCombinada, escribirPLY, escribirLAS, extremos, descargar,
} from '../io/exportar.js';
import {
  el, slider, segmentado, conmutador, boton, bloqueInfo,
  logMap, formatoLongitud, formatoNumero,
} from './controls.js';

const ES_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Presupuesto de puntos. En iOS, Safari tumba la pestaña sobre 1-1,5 GB y cada
// punto con color cuesta ~16 bytes en GPU mas los buffers de parseo, asi que
// 8 M es el techo comodo de un iPhone 14. Se puede subir bajo tu responsabilidad.
const PRESUPUESTO_POR_DEFECTO = ES_IOS ? 8_000_000 : 20_000_000;

const AJUSTES_POR_DEFECTO = {
  presupuesto: PRESUPUESTO_POR_DEFECTO,
  modoTamano: 'metrico',
  tamanoPx: 2.0,
  factorMundo: 1.0,        // multiplicador sobre el espaciado estimado
  minPx: 1.0,
  maxPx: 30.0,
  forma: 'circulo',
  modoColor: 'rgb',
  colormap: 'turbo',
  brillo: 0,
  contraste: 1,
  saturacion: 1,
  gamma: 1,
  edl: true,
  edlFuerza: 0.35,
  edlRadio: 1.4,
  densidad: 1,
  densidadMovimiento: 0.4,
  dprMax: 2,
  dibujoColor: '#ff3b30',
  dibujoGrosor: 3,
  dibujoSuavizado: 1,
  dibujoModoPlano: 'ajuste',
  dibujoAjustar: true,
  dibujoIncluirNube: false,
  dibujoEnganche: true,
  dibujoDesplazamiento: 46,
};

function cargarAjustes() {
  try {
    const raw = localStorage.getItem('visor-nube-ajustes');
    return raw ? { ...AJUSTES_POR_DEFECTO, ...JSON.parse(raw) } : { ...AJUSTES_POR_DEFECTO };
  } catch {
    return { ...AJUSTES_POR_DEFECTO };
  }
}

export class App {
  constructor() {
    this.dom = {
      canvas: document.getElementById('lienzo'),
      inicio: document.getElementById('inicio'),
      cargando: document.getElementById('cargando'),
      barra: document.getElementById('barra-relleno'),
      etiquetaCarga: document.getElementById('etiqueta-carga'),
      notaCarga: document.getElementById('nota-carga'),
      notaPresupuesto: document.getElementById('nota-presupuesto'),
      hud: document.getElementById('hud'),
      hudNombre: document.getElementById('hud-nombre'),
      hudStats: document.getElementById('hud-stats'),
      panel: document.getElementById('panel'),
      tirador: document.getElementById('tirador'),
      pestanas: document.getElementById('pestanas'),
      contenido: document.getElementById('contenido'),
      barraTamano: document.getElementById('barra-tamano'),
      tamSlider: document.getElementById('tam-slider'),
      tamMenos: document.getElementById('tam-menos'),
      tamMas: document.getElementById('tam-mas'),
      tamValor: document.getElementById('tam-valor'),
      entrada: document.getElementById('entrada-fichero'),
      entradaDibujo: document.getElementById('entrada-dibujo'),
      btnDibujar: document.getElementById('btn-dibujar'),
      barraDibujo: document.getElementById('barra-dibujo'),
      dibColores: document.getElementById('dib-colores'),
      dibColor: document.getElementById('dib-color'),
      dibDeshacer: document.getElementById('dib-deshacer'),
      dibTerminar: document.getElementById('dib-terminar'),
      mira: document.getElementById('mira'),
      cota: document.getElementById('cota'),
      btnAbrir: document.getElementById('btn-abrir'),
      btnUrl: document.getElementById('btn-url'),
      btnEncuadrar: document.getElementById('btn-encuadrar'),
      aviso: document.getElementById('aviso'),
    };

    this.ajustes = cargarAjustes();
    this.viewer = new Viewer(this.dom.canvas);
    this.viewer.onStats = (s) => this.actualizarStats(s);
    this.dibujo = new Dibujo(this.viewer);
    this.dibujo.onCambio = () => { this._sincronizarDibujo(); this._guardarDibujoDiferido(); };
    this.dibujo.onMensaje = (t) => this.aviso(t, 4000);
    this.dibujo.onMira = (s) => this._mira(s);
    this.dibujo.onCota = (t) => this._cota(t);
    this.tab = 'puntos';
    this.controles = {};

    this.dom.notaPresupuesto.textContent =
      `Presupuesto actual: ${formatoNumero(this.ajustes.presupuesto)} puntos. `
      + 'Los ficheros mas grandes se submuestrean de forma uniforme al cargar; '
      + 'puedes subirlo en Calidad.';

    this._conectarEventos();
    this._aplicarAjustes();
    this._construirPanel();

    const url = new URLSearchParams(location.search).get('url');
    if (url) this.cargar({ url });
  }

  // --- eventos ---------------------------------------------------------------

  _conectarEventos() {
    const d = this.dom;
    d.btnAbrir.addEventListener('click', () => d.entrada.click());
    d.entrada.addEventListener('change', () => {
      const f = d.entrada.files?.[0];
      if (f) this.cargar({ file: f, name: f.name });
      d.entrada.value = '';
    });
    d.btnUrl.addEventListener('click', () => {
      const url = prompt('URL del fichero (el servidor debe permitir CORS):');
      if (url) this.cargar({ url: url.trim() });
    });
    d.btnEncuadrar.addEventListener('click', () => this.viewer.frameAll());

    d.tirador.addEventListener('click', () => this._alternarPanel());
    d.pestanas.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      this.tab = b.dataset.tab;
      for (const x of d.pestanas.children) x.classList.toggle('activa', x === b);
      this._renderTab();
      if (d.panel.classList.contains('cerrado')) this._alternarPanel();
    });

    // Arrastrar y soltar en escritorio.
    for (const ev of ['dragover', 'drop']) {
      window.addEventListener(ev, (e) => {
        e.preventDefault();
        if (ev === 'drop' && e.dataTransfer?.files?.[0]) {
          const f = e.dataTransfer.files[0];
          this.cargar({ file: f, name: f.name });
        }
      });
    }

    // Safari hace zoom de pagina con pellizco si no se lo impides.
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
    }
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

    this._doblePulsacion();
    this._conectarDibujo();

    this.dom.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.error('Safari ha liberado el contexto WebGL (normalmente por memoria). '
        + 'Recarga y prueba con un presupuesto de puntos menor.');
    });

    // Barra rapida de tamaño de punto.
    d.tamSlider.addEventListener('input', () => this._tamanoDesdeSlider(Number(d.tamSlider.value)));
    d.tamMenos.addEventListener('click', () => this._nudgeTamano(-8));
    d.tamMas.addEventListener('click', () => this._nudgeTamano(8));
    // Mantener pulsado para ajuste continuo.
    for (const [btn, dir] of [[d.tamMenos, -1], [d.tamMas, 1]]) {
      let t = 0;
      const stop = () => clearInterval(t);
      btn.addEventListener('pointerdown', () => {
        stop();
        t = setInterval(() => this._nudgeTamano(dir * 4), 90);
      });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, stop);
    }
  }

  /** Doble toque = fijar el centro de orbita en lo que hay bajo el dedo. */
  _doblePulsacion() {
    let ultimo = 0, ux = 0, uy = 0;
    this.dom.canvas.addEventListener('pointerup', (e) => {
      // En modo dibujo (o con lapiz) el doble toque es parte del trazo, no un
      // cambio de centro de giro.
      if (this.dibujo.modo === 'dibujar' || e.pointerType === 'pen') return;
      const ahora = performance.now();
      const cerca = Math.hypot(e.clientX - ux, e.clientY - uy) < 34;
      if (ahora - ultimo < 320 && cerca) {
        ultimo = 0;
        if (!this.viewer.focusAt(e.clientX, e.clientY)) {
          this.aviso('No hay ningun punto bajo el dedo.');
        }
      } else {
        ultimo = ahora; ux = e.clientX; uy = e.clientY;
      }
    });
  }

  _alternarPanel() {
    const cerrado = this.dom.panel.classList.toggle('cerrado');
    // Con el panel abierto la barra rapida quedaria enterrada debajo.
    this.dom.barraTamano.classList.toggle('bajo-panel', !cerrado);
    this.dom.barraDibujo.classList.toggle('bajo-panel', !cerrado);
    // El panel puede llevar rato cerrado mientras se dibuja: al abrirlo hay que
    // refrescar lo que muestra o se leen numeros viejos.
    if (!cerrado) this._sincronizarDibujo();
    return cerrado;
  }

  // --- carga -----------------------------------------------------------------

  async cargar(origen) {
    this.dom.inicio.classList.add('oculto');
    this.dom.cargando.classList.remove('oculto');
    this.dom.barra.style.width = '0%';
    this.dom.etiquetaCarga.textContent = 'Leyendo…';
    this.dom.notaCarga.textContent = origen.file
      ? `${origen.name} · ${(origen.file.size / 1048576).toFixed(1)} MB`
      : origen.url;

    this.worker?.terminate();
    this.worker = new Worker(new URL('../io/worker.js', import.meta.url), { type: 'module' });

    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        this.dom.barra.style.width = `${Math.round(Math.min(1, m.value || 0) * 100)}%`;
        if (m.label) this.dom.etiquetaCarga.textContent = m.label;
        else this.dom.etiquetaCarga.textContent = `Leyendo… ${Math.round((m.value || 0) * 100)}%`;
      } else if (m.type === 'done') {
        this._montar(m.payload);
        this.worker.terminate();
        this.worker = null;
      } else if (m.type === 'error') {
        this.dom.cargando.classList.add('oculto');
        this.dom.inicio.classList.remove('oculto');
        this.error(m.message);
      }
    };
    this.worker.onerror = (e) => {
      this.dom.cargando.classList.add('oculto');
      this.dom.inicio.classList.remove('oculto');
      this.error(`Fallo en el worker de carga: ${e.message || 'error desconocido'}`);
    };

    this.worker.postMessage({
      type: 'load',
      file: origen.file,
      url: origen.url,
      name: origen.name,
      budget: this.ajustes.presupuesto,
    });
  }

  _montar(payload) {
    this.dom.cargando.classList.add('oculto');
    this.dom.hud.classList.remove('oculto');
    this.dom.panel.classList.remove('oculto');
    this.dom.barraTamano.classList.remove('oculto');
    this.dom.panel.classList.add('cerrado');

    const res = this.viewer.setPointCloud(payload);
    this.nube = payload;
    this.dibujo.reiniciar();
    this.dibujo.setModo('navegar');
    this._aplicarAjustesDibujo();

    // Si el fichero no trae color, RGB no tiene sentido: caemos a elevacion.
    if (!payload.color && this.ajustes.modoColor === 'rgb') this.ajustes.modoColor = 'elevacion';
    else if (payload.color && res.colorMode === 'rgb') this.ajustes.modoColor = this.ajustes.modoColor || 'rgb';

    this._aplicarAjustes();
    this._construirMapaTamano();
    this._renderTab();
    this.dom.hudNombre.textContent = payload.name || 'nube';
    this.guardar();

    // Los avisos se juntan en uno solo: dos mensajes seguidos en el mismo sitio
    // hacen que el segundo pise al primero sin que nadie lea ninguno.
    const notas = [];
    if (payload.sourceCount > payload.count) {
      const pct = ((payload.count / payload.sourceCount) * 100).toFixed(1);
      notas.push(`Submuestreada al ${pct} %: ${formatoNumero(payload.count)} de `
        + `${formatoNumero(payload.sourceCount)} puntos (presupuesto de memoria).`);
    }
    if (res.ejeConjeturado) {
      // El fichero no dice cual es la vertical, asi que la hemos deducido de la
      // forma de la nube. Se acierta casi siempre, pero cuando no, el usuario
      // tiene que saber que es una suposicion y donde se cambia.
      notas.push(`Eje vertical supuesto: ${res.upAxis.toUpperCase()}. `
        + 'Si la nube sale tumbada, cambialo en Vista.');
    }
    const restaurados = this._restaurarDibujo();
    if (restaurados) {
      notas.push(`Dibujo restaurado: ${restaurados} trazo${restaurados === 1 ? '' : 's'} `
        + 'de la ultima sesion con esta nube.');
    }
    if (notas.length) this.aviso(notas.join(' '), 7000);
  }

  // --- dibujo ----------------------------------------------------------------

  _conectarDibujo() {
    const d = this.dom;
    d.btnDibujar.addEventListener('click', () => {
      if (!this.nube) { this.aviso('Primero abre una nube.'); return; }
      this.dibujo.setModo(this.dibujo.modo === 'dibujar' ? 'navegar' : 'dibujar');
      if (this.dibujo.modo === 'dibujar' && !this.dibujo.planoActivo) {
        this.aviso('Toca la superficie donde quieras dibujar: ahi se fija el papel.', 5000);
      }
    });

    d.barraDibujo.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-herramienta]');
      if (!b) return;
      this.dibujo.setHerramienta(b.dataset.herramienta);
    });
    d.dibColor.addEventListener('click', () => d.dibColores.classList.toggle('oculto'));
    d.dibDeshacer.addEventListener('click', () => {
      if (!this.dibujo.deshacer()) this.aviso('No queda nada que deshacer.');
    });
    d.dibTerminar.addEventListener('click', () => this.dibujo.terminarPolilinea());

    for (const c of COLORES) {
      const b = el('button', 'tinta');
      b.dataset.color = c.id;
      b.setAttribute('aria-label', c.label);
      const punto = el('span');
      punto.style.background = c.id;
      b.appendChild(punto);
      b.addEventListener('click', () => {
        this.cambiar('dibujoColor', c.id);
        d.dibColores.classList.add('oculto');
      });
      d.dibColores.appendChild(b);
    }

    d.entradaDibujo.addEventListener('change', async () => {
      const f = d.entradaDibujo.files?.[0];
      d.entradaDibujo.value = '';
      if (!f) return;
      try {
        const n = this.dibujo.cargar(JSON.parse(await f.text()));
        this.aviso(`Dibujo cargado: ${n} trazos.`);
      } catch (err) {
        this.error(`No he podido leer ese dibujo: ${err.message}`);
      }
    });

    const muestra = el('span');
    muestra.style.background = this.ajustes.dibujoColor;
    d.dibColor.appendChild(muestra);
  }

  _aplicarAjustesDibujo() {
    const a = this.ajustes;
    const dib = this.dibujo;
    dib.setColor(a.dibujoColor);
    dib.setGrosor(a.dibujoGrosor);
    dib.suavizado = a.dibujoSuavizado;
    dib.modoPlano = a.dibujoModoPlano;
    dib.ajustarAPuntos = a.dibujoAjustar;
    dib.engancheOrtogonal = a.dibujoEnganche;
    dib.desplazamientoTactil = a.dibujoDesplazamiento;
  }

  /** Mira de punteria: sigue al dedo, desplazada para que no la tape. */
  _mira(s) {
    const m = this.dom.mira;
    if (!s) { m.classList.add('oculto'); return; }
    m.style.left = `${s.x}px`;
    m.style.top = `${s.y}px`;
    m.classList.remove('oculto');
  }

  /** Medida del segmento en curso, arriba y en el centro. */
  _cota(texto) {
    const c = this.dom.cota;
    if (!texto) { c.classList.add('oculto'); return; }
    c.textContent = texto;
    c.classList.remove('oculto');
  }

  /** Refleja en la interfaz el estado del dibujo (modo, herramienta, color). */
  _sincronizarDibujo() {
    const d = this.dom;
    const dib = this.dibujo;
    const dibujando = dib.modo === 'dibujar';
    d.btnDibujar.classList.toggle('activa', dibujando);
    d.barraDibujo.classList.toggle('oculto', !dibujando || !this.nube);
    for (const b of d.barraDibujo.querySelectorAll('button[data-herramienta]')) {
      b.classList.toggle('activa', b.dataset.herramienta === dib.herramienta);
    }
    for (const b of d.dibColores.querySelectorAll('button[data-color]')) {
      b.classList.toggle('activa', b.dataset.color === dib.color);
    }
    const muestra = d.dibColor.firstElementChild;
    if (muestra) muestra.style.background = dib.color;
    d.dibTerminar.classList.toggle('oculto', !dib.hayPolilineaAbierta);
    if (this.tab === 'dibujo' && !d.panel.classList.contains('cerrado')) this._infoDibujo?.();
  }

  // --- guardar y recuperar el dibujo ----------------------------------------

  /**
   * Clave de guardado por nube. Nombre y numero de puntos no bastan: dos
   * escaneos del mismo dia se llaman igual. Se añade el bbox redondeado, que
   * es practicamente una huella del fichero.
   */
  _claveDibujo() {
    const n = this.nube;
    if (!n) return null;
    const caja = [...n.min, ...n.max].map((x) => Math.round(x * 100)).join('_');
    return `visor-dibujo:${n.name || 'nube'}:${n.count}:${caja}`;
  }

  _guardarDibujoDiferido() {
    clearTimeout(this._dibujoT);
    this._dibujoT = setTimeout(() => this._guardarDibujo(), 800);
  }

  _guardarDibujo() {
    const clave = this._claveDibujo();
    if (!clave) return;
    try {
      if (!this.dibujo.hayDibujo) localStorage.removeItem(clave);
      else localStorage.setItem(clave, JSON.stringify(this.dibujo.serializar()));
      this._avisoCuota = false;
    } catch {
      // El dibujo cabe de sobra en los 5 MB de localStorage salvo casos raros;
      // si no cabe, se avisa una vez y se sigue trabajando en memoria.
      if (!this._avisoCuota) {
        this._avisoCuota = true;
        this.error('No puedo guardar el dibujo en este navegador (sin espacio o modo privado). '
          + 'Exportalo a fichero desde la pestaña Dibujo para no perderlo.');
      }
    }
  }

  _restaurarDibujo() {
    const clave = this._claveDibujo();
    if (!clave) return 0;
    try {
      const raw = localStorage.getItem(clave);
      if (!raw) return 0;
      return this.dibujo.cargar(JSON.parse(raw));
    } catch {
      return 0;
    }
  }

  // --- exportar --------------------------------------------------------------

  _exportar(formato) {
    if (!this.dibujo.hayDibujo) { this.aviso('No hay ningun trazo que exportar.'); return; }
    const incluirNube = this.ajustes.dibujoIncluirNube;
    const espaciado = this.viewer.defaultWorldSize || 0.01;
    // Los trazos se muestrean a la mitad del espaciado de la nube: asi la linea
    // se lee como una linea y no como una fila de puntos sueltos.
    const puntos = this.dibujo.puntosParaExportar(espaciado * 0.5);
    const fuente = fuenteCombinada({ nube: this.nube, dibujo: puntos, incluirNube });

    if (incluirNube && this.nube.count > 4_000_000) {
      this.aviso('Exportando la nube entera: puede tardar y consumir mucha memoria.', 6000);
    }

    const base = (this.nube.name || 'nube').replace(/\.[^.]+$/, '');
    const sufijo = incluirNube ? 'con-dibujo' : 'dibujo';
    try {
      if (formato === 'ply') {
        descargar(escribirPLY(fuente), `${base}-${sufijo}.ply`);
      } else {
        const o = this.nube.origin;
        const caja = incluirNube
          ? {
            min: [this.nube.min[0] - o[0], this.nube.min[1] - o[1], this.nube.min[2] - o[2]],
            max: [this.nube.max[0] - o[0], this.nube.max[1] - o[1], this.nube.max[2] - o[2]],
          }
          : extremos(fuente, o);
        descargar(escribirLAS(fuente, { ...caja, origen: o }), `${base}-${sufijo}.las`);
      }
      this.aviso(`Exportados ${formatoNumero(fuente.count)} puntos.`);
    } catch (err) {
      this.error(`No he podido generar el fichero: ${err.message}`);
    }
  }

  _exportarSesion() {
    if (!this.dibujo.hayDibujo) { this.aviso('No hay ningun trazo que guardar.'); return; }
    const base = (this.nube?.name || 'nube').replace(/\.[^.]+$/, '');
    const blob = new Blob([JSON.stringify(this.dibujo.serializar())], { type: 'application/json' });
    descargar(blob, `${base}-dibujo.json`);
  }

  actualizarStats({ fps, drawn, activo }) {
    if (!this.nube) return;
    // Sin cambios en pantalla no se redibuja nada, y anunciar "0 fps" ahi
    // asusta sin motivo: solo se muestra la tasa cuando hay movimiento.
    this.dom.hudStats.textContent = activo
      ? `${formatoNumero(drawn)} pts · ${fps} fps`
      : `${formatoNumero(drawn)} pts`;
  }

  // --- tamaño de punto -------------------------------------------------------

  _construirMapaTamano() {
    const base = this.viewer.defaultWorldSize || 0.01;
    // Tres ordenes de magnitud alrededor del espaciado estimado: mas que
    // suficiente para pasar de "confeti" a "superficie solida" y volver.
    this.mapaMetrico = logMap(base / 30, base * 30);
    this.mapaPixel = logMap(0.5, 24);
    this._sincronizarBarraTamano();
  }

  _sincronizarBarraTamano() {
    if (!this.mapaMetrico) return;
    const metrico = this.ajustes.modoTamano === 'metrico';
    const base = this.viewer.defaultWorldSize || 0.01;
    const v = metrico ? base * this.ajustes.factorMundo : this.ajustes.tamanoPx;
    const map = metrico ? this.mapaMetrico : this.mapaPixel;
    this.dom.tamSlider.value = String(map.toSlider(v));
    this.dom.tamValor.textContent = metrico ? formatoLongitud(v) : `${v.toFixed(2)} px`;
  }

  _tamanoDesdeSlider(t) {
    const metrico = this.ajustes.modoTamano === 'metrico';
    const map = metrico ? this.mapaMetrico : this.mapaPixel;
    if (!map) return;
    const v = map.toValue(t);
    if (metrico) {
      const base = this.viewer.defaultWorldSize || 0.01;
      this.ajustes.factorMundo = v / base;
      this.viewer.setWorldSize(v);
      this.dom.tamValor.textContent = formatoLongitud(v);
    } else {
      this.ajustes.tamanoPx = v;
      this.viewer.setPointSize(v);
      this.dom.tamValor.textContent = `${v.toFixed(2)} px`;
    }
    this.controles.tamano?.set(t);
    this.guardarDiferido();
  }

  /** Un paso del slider es ~0,7 % del valor: eso es el "ajuste fino". */
  _nudgeTamano(pasos) {
    const t = Math.max(0, Math.min(1000, Number(this.dom.tamSlider.value) + pasos));
    this.dom.tamSlider.value = String(t);
    this._tamanoDesdeSlider(t);
  }

  // --- aplicar ajustes al visor ---------------------------------------------

  _aplicarAjustes() {
    const a = this.ajustes;
    const v = this.viewer;
    v.setSizeMode(a.modoTamano === 'metrico' ? 'atenuado' : 'fijo');
    v.setPointSize(a.tamanoPx);
    if (v.defaultWorldSize) v.setWorldSize(v.defaultWorldSize * a.factorMundo);
    v.setMinSize(a.minPx);
    v.setMaxSize(a.maxPx);
    v.setShape(a.forma);
    v.setColormap(a.colormap);
    v.setColorMode(a.modoColor);
    v.setBrightness(a.brillo);
    v.setContrast(a.contraste);
    v.setSaturation(a.saturacion);
    v.setGamma(a.gamma);
    v.setEdl(a.edl);
    v.setEdlStrength(a.edlFuerza);
    v.setEdlRadius(a.edlRadio);
    v.settings.interactiveDensity = a.densidadMovimiento;
    v.setDensity(a.densidad);
    v.setMaxPixelRatio(a.dprMax);
    this._aplicarAjustesDibujo();
    this._sincronizarDibujo();
    this._sincronizarBarraTamano();
  }

  guardar() {
    try { localStorage.setItem('visor-nube-ajustes', JSON.stringify(this.ajustes)); } catch { /* modo privado */ }
  }

  guardarDiferido() {
    clearTimeout(this._guardarT);
    this._guardarT = setTimeout(() => this.guardar(), 400);
  }

  cambiar(clave, valor) {
    this.ajustes[clave] = valor;
    this._aplicarAjustes();
    this.guardarDiferido();
  }

  // --- panel -----------------------------------------------------------------

  _construirPanel() {
    this.dom.panel.classList.add('cerrado');
    this._renderTab();
  }

  _renderTab() {
    const c = this.dom.contenido;
    c.innerHTML = '';
    this._infoDibujo = null;
    const add = (ctrl) => { for (const n of ctrl.nodes) c.appendChild(n); return ctrl; };
    const a = this.ajustes;
    const v = this.viewer;
    this.controles = {};

    if (this.tab === 'puntos') {
      add(segmentado({
        label: 'Modo de tamaño',
        value: a.modoTamano,
        options: [
          { id: 'metrico', label: 'Metros (3D)' },
          { id: 'fijo', label: 'Pixeles (2D)' },
        ],
        help: 'En metros, el punto crece al acercarte: la nube se lee como una superficie. '
          + 'En pixeles, todos los puntos miden igual en pantalla, util para inspeccionar densidad.',
        onChange: (id) => { this.cambiar('modoTamano', id); this._sincronizarBarraTamano(); this._renderTab(); },
      }));

      const metrico = a.modoTamano === 'metrico';
      const base = v.defaultWorldSize || 0.01;
      const map = metrico ? this.mapaMetrico : this.mapaPixel;
      if (map) {
        this.controles.tamano = add(slider({
          label: metrico ? 'Tamaño del punto' : 'Tamaño en pantalla',
          min: 0, max: 1000, step: 1,
          value: map.toSlider(metrico ? base * a.factorMundo : a.tamanoPx),
          format: (t) => (metrico ? formatoLongitud(map.toValue(t)) : `${map.toValue(t).toFixed(2)} px`),
          help: 'Cada paso del deslizador cambia el tamaño un 0,7 %. Los botones − y + de la '
            + 'barra inferior hacen el ajuste fino sin abrir este panel.',
          onInput: (t) => { this.dom.tamSlider.value = String(t); this._tamanoDesdeSlider(t); },
        }));
      }

      add(slider({
        label: 'Tamaño minimo', min: 0.5, max: 6, step: 0.1, value: a.minPx,
        format: (x) => `${x.toFixed(1)} px`,
        onInput: (x) => this.cambiar('minPx', x),
      }));
      add(slider({
        label: 'Tamaño maximo', min: 4, max: 80, step: 1, value: a.maxPx,
        format: (x) => `${x.toFixed(0)} px`,
        help: 'Limita cuanto se hincha un punto al acercarte mucho. Bajarlo evita que la '
          + 'pantalla se llene de manchas al entrar en detalle.',
        onInput: (x) => this.cambiar('maxPx', x),
      }));

      add(segmentado({
        label: 'Forma',
        value: a.forma,
        options: [
          { id: 'cuadrado', label: 'Cuadrado' },
          { id: 'circulo', label: 'Circulo' },
          { id: 'esfera', label: 'Esfera' },
        ],
        help: 'Esfera aplica un sombreado falso que da volumen; cuesta algo mas de GPU pero '
          + 'es lo que mejor se ve de cerca.',
        onChange: (id) => this.cambiar('forma', id),
      }));

      add(slider({
        label: 'Densidad mostrada', min: 5, max: 100, step: 1, value: Math.round(a.densidad * 100),
        format: (x) => `${x} %`,
        help: 'Dibuja solo una fraccion de los puntos. Como el buffer esta barajado, el '
          + 'submuestreo es uniforme: al bajarlo la nube se aclara, no se corta.',
        onInput: (x) => this.cambiar('densidad', x / 100),
      }));
    }

    if (this.tab === 'color') {
      const tieneColor = !!this.nube?.color;
      const tieneIntensidad = !!this.nube?.intensity;
      const tieneClase = !!this.nube?.classification;
      add(segmentado({
        label: 'Fuente de color',
        value: a.modoColor,
        options: [
          { id: 'rgb', label: 'RGB', disabled: !tieneColor },
          { id: 'elevacion', label: 'Altura' },
          { id: 'intensidad', label: 'Intensidad', disabled: !tieneIntensidad },
          { id: 'clasificacion', label: 'Clases', disabled: !tieneClase },
          { id: 'plano', label: 'Plano' },
        ],
        help: tieneColor ? null : 'Este fichero no trae color RGB.',
        onChange: (id) => { this.cambiar('modoColor', id); this._renderTab(); },
      }));

      if (a.modoColor === 'elevacion' || a.modoColor === 'intensidad') {
        add(segmentado({
          label: 'Rampa de color',
          value: a.colormap,
          options: Object.keys(COLORMAPS).map((k) => ({ id: k, label: COLORMAPS[k].label })),
          onChange: (id) => this.cambiar('colormap', id),
        }));
      }

      add(slider({
        label: 'Brillo', min: -0.5, max: 0.5, step: 0.01, value: a.brillo,
        format: (x) => x.toFixed(2), onInput: (x) => this.cambiar('brillo', x),
      }));
      add(slider({
        label: 'Contraste', min: 0.4, max: 2.5, step: 0.01, value: a.contraste,
        format: (x) => `${x.toFixed(2)}x`, onInput: (x) => this.cambiar('contraste', x),
      }));
      add(slider({
        label: 'Saturacion', min: 0, max: 2.5, step: 0.01, value: a.saturacion,
        format: (x) => `${x.toFixed(2)}x`, onInput: (x) => this.cambiar('saturacion', x),
      }));
      add(slider({
        label: 'Gamma', min: 0.4, max: 2.6, step: 0.01, value: a.gamma,
        format: (x) => x.toFixed(2),
        help: 'El RGB de los escaneres suele salir oscuro y apagado. Subir gamma y saturacion '
          + 'un poco es lo que mas cambia la sensacion de calidad.',
        onInput: (x) => this.cambiar('gamma', x),
      }));
    }

    if (this.tab === 'calidad') {
      add(conmutador({
        label: 'Eye-Dome Lighting',
        value: a.edl,
        help: 'Sombrea los saltos de profundidad. Es lo que hace que se distingan bordes, '
          + 'huecos y relieve en una nube sin normales. Casi gratis en GPU.',
        onChange: (on) => { this.cambiar('edl', on); this._renderTab(); },
      }));
      if (a.edl) {
        add(slider({
          label: 'Fuerza del EDL', min: 0.05, max: 1.5, step: 0.01, value: a.edlFuerza,
          format: (x) => x.toFixed(2), onInput: (x) => this.cambiar('edlFuerza', x),
        }));
        add(slider({
          label: 'Radio del EDL', min: 0.5, max: 4, step: 0.1, value: a.edlRadio,
          format: (x) => `${x.toFixed(1)} px`, onInput: (x) => this.cambiar('edlRadio', x),
        }));
      }

      add(segmentado({
        label: 'Resolucion de render',
        value: String(a.dprMax),
        options: [
          { id: '1', label: '1x rapido' },
          { id: '2', label: '2x equilibrado' },
          { id: '3', label: '3x nitido' },
        ],
        help: 'La pantalla del iPhone 14 es 3x. A 3x se ve mas fino pero se rellenan 9 veces '
          + 'mas pixeles: si baja de 30 fps, quedate en 2x.',
        onChange: (id) => this.cambiar('dprMax', Number(id)),
      }));

      add(slider({
        label: 'Densidad en movimiento', min: 10, max: 100, step: 5,
        value: Math.round(a.densidadMovimiento * 100),
        format: (x) => `${x} %`,
        help: 'Mientras arrastras el dedo se dibujan menos puntos para mantener la fluidez, '
          + 'y al soltar vuelve la nube completa.',
        onInput: (x) => this.cambiar('densidadMovimiento', x / 100),
      }));

      add(slider({
        label: 'Presupuesto de puntos', min: 1, max: 30, step: 1,
        value: Math.round(a.presupuesto / 1_000_000),
        format: (x) => `${x} M`,
        help: ES_IOS
          ? 'Se aplica en la proxima carga. Por encima de 12 M en un iPhone 14 es probable que '
            + 'Safari cierre la pestaña: si pasa, baja este valor.'
          : 'Se aplica en la proxima carga.',
        onInput: (x) => { this.ajustes.presupuesto = x * 1_000_000; this.guardarDiferido(); },
      }));
    }

    if (this.tab === 'vista') {
      add(segmentado({
        label: 'Vistas',
        value: null,
        options: [
          { id: 'arriba', label: 'Cenital' },
          { id: 'frente', label: 'Frontal' },
          { id: 'lado', label: 'Lateral' },
        ],
        onChange: (id) => v.setViewDirection(id),
      }));
      add(segmentado({
        label: 'Eje vertical del fichero',
        value: v.upAxis,
        options: [{ id: 'z', label: 'Z arriba' }, { id: 'y', label: 'Y arriba' }, { id: 'x', label: 'X arriba' }],
        help: 'LAS/LAZ y la mayoria de escaneres usan Z. Los PLY de fotogrametria suelen venir '
          + 'en Y. Si la nube sale tumbada, cambialo aqui.',
        onChange: (id) => { v.setUpAxis(id); this._renderTab(); },
      }));
      add(boton('Encuadrar toda la nube', () => v.frameAll(), 'secundario'));
      add(boton('Abrir otro fichero', () => this.dom.entrada.click(), 'secundario'));

      const info = add(bloqueInfo());
      const n = this.nube;
      if (n) {
        const dim = [n.max[0] - n.min[0], n.max[1] - n.min[1], n.max[2] - n.min[2]];
        info.set(`
          <div>Fichero: <b>${escape(n.name || '-')}</b></div>
          <div>Formato: <b>${escape(n.format || '-')}</b></div>
          <div>Puntos cargados: <b>${formatoNumero(n.count)}</b>${
            n.sourceCount > n.count ? ` de ${formatoNumero(n.sourceCount)}` : ''}</div>
          <div>Color RGB: <b>${n.color ? 'si' : 'no'}</b> · Intensidad: <b>${n.intensity ? 'si' : 'no'}</b></div>
          <div>Extension: <b>${dim.map((x) => x.toFixed(2)).join(' x ')} m</b></div>
          <div>Origen local: <b>${n.origin.map((x) => x.toFixed(2)).join(', ')}</b></div>
          <div>Tiempo de lectura: <b>${(n.parseMs / 1000).toFixed(1)} s</b></div>
          <div style="margin-top:10px">Doble toque en la nube: fija ahi el centro de giro.</div>
        `);
      } else {
        info.set('Sin nube cargada.');
      }
    }

    if (this.tab === 'dibujo') this._tabDibujo(add, a);
  }

  /**
   * Pestaña de dibujo.
   *
   * El orden importa: primero el papel (sin plano no hay nada que hacer),
   * luego el trazo, y al final guardar/exportar.
   */
  _tabDibujo(add, a) {
    const dib = this.dibujo;

    add(conmutador({
      label: 'Modo dibujo',
      value: dib.modo === 'dibujar',
      help: 'Con el lapiz (Apple Pencil) no hace falta activarlo: el lapiz dibuja siempre y el '
        + 'dedo sigue orbitando. Con el dedo, en modo dibujo un dedo dibuja y dos dedos giran.',
      onChange: (on) => { dib.setModo(on ? 'dibujar' : 'navegar'); this._renderTab(); },
    }));

    add(segmentado({
      label: 'Como se fija el papel',
      value: a.dibujoModoPlano,
      options: [
        { id: 'ajuste', label: 'Ajustar a la nube' },
        { id: 'vertical', label: 'Vertical' },
        { id: 'horizontal', label: 'Horizontal' },
        { id: 'camara', label: 'De frente' },
      ],
      help: 'Ajustar a la nube busca el plano real de la superficie que tocas (una fachada, un '
        + 'muro, el suelo) con los puntos de alrededor. Es lo que quieres casi siempre. Los otros '
        + 'tres imponen la orientacion sin mirar la nube.',
      onChange: (id) => { this.ajustes.dibujoModoPlano = id; dib.modoPlano = id; this.guardarDiferido(); },
    }));

    add(boton('Fijar un papel nuevo (toca la nube)', () => {
      dib.planoActivo = null;
      dib.setModo('dibujar');
      this.aviso('Toca la superficie donde quieras dibujar.', 5000);
      this._alternarPanel();
      this._renderTab();
    }, 'secundario'));

    const base = dib._radioPorDefecto();
    add(slider({
      label: 'Radio de ajuste', min: base / 6, max: base * 6, step: base / 60,
      value: dib.radioAjuste || base,
      format: (x) => formatoLongitud(x),
      help: 'Cuanta superficie se usa para calcular el plano. Grande = mas estable pero se come '
        + 'los quiebros; pequeño = sigue el detalle pero le afecta el ruido y los balcones.',
      onInput: (x) => { dib.radioAjuste = x; dib._actualizarRejilla(); },
    }));

    add(conmutador({
      label: 'Ver la rejilla del papel',
      value: dib.verRejilla,
      help: 'Dibuja una cuadricula sobre el plano de trabajo. Es lo unico que deja ver de un '
        + 'vistazo donde esta el papel y con que inclinacion.',
      onChange: (on) => { dib.verRejilla = on; dib._actualizarRejilla(); },
    }));

    add(slider({
      label: 'Grosor del trazo', min: 1, max: 12, step: 0.5, value: a.dibujoGrosor,
      format: (x) => `${x} px`,
      onInput: (x) => { this.cambiar('dibujoGrosor', x); this._aplicarAjustesDibujo(); },
    }));

    add(segmentado({
      label: 'Suavizado',
      value: String(a.dibujoSuavizado),
      options: [
        { id: '0', label: 'Ninguno' },
        { id: '1', label: 'Suave' },
        { id: '2', label: 'Mucho' },
      ],
      help: 'Solo afecta al trazo a mano alzada. Con el dedo, sin suavizado el trazo sale '
        + 'tembloroso; con lapiz nunca se aplica mas de una pasada.',
      onChange: (id) => { this.cambiar('dibujoSuavizado', Number(id)); this._aplicarAjustesDibujo(); },
    }));

    add(conmutador({
      label: 'Enganchar a rectas y vertices',
      value: a.dibujoEnganche,
      help: 'Los vertices se pegan a los de otros trazos, y los segmentos que se quedan a menos '
        + 'de 7 grados de la horizontal, la vertical o 45 grados se enderezan solos. Es lo que '
        + 'permite dibujar recto con el dedo.',
      onChange: (on) => { this.cambiar('dibujoEnganche', on); this._aplicarAjustesDibujo(); },
    }));

    add(slider({
      label: 'Separacion de la mira', min: 0, max: 90, step: 2, value: a.dibujoDesplazamiento,
      format: (x) => (x ? `${x} px` : 'sin mira'),
      help: 'El dedo tapa justo el punto que estas señalando. Con esto se dibuja por encima del '
        + 'contacto y la cruz te dice exactamente donde va a caer. A 0 se desactiva (util con '
        + 'lapiz o raton, que no tapan nada).',
      onInput: (x) => { this.cambiar('dibujoDesplazamiento', x); this._aplicarAjustesDibujo(); },
    }));

    add(conmutador({
      label: 'Enganchar a los puntos',
      value: a.dibujoAjustar,
      help: 'El primer punto de cada trazo se pega al punto real de la nube que hay bajo el dedo, '
        + 'si esta cerca del papel. Sirve para empezar exactamente en una esquina.',
      onChange: (on) => { this.cambiar('dibujoAjustar', on); this._aplicarAjustesDibujo(); },
    }));

    add(boton('Borrar todo el dibujo', () => {
      if (!dib.hayDibujo) { this.aviso('No hay nada dibujado.'); return; }
      dib.borrarTodo();
      this.aviso('Dibujo borrado. Se puede deshacer.');
    }, 'secundario'));

    add(boton('Guardar el dibujo en un fichero', () => this._exportarSesion(), 'secundario'));
    add(boton('Abrir un dibujo guardado', () => this.dom.entradaDibujo.click(), 'secundario'));

    add(conmutador({
      label: 'Exportar tambien la nube',
      value: a.dibujoIncluirNube,
      help: 'Apagado exporta solo el dibujo (unos pocos miles de puntos). Encendido mete la nube '
        + 'entera en el fichero: son cientos de MB y en un iPhone puede tumbar la pestaña.',
      onChange: (on) => this.cambiar('dibujoIncluirNube', on),
    }));
    add(boton('Exportar a PLY', () => this._exportar('ply'), 'secundario'));
    add(boton('Exportar a LAS', () => this._exportar('las'), 'secundario'));

    const info = add(bloqueInfo());
    this._infoDibujo = () => {
      const p = dib.planoActivo;
      const largo = dib.trazos.reduce((x, t) => x + t.longitud(), 0);
      info.set(`
        <div>Papel: <b>${p ? 'fijado' : 'sin fijar'}</b>${
          p && p.rms ? ` · desviacion del ajuste <b>${(p.rms * 1000).toFixed(0)} mm</b>` : ''}</div>
        <div>Trazos: <b>${dib.trazos.length}</b> · Longitud dibujada: <b>${formatoLongitud(largo)}</b></div>
        <div>Planos usados: <b>${dib.planos.size}</b></div>
        <div style="margin-top:10px">El dibujo se guarda solo en este navegador y vuelve a
        aparecer al reabrir la misma nube.</div>
      `);
    };
    this._infoDibujo();
  }

  // --- avisos ----------------------------------------------------------------

  aviso(texto, ms = 3500) {
    const a = this.dom.aviso;
    a.textContent = texto;
    a.style.background = '#1f3a5f';
    a.style.color = '#dbe9ff';
    a.classList.remove('oculto');
    clearTimeout(this._avisoT);
    this._avisoT = setTimeout(() => a.classList.add('oculto'), ms);
  }

  error(texto) {
    const a = this.dom.aviso;
    a.textContent = texto;
    a.style.background = '#7a2020';
    a.style.color = '#ffe9e9';
    a.classList.remove('oculto');
    clearTimeout(this._avisoT);
    this._avisoT = setTimeout(() => a.classList.add('oculto'), 9000);
  }
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
