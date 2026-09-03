// Shaders del visor. Tres decisiones que marcan la diferencia visual:
//
//  1. Tamaño de punto con dos modos: pixeles fijos (util para inspeccionar) y
//     atenuado por distancia (tamaño real en metros, que es lo que hace que la
//     nube parezca una superficie y no confeti).
//  2. Puntos redondos con sombreado esferico opcional: da volumen sin normales.
//  3. Eye-Dome Lighting en post-proceso. Es el truco de Potree y es lo que
//     convierte una nube plana en algo donde se leen los bordes y la geometria.

export const POINT_VERTEX = /* glsl */ `
precision highp float;

attribute vec3 aColor;
attribute float aIntensity;
attribute float aClass;

uniform int   uColorMode;       // 0 RGB, 1 elevacion, 2 intensidad, 3 clasificacion, 4 plano
uniform int   uSizeMode;        // 0 pixeles fijos, 1 atenuado por distancia
uniform float uPointSize;       // px logicos
uniform float uWorldSize;       // metros
uniform float uProjFactor;      // 0.5 * altura_px / tan(fov/2)
uniform float uPixelRatio;
uniform float uMinSize;
uniform float uMaxSize;
uniform vec2  uElevRange;
uniform vec2  uIntensityRange;
uniform vec3  uUpAxis;

varying vec3  vColor;
varying float vScalar;
varying float vViewZ;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vViewZ = -mv.z;

  vColor = aColor;
  vScalar = 0.0;
  if (uColorMode == 1) {
    float h = dot(position, uUpAxis);
    vScalar = clamp((h - uElevRange.x) / max(1e-6, uElevRange.y - uElevRange.x), 0.0, 1.0);
  } else if (uColorMode == 2) {
    vScalar = clamp((aIntensity - uIntensityRange.x) / max(1.0, uIntensityRange.y - uIntensityRange.x), 0.0, 1.0);
  } else if (uColorMode == 3) {
    // Media textura de desplazamiento: cae en el centro del texel de la clase.
    vScalar = (aClass + 0.5) / 256.0;
  }

  float size;
  if (uSizeMode == 0) {
    size = uPointSize * uPixelRatio;
  } else {
    size = uWorldSize * uProjFactor / max(0.0001, vViewZ);
  }
  gl_PointSize = clamp(size, uMinSize * uPixelRatio, uMaxSize * uPixelRatio);
}
`;

export const POINT_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uLut;
uniform int   uColorMode;
uniform int   uShape;          // 0 cuadrado, 1 circulo, 2 esfera sombreada
uniform vec3  uFlatColor;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uGamma;

varying vec3  vColor;
varying float vScalar;
varying float vViewZ;

vec3 adjust(vec3 c) {
  c = pow(max(c, 0.0), vec3(1.0 / uGamma));
  c = (c - 0.5) * uContrast + 0.5 + uBrightness;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (uShape > 0 && r2 > 1.0) discard;

  vec3 base;
  if (uColorMode == 0)      base = vColor;
  else if (uColorMode == 4) base = uFlatColor;
  else                      base = texture2D(uLut, vec2(vScalar, 0.5)).rgb;

  base = adjust(base);

  if (uShape == 2) {
    // Normal de la semiesfera implicita: iluminacion barata que da volumen.
    vec3 n = vec3(d, sqrt(max(0.0, 1.0 - r2)));
    float lambert = max(dot(n, normalize(vec3(0.35, 0.45, 0.82))), 0.0);
    base *= 0.45 + 0.55 * lambert;
  }

  gl_FragColor = vec4(base, 1.0);
}
`;

// --- Post-proceso: Eye-Dome Lighting + fondo degradado -----------------------

export const FULLSCREEN_VERTEX = /* glsl */ `
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const EDL_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2  uTexel;
uniform float uStrength;
uniform float uRadius;
uniform vec2  uNearFar;
uniform vec3  uBgTop;
uniform vec3  uBgBottom;
uniform int   uEnabled;

varying vec2 vUv;

float linearDepth(float d) {
  float n = uNearFar.x, f = uNearFar.y;
  float ndc = d * 2.0 - 1.0;
  return (2.0 * n * f) / (f + n - ndc * (f - n));
}

void main() {
  float d0 = texture2D(tDepth, vUv).r;
  vec3 bg = mix(uBgBottom, uBgTop, vUv.y);

  if (d0 >= 1.0) {
    gl_FragColor = vec4(bg, 1.0);
    return;
  }

  vec3 color = texture2D(tColor, vUv).rgb;

  if (uEnabled == 0) {
    gl_FragColor = vec4(color, 1.0);
    return;
  }

  float z0 = log2(linearDepth(d0) + 1.0);
  float response = 0.0;
  float count = 0.0;

  // Ocho vecinos en anillo. Mas muestras apenas mejoran y cuestan en movil.
  const int N = 8;
  vec2 offsets[8];
  offsets[0] = vec2( 1.0,  0.0); offsets[1] = vec2(-1.0,  0.0);
  offsets[2] = vec2( 0.0,  1.0); offsets[3] = vec2( 0.0, -1.0);
  offsets[4] = vec2( 0.7,  0.7); offsets[5] = vec2(-0.7,  0.7);
  offsets[6] = vec2( 0.7, -0.7); offsets[7] = vec2(-0.7, -0.7);

  for (int i = 0; i < N; i++) {
    vec2 uv = vUv + offsets[i] * uTexel * uRadius;
    float di = texture2D(tDepth, uv).r;
    // El fondo se ignora (se trata como infinitamente lejos): asi se oscurece
    // lo que queda DETRAS de un borde, no la silueta contra el cielo.
    float zi = di >= 1.0 ? z0 : log2(linearDepth(di) + 1.0);
    response += max(0.0, z0 - zi);
    count += 1.0;
  }

  response /= count;
  float shade = exp(-response * 300.0 * uStrength);
  gl_FragColor = vec4(color * shade, 1.0);
}
`;

// Material de seleccion: empaqueta la profundidad de vista en RGBA8 para poder
// leerla con readRenderTargetPixels y saber donde ha tocado el dedo.
export const PICK_VERTEX = /* glsl */ `
precision highp float;
uniform float uPointSize;
uniform float uFar;
varying float vDepth;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vDepth = clamp(-mv.z / uFar, 0.0, 0.999999);
  gl_PointSize = uPointSize;
}
`;

export const PICK_FRAGMENT = /* glsl */ `
precision highp float;
varying float vDepth;
vec4 packDepth(float v) {
  vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * v;
  enc = fract(enc);
  enc -= enc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  return enc;
}
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  if (dot(d, d) > 1.0) discard;
  gl_FragColor = packDepth(vDepth);
}
`;
