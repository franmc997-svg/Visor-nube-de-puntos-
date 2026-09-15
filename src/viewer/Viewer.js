import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  POINT_VERTEX, POINT_FRAGMENT, FULLSCREEN_VERTEX, EDL_FRAGMENT, PICK_VERTEX, PICK_FRAGMENT,
} from './shaders.js';
import { COLORMAPS, classificationLut } from './colormaps.js';

const COLOR_MODES = { rgb: 0, elevacion: 1, intensidad: 2, clasificacion: 3, plano: 4 };
const SHAPES = { cuadrado: 0, circulo: 1, esfera: 2 };

function lutTexture(data) {
  const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** El LUT de clases NO debe interpolar: cada texel es una clase distinta. */
function classTexture() {
  const tex = lutTexture(classificationLut());
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

// El visor trabaja directamente en espacio sRGB: los colores de los ficheros
// vienen como bytes sRGB y los shaders los escriben tal cual. Si dejamos la
// gestion de color de three activada, convierte los uniforms de color a lineal
// y el fondo sale casi negro.
THREE.ColorManagement.enabled = false;

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,       // los puntos no se benefician del MSAA; el EDL si del ancho de banda
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
    this.camera.position.set(0, 0, 10);

    // Nodo intermedio: aqui se aplica la rotacion de eje vertical (Z-up -> Y-up).
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.8;
    this.controls.screenSpacePanning = true;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener('start', () => this._setInteracting(true));
    this.controls.addEventListener('end', () => this._scheduleIdle(true));
    this.controls.addEventListener('change', () => { this.needsRender = true; this._scheduleIdle(); });

    this.luts = {};
    for (const key of Object.keys(COLORMAPS)) this.luts[key] = lutTexture(COLORMAPS[key].data);
    this.luts.__class = classTexture();

    this.pointMaterial = new THREE.ShaderMaterial({
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      uniforms: {
        uColorMode: { value: 0 },
        uSizeMode: { value: 1 },
        uPointSize: { value: 2.0 },
        uWorldSize: { value: 0.03 },
        uProjFactor: { value: 500 },
        uPixelRatio: { value: 1 },
        uMinSize: { value: 1.0 },
        uMaxSize: { value: 40.0 },
        uElevRange: { value: new THREE.Vector2(0, 1) },
        uIntensityRange: { value: new THREE.Vector2(0, 65535) },
        uUpAxis: { value: new THREE.Vector3(0, 0, 1) },
        uLut: { value: this.luts.turbo },
        uShape: { value: 1 },
        uFlatColor: { value: new THREE.Color(0xffffff) },
        uBrightness: { value: 0.0 },
        uContrast: { value: 1.0 },
        uSaturation: { value: 1.0 },
        uGamma: { value: 1.0 },
      },
    });

    this.pickMaterial = new THREE.ShaderMaterial({
      vertexShader: PICK_VERTEX,
      fragmentShader: PICK_FRAGMENT,
      uniforms: { uPointSize: { value: 4 }, uFar: { value: 5000 } },
    });

    this.edlMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: EDL_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uStrength: { value: 0.35 },
        uRadius: { value: 1.4 },
        uNearFar: { value: new THREE.Vector2(0.1, 5000) },
        uBgTop: { value: new THREE.Color(0x1b2430) },
        uBgBottom: { value: new THREE.Color(0x070a0e) },
        uEnabled: { value: 1 },
      },
    });
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.edlMaterial));

    this.target = null;
    this._cacheTargets = new Map();   // "AxB" -> WebGLRenderTarget
    this.pickTarget = new THREE.WebGLRenderTarget(9, 9, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true,
    });

    this.points = null;
    this.cloud = null;
    this.upAxis = 'z';

    // Capa del dibujo. Cuelga de `root` (no de la escena) para que los trazos
    // acompañen a la nube cuando se corrige el eje vertical, y se dibuja en la
    // misma pasada que los puntos: asi el EDL y la profundidad la tratan igual
    // que al resto de la escena y un trazo que queda detras del edificio se
    // oculta como es debido.
    this.overlay = new THREE.Group();
    this.overlay.frustumCulled = false;
    this.root.add(this.overlay);

    // Calidad adaptativa
    this.settings = {
      density: 1.0,            // fraccion de puntos dibujados en reposo
      interactiveDensity: 0.4, // fraccion mientras el dedo esta en pantalla
      maxPixelRatio: 2.0,
      interactivePixelRatio: 1.25,
      edl: true,
    };
    this.interacting = false;
    this._idleTimer = 0;
    this.needsRender = true;
    this.fps = 0;
    this._frames = 0;
    this._fpsT0 = performance.now();
    this.drawnPoints = 0;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this._onResize);
    this.resize();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // --- carga -----------------------------------------------------------------

  setPointCloud(payload) {
    this.dispose();

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(payload.position, 3));

    const n = payload.count;
    if (payload.color) {
      geom.setAttribute('aColor', new THREE.BufferAttribute(payload.color, 3, true));
    } else {
      const white = new Uint8Array(n * 3).fill(255);
      geom.setAttribute('aColor', new THREE.BufferAttribute(white, 3, true));
    }
    geom.setAttribute('aIntensity', new THREE.BufferAttribute(
      payload.intensity || new Uint16Array(n), 1, false));
    geom.setAttribute('aClass', new THREE.BufferAttribute(
      payload.classification || new Uint8Array(n), 1, false));

    // El bbox se calcula a mano: computeBoundingSphere() sobre 10 M de puntos
    // cuesta mas de lo que vale, y ya conocemos los extremos del parseo.
    const o = payload.origin;
    const lo = new THREE.Vector3(payload.min[0] - o[0], payload.min[1] - o[1], payload.min[2] - o[2]);
    const hi = new THREE.Vector3(payload.max[0] - o[0], payload.max[1] - o[1], payload.max[2] - o[2]);
    geom.boundingBox = new THREE.Box3(lo, hi);
    geom.boundingSphere = geom.boundingBox.getBoundingSphere(new THREE.Sphere());

    this.points = new THREE.Points(geom, this.pointMaterial);
    this.points.frustumCulled = false;   // un unico objeto que siempre esta a la vista
    this.root.add(this.points);

    this.cloud = payload;
    const ejeConjeturado = payload.upAxis === 'auto';
    this.setUpAxis(ejeConjeturado ? guessUpAxis(lo, hi) : payload.upAxis);

    const u = this.pointMaterial.uniforms;
    u.uColorMode.value = payload.color ? COLOR_MODES.rgb : COLOR_MODES.elevacion;
    if (payload.intensityRange) u.uIntensityRange.value.set(payload.intensityRange[0], payload.intensityRange[1]);

    this._updateElevationRange();
    this._autoScale(geom.boundingSphere);
    this.frameAll();
    this.setDensity(this.settings.density);
    this.needsRender = true;
    return {
      colorMode: payload.color ? 'rgb' : 'elevacion',
      ejeConjeturado,
      upAxis: this.upAxis,
    };
  }

  dispose() {
    if (this.points) {
      this.root.remove(this.points);
      this.points.geometry.dispose();
      this.points = null;
    }
    this.cloud = null;
  }

  /** Ajusta near/far, velocidad y tamaño de punto por defecto al tamaño real de la nube. */
  _autoScale(sphere) {
    const r = Math.max(1e-3, sphere.radius);
    this.camera.near = Math.max(1e-3, r / 5000);
    this.camera.far = r * 60;
    this.camera.updateProjectionMatrix();
    this.pickMaterial.uniforms.uFar.value = this.camera.far;
    this.edlMaterial.uniforms.uNearFar.value.set(this.camera.near, this.camera.far);
    // Tamaño en metros orientativo: la separacion media si la nube fuese una
    // superficie. Es una estimacion, pero deja el visor usable sin tocar nada.
    const spacing = 3.0 * r / Math.sqrt(Math.max(1, this.cloud.count));
    this.pointMaterial.uniforms.uWorldSize.value = Math.max(1e-4, spacing);
    this.defaultWorldSize = this.pointMaterial.uniforms.uWorldSize.value;
    this.controls.minDistance = this.camera.near * 10;
    this.controls.maxDistance = r * 20;
  }

  _updateElevationRange() {
    if (!this.points) return;
    const bb = this.points.geometry.boundingBox;
    const axis = this.upAxis === 'z' ? 'z' : this.upAxis === 'x' ? 'x' : 'y';
    this.pointMaterial.uniforms.uElevRange.value.set(bb.min[axis], bb.max[axis]);
  }

  setUpAxis(axis) {
    this.upAxis = axis;
    // El mundo de three es Y-up; giramos el contenedor, no los datos.
    this.root.rotation.set(0, 0, 0);
    if (axis === 'z') this.root.rotation.x = -Math.PI / 2;
    else if (axis === 'x') this.root.rotation.z = Math.PI / 2;
    const v = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis] || [0, 0, 1];
    this.pointMaterial.uniforms.uUpAxis.value.set(v[0], v[1], v[2]);
    this._updateElevationRange();
    this.needsRender = true;
  }

  // --- encuadre --------------------------------------------------------------

  frameAll() {
    if (!this.points) return;
    const sphere = this.points.geometry.boundingSphere;
    const center = sphere.center.clone().applyMatrix4(this.root.matrixWorld);
    const r = Math.max(1e-3, sphere.radius);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 1.1;
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0.6, 0.45, 1).normalize().multiplyScalar(dist));
    this.controls.update();
    this.needsRender = true;
  }

  setViewDirection(dir) {
    if (!this.points) return;
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target);
    const v = { arriba: [0, 1, 0.0001], frente: [0, 0, 1], lado: [1, 0, 0] }[dir] || [0, 0, 1];
    this.camera.position.copy(target).add(new THREE.Vector3(v[0], v[1], v[2]).normalize().multiplyScalar(dist));
    this.controls.update();
    this.needsRender = true;
  }

  /**
   * Convierte un toque en pantalla en un punto 3D leyendo la profundidad.
   * Un raycast contra 10 M de puntos seria O(n) por toque; esto es una pasada
   * de vertices y un readPixels de 9x9.
   */
  pickAt(clientX, clientY, fraccion = 1) {
    if (!this.points) return null;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.renderer.getPixelRatio();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    const px = Math.round((clientX - rect.left) * dpr);
    const py = Math.round((clientY - rect.top) * dpr);
    const S = 9, half = (S - 1) / 2;

    this.camera.setViewOffset(w, h, px - half, py - half, S, S);
    this.camera.updateProjectionMatrix();

    const prevMat = this.points.material;
    this.points.material = this.pickMaterial;
    // Los trazos escriben profundidad: si se colasen en el pase de seleccion,
    // tocar encima de uno devolveria la profundidad del trazo, no la del punto.
    const overlayVisible = this.overlay.visible;
    this.overlay.visible = false;
    this.pickMaterial.uniforms.uFar.value = this.camera.far;
    const prevRange = this.points.geometry.drawRange.count;
    // Con `fraccion` se sondea contra una parte de la nube. Para saber si el
    // dedo cae sobre la fachada o en el aire no hace falta el buffer entero, y
    // esa consulta se repite varias veces por segundo mientras se dibuja.
    // El buffer viene barajado de la carga, asi que un prefijo es una muestra
    // uniforme de toda la nube.
    const cuantos = Math.max(1, Math.round(this.cloud.count * Math.min(1, Math.max(0.01, fraccion))));
    this.points.geometry.setDrawRange(0, cuantos);

    this.renderer.setRenderTarget(this.pickTarget);
    this.renderer.setClearColor(0xffffff, 1);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, this.camera);
    const buf = new Uint8Array(S * S * 4);
    this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, S, S, buf);
    this.renderer.setRenderTarget(null);

    this.points.material = prevMat;
    this.overlay.visible = overlayVisible;
    this.points.geometry.setDrawRange(0, prevRange);
    this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.needsRender = true;

    // Se elige el pixel valido mas cercano al centro del toque.
    let best = -1, bestDist = Infinity, bestDepth = 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const depth = (buf[i] + buf[i + 1] / 255 + buf[i + 2] / 65025 + buf[i + 3] / 16581375) / 255;
        if (depth <= 0 || depth >= 0.999) continue;
        const d = (x - half) ** 2 + (y - half) ** 2;
        if (d < bestDist) { bestDist = d; best = i; bestDepth = depth; }
      }
    }
    if (best < 0) return null;

    const viewZ = -bestDepth * this.camera.far;
    const ndcX = (px / w) * 2 - 1;
    const ndcY = 1 - (py / h) * 2;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const aspect = w / h;
    const p = new THREE.Vector3(
      ndcX * tanHalf * aspect * (-viewZ),
      ndcY * tanHalf * (-viewZ),
      viewZ,
    );
    return p.applyMatrix4(this.camera.matrixWorld);
  }

  /** Fija el centro de orbita en el punto tocado, sin mover la camara. */
  focusAt(clientX, clientY) {
    const p = this.pickAt(clientX, clientY);
    if (!p) return false;
    this.controls.target.copy(p);
    this.controls.update();
    this.needsRender = true;
    return true;
  }

  // --- ajustes ---------------------------------------------------------------

  setColorMode(mode) {
    const u = this.pointMaterial.uniforms;
    u.uColorMode.value = COLOR_MODES[mode] ?? 0;
    if (mode === 'clasificacion') u.uLut.value = this.luts.__class;
    else if (this.colormap) u.uLut.value = this.luts[this.colormap];
    this.needsRender = true;
  }

  setColormap(name) {
    this.colormap = name;
    if (this.pointMaterial.uniforms.uColorMode.value !== COLOR_MODES.clasificacion) {
      this.pointMaterial.uniforms.uLut.value = this.luts[name] || this.luts.turbo;
    }
    this.needsRender = true;
  }

  setShape(shape) { this.pointMaterial.uniforms.uShape.value = SHAPES[shape] ?? 1; this.needsRender = true; }
  setSizeMode(mode) { this.pointMaterial.uniforms.uSizeMode.value = mode === 'fijo' ? 0 : 1; this.needsRender = true; }
  setPointSize(px) { this.pointMaterial.uniforms.uPointSize.value = px; this.needsRender = true; }
  setWorldSize(m) { this.pointMaterial.uniforms.uWorldSize.value = m; this.needsRender = true; }
  setMinSize(px) { this.pointMaterial.uniforms.uMinSize.value = px; this.needsRender = true; }
  setMaxSize(px) { this.pointMaterial.uniforms.uMaxSize.value = px; this.needsRender = true; }
  setBrightness(v) { this.pointMaterial.uniforms.uBrightness.value = v; this.needsRender = true; }
  setContrast(v) { this.pointMaterial.uniforms.uContrast.value = v; this.needsRender = true; }
  setSaturation(v) { this.pointMaterial.uniforms.uSaturation.value = v; this.needsRender = true; }
  setGamma(v) { this.pointMaterial.uniforms.uGamma.value = Math.max(0.1, v); this.needsRender = true; }
  setEdl(on) { this.settings.edl = on; this.edlMaterial.uniforms.uEnabled.value = on ? 1 : 0; this.needsRender = true; }
  setEdlStrength(v) { this.edlMaterial.uniforms.uStrength.value = v; this.needsRender = true; }
  setEdlRadius(v) { this.edlMaterial.uniforms.uRadius.value = v; this.needsRender = true; }

  setDensity(fraction) {
    this.settings.density = Math.max(0.01, Math.min(1, fraction));
    this._applyDrawRange();
    this.needsRender = true;
  }

  setMaxPixelRatio(v) {
    this.settings.maxPixelRatio = v;
    this.resize();
  }

  setBackground(topHex, bottomHex) {
    this.edlMaterial.uniforms.uBgTop.value.setHex(topHex);
    this.edlMaterial.uniforms.uBgBottom.value.setHex(bottomHex);
    this.needsRender = true;
  }

  _applyDrawRange() {
    if (!this.points) return;
    const total = this.cloud.count;
    const f = this.interacting
      ? Math.min(this.settings.density, this.settings.interactiveDensity)
      : this.settings.density;
    // El buffer esta barajado, asi que los primeros N puntos son una muestra
    // uniforme de toda la nube: el LOD sale gratis moviendo el drawRange.
    this.drawnPoints = Math.max(1, Math.floor(total * f));
    this.points.geometry.setDrawRange(0, this.drawnPoints);
  }

  _setInteracting(on) {
    if (this.interacting === on) return;
    if (!on) { clearTimeout(this._idleTimer); clearTimeout(this._idleTimerDuro); }
    this.interacting = on;
    this._applyDrawRange();
    this._applyPixelRatio();
    this.needsRender = true;
  }

  /**
   * Vuelve a calidad completa cuando cesa el movimiento.
   *
   * OrbitControls con amortiguacion emite 'change' en cada fotograma mientras
   * el giro se frena, y eso reprograma el temporizador una y otra vez. En un
   * movil lento la nube podria quedarse en calidad reducida varios segundos,
   * asi que al soltar el dedo se arma ademas un limite duro.
   */
  _scheduleIdle(dedoLevantado = false) {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this._setInteracting(false), 180);
    if (dedoLevantado) {
      clearTimeout(this._idleTimerDuro);
      this._idleTimerDuro = setTimeout(() => this._setInteracting(false), 700);
    }
    this.needsRender = true;
  }

  _applyPixelRatio() {
    const dpr = this.interacting
      ? Math.min(this.settings.interactivePixelRatio, this.settings.maxPixelRatio)
      : this.settings.maxPixelRatio;
    const clamped = Math.min(window.devicePixelRatio || 1, dpr);
    if (this.renderer.getPixelRatio() !== clamped) {
      this.renderer.setPixelRatio(clamped);
      this._resizeTargets();
    }
  }

  // --- bucle -----------------------------------------------------------------

  resize() {
    for (const t of this._cacheTargets.values()) t.dispose();
    this._cacheTargets.clear();
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.settings.maxPixelRatio));
    this.renderer.setSize(w, h, false);
    this._resizeTargets();
    this.needsRender = true;
  }

  /**
   * Los render targets se cachean por tamaño.
   *
   * Al arrastrar el dedo bajamos la resolucion, y reasignar el buffer de color
   * + la textura de profundidad en cada gesto provoca tirones y fragmenta la
   * memoria de la GPU en iOS. Con dos tamaños vivos (reposo y movimiento) el
   * coste es una asignacion la primera vez y ninguna despues.
   */
  _resizeTargets() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, size.x), h = Math.max(1, size.y);
    const clave = `${w}x${h}`;
    let target = this._cacheTargets.get(clave);
    if (!target) {
      const depth = new THREE.DepthTexture(w, h);
      depth.type = THREE.UnsignedIntType;
      depth.minFilter = THREE.NearestFilter;
      depth.magFilter = THREE.NearestFilter;
      target = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthTexture: depth,
        depthBuffer: true,
        stencilBuffer: false,
      });
      // Solo tienen sentido dos tamaños simultaneos; si aparece un tercero (giro
      // de pantalla, cambio de calidad) se tira el mas antiguo.
      if (this._cacheTargets.size >= 2) {
        const [viejaClave, viejoTarget] = this._cacheTargets.entries().next().value;
        viejoTarget.dispose();
        this._cacheTargets.delete(viejaClave);
      }
      this._cacheTargets.set(clave, target);
    }
    this.target = target;
    this.edlMaterial.uniforms.tColor.value = target.texture;
    this.edlMaterial.uniforms.tDepth.value = target.depthTexture;
    this.edlMaterial.uniforms.uTexel.value.set(1 / w, 1 / h);
    // gl_PointSize se expresa en pixeles del framebuffer, asi que el factor de
    // proyeccion tiene que usar la altura real del buffer, no la de CSS.
    this.pointMaterial.uniforms.uProjFactor.value =
      0.5 * h / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    this.pointMaterial.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    this.needsRender = true;
  }

  _loop() {
    requestAnimationFrame(this._loop);
    const damping = this.controls.update();
    if (!this.needsRender && !damping) return;
    this.needsRender = false;

    this.edlMaterial.uniforms.uNearFar.value.set(this.camera.near, this.camera.far);

    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, false);
    if (this.points) this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.quadScene, this.quadCamera);

    this._frames++;
    const now = performance.now();
    if (now - this._fpsT0 > 500) {
      this.fps = Math.round((this._frames * 1000) / (now - this._fpsT0));
      this._frames = 0;
      this._fpsT0 = now;
      this.onStats?.({ fps: this.fps, drawn: this.drawnPoints, activo: this.fps > 0 });
    }
  }
}

/**
 * Heuristica de eje vertical para formatos que no lo declaran (PLY, sobre todo).
 *
 * "La vertical es la dimension menor" solo vale para nubes con forma de plancha
 * (terreno, vuelo fotogrametrico). En un escaneo de fachada la dimension menor
 * es la PROFUNDIDAD, no la altura, y esa regla deja el edificio tumbado.
 *
 * Asi que solo se usa cuando la nube es realmente aplanada: las dos dimensiones
 * mayores parecidas entre si y la tercera claramente menor. En cualquier otro
 * caso se asume Z, que es la convencion de topografia y escaneo terrestre.
 *
 * Sigue siendo una conjetura: quien la use debe avisar al usuario y ofrecerle
 * cambiarla.
 */
function guessUpAxis(min, max) {
  const d = [max.x - min.x, max.y - min.y, max.z - min.z];
  const ordenados = d.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const [mayor, medio, menor] = ordenados;
  const esPlancha = mayor[0] <= medio[0] * 1.6 && menor[0] <= medio[0] * 0.5;
  return esPlancha ? ['x', 'y', 'z'][menor[1]] : 'z';
}
