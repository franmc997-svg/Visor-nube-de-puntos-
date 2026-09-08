# Visor de nube de puntos

Visor web de nubes de puntos con color, hecho para funcionar bien en un
**iPhone 14 con Safari**. Se abre desde el navegador, lee el fichero desde la
app Archivos (o desde una URL) y lo dibuja con control fino del tamaño de punto.

No hay servidor ni conversion previa: el fichero se lee entero en el telefono.

---

## Lo que hay que saber antes de empezar

**El limite real no es la GPU, es la memoria de Safari.** Safari en iOS cierra
la pestaña alrededor de 1-1,5 GB. Cada punto con color cuesta unos 16 bytes en
GPU (12 de posicion en Float32 + 4 de color), mas los buffers temporales del
parseo. De ahi sale el presupuesto por defecto:

| Dispositivo | Presupuesto por defecto | Techo razonable |
|---|---|---|
| iPhone / iPad | 8 M de puntos | ~12 M |
| Escritorio | 20 M de puntos | 30 M+ |

Si el fichero trae mas puntos, **se submuestrea de forma uniforme durante la
lectura** (nunca despues: asi el pico de memoria no se dispara) y el visor te
avisa del porcentaje que ha conservado. El submuestreo es aleatorio, no por
saltos regulares, para no perder lineas de escaneo enteras.

**Si tu nube pasa de ~30 M de puntos, esta herramienta no es la respuesta.**
Ahi hace falta un octree en disco con carga por niveles: convierte a
[COPC](https://copc.io) o a un octree de [Potree](https://github.com/potree/PotreeConverter)
en el escritorio y sirve eso. Un visor de un solo buffer, por bien optimizado
que este, no llega.

---

## Formatos soportados

| Formato | Notas |
|---|---|
| **LAS** 1.0-1.4, formatos de punto 0-10 | Lectura por bloques; el fichero nunca esta entero en memoria. RGB de 8 o 16 bits detectado automaticamente. |
| **LAZ** | Descomprimido con `laz-perf` (WASM). Necesita el fichero comprimido entero en memoria: comodo hasta ~250 MB de `.laz` en un iPhone. |
| **PLY** | `ascii`, `binary_little_endian` y `binary_big_endian`. Color en `red/green/blue`, `r/g/b` o `diffuse_*`, en `uchar` o en `float` 0-1. |
| **PCD** | `ascii`, `binary` y `binary_compressed` (LZF). Campo `rgb`/`rgba` empaquetado de PCL. |
| **XYZ / TXT / CSV / ASC / PTS** | Detecta el separador y las columnas: `x y z`, `x y z i`, `x y z r g b`, `x y z i r g b`. |
| E57 | **No soportado.** Conviertelo con CloudCompare o `pdal translate`. |

La eleccion entre LAS y LAZ se hace por el bit de compresion del cabecero, no
por la extension: los `.laz` sin comprimir y los `.las` comprimidos que circulan
por ahi se abren igual.

---

## Uso en el iPhone

1. Publica la carpeta `dist/` en cualquier hosting estatico con **HTTPS**
   (Netlify, Vercel, GitHub Pages, un `nginx`…). En local basta con
   `npm run dev` y entrar desde el movil por la IP del portatil.
2. Abre la URL en Safari.
3. **Compartir → Añadir a pantalla de inicio.** Se instala como app a pantalla
   completa, sin la barra del navegador (es una PWA), que es donde mejor se ve.
4. Botón **Abrir fichero** → la nube puede estar en iCloud Drive, en Archivos,
   en Dropbox o en cualquier sitio que aparezca en el selector de iOS.

> El selector muestra **todos** los ficheros, sin filtrar por extension, y es a
> proposito. iOS traduce el atributo `accept` a tipos del sistema (UTI), y no
> conoce `.ply`, `.las`, `.laz` ni `.pcd`: con el filtro puesto los deja en gris
> y no deja seleccionarlos. El formato se detecta por los bytes del cabecero,
> asi que el filtro no aportaba nada.

Tambien puedes pasarle una URL directa: `https://tu-sitio/?url=https://…/nube.laz`
(el servidor de origen tiene que permitir CORS).

### Gestos

| Gesto | Accion |
|---|---|
| Un dedo | Orbitar |
| Dos dedos | Zoom y desplazamiento |
| **Doble toque** | Fija el centro de giro en el punto tocado |

El doble toque es la diferencia entre poder inspeccionar un detalle y pelearte
con la camara: sin el, orbitas siempre alrededor del centro de la nube.

---

## Dibujar sobre la nube

### La idea: no se dibuja sobre la nube, se dibuja sobre un plano

Una nube de puntos **no tiene superficie**. Son puntos sueltos con huecos entre
ellos, asi que pegar el trazo a la profundidad de lo que hay bajo el dedo da
lineas onduladas que siguen el ruido del escaner y que, al cruzar una ventana,
saltan al muro del fondo.

Por eso el visor hace lo mismo que las apps de croquis 3D: **fija un papel** (un
plano de trabajo) y dibuja encima. Tocas una fachada, se ajusta un plano a los
puntos de alrededor, y ese plano es el lienzo. El trazo sale limpio, se queda
pegado a la nube al orbitar, y como se guarda en coordenadas 2D del plano
(en metros), es geometria real y no una mancha en pantalla.

Una **rejilla azul** marca donde esta el papel y con que inclinacion. Sin ella,
el primer trazo siempre sorprende.

### Gestos

| Con que | Modo Navegar | Modo Dibujo |
|---|---|---|
| **Lapiz** (Apple Pencil, stylus) | **dibuja** | dibuja |
| Un dedo | orbita | **dibuja** |
| Dos dedos | zoom y desplazamiento | zoom y desplazamiento |
| Raton, boton izquierdo | orbita | **dibuja** |
| Raton, boton derecho | desplaza | desplaza |

El lapiz dibuja siempre, sin tocar ningun boton, y el dedo sigue orbitando: es
el reparto de todas las apps de croquis y no hay que aprenderlo. Con el dedo
hace falta el boton **✎** del HUD, y ahi **dos dedos siguen moviendo la camara**
(si aparece el segundo dedo a mitad de un trazo, ese trazo se descarta).

### Como se fija el papel

El primer toque en modo dibujo fija el plano. Hay cuatro formas, en la pestaña
*Dibujo*:

- **Ajustar a la nube** (por defecto) — analisis de componentes principales
  sobre los puntos que rodean al toque: se busca el plano real de la fachada, el
  muro o el suelo. Se hace en dos pasadas, descartando en la segunda los puntos
  a mas de 2 sigma, porque si no un balcon o un arbol delante inclinan el papel
  varios grados. El panel muestra la desviacion del ajuste en mm: es la medida
  de cuanto te puedes fiar del plano.
- **Vertical** — plano vertical de cara a la camara.
- **Horizontal** — plano a nivel, para plantas.
- **De frente** — perpendicular a la vista, como un cristal delante.

El **radio de ajuste** decide cuanta superficie se mira: grande es mas estable
pero se come los quiebros; pequeño sigue el detalle pero le afectan el ruido y
los salientes.

> **Papel de canto.** Por debajo de unos 15 grados de incidencia, un pixel de
> pantalla son metros de papel y el trazo se dispara al horizonte. El visor no
> deja dibujar ahi y te pide que gires la vista. Es el fallo clasico de dibujar
> sobre planos, y sin esta guarda tres garabatos sobre el suelo visto en
> escorzo salen como 600 m de linea.

### Precision con el dedo

Dibujar con el dedo en un movil tiene tres problemas, y ninguno se arregla
suavizando el trazo:

- **La yema tapa el punto.** Son 8-10 mm de incertidumbre justo donde estas
  apuntando. Por eso se dibuja **por encima del contacto**, con una **mira** en
  cruz que marca donde va a caer el punto de verdad. La separacion se regula en
  el panel (a 0 se desactiva, que es lo suyo con lapiz o raton).
- **A pulso no sale nada recto.** Los segmentos que se quedan a menos de **7
  grados** de la horizontal, la vertical o 45 grados **se enderezan solos**, y
  los vertices se pegan a los de otros trazos si estan a menos de 16 px. En una
  fachada, recto significa a nivel y a plomo: eso es lo que hace utilizable el
  dibujo, no el suavizado.
- **En tactil no hay puntero flotando**, asi que colocar vertices "tocando" es
  hacerlo a ciegas. Los vertices se **arrastran y se sueltan**: mientras
  arrastras ves la linea fantasma y su **medida en vivo** (longitud, angulo, y
  si esta enganchada).

### Herramientas

**Linea** es la herramienta por defecto y la unica que da precision con el dedo:
arrastra y suelta cada vertice, suelta sobre el ultimo para terminar (o sobre el
primero para cerrar la figura). Tambien esta el boton de terminar en la barra.

**Lapiz** (mano alzada, para quien tenga stylus), **Rect.** y **Borrar** (toca un
trazo y desaparece). Mas color, grosor, deshacer, y un suavizado que solo se
aplica a la mano alzada (con lapiz nunca pasa de una pasada: el trazo ya viene
fino).

Con **Enganchar a los puntos** activado, el primer punto de cada trazo se pega
al punto real de la nube que haya bajo la mira, para empezar exactamente en una
esquina del escaneo.

### Que sale de ahi

- **Se guarda solo.** El dibujo se conserva en el navegador y vuelve a aparecer
  al reabrir la misma nube (la clave es nombre + numero de puntos + bounding
  box, que en la practica es una huella del fichero).
- **Fichero `.json`** con los trazos, para llevartelo a otro dispositivo.
- **PLY o LAS** con el dibujo convertido en puntos coloreados, opcionalmente
  **con la nube entera dentro**. El LAS sale en 1.2 formato 2, con la
  georreferencia intacta (escala de 1 mm y offset en el cabecero), asi que se
  puede volver a abrir en este visor, en CloudCompare o en lo que sea.

> Exportar la nube entera en un iPhone son cientos de MB: el fichero se monta
> por trozos para no reservar un solo bloque gigante, pero sigue siendo la
> operacion mas cara de la aplicacion. Por defecto se exporta solo el dibujo.

**Lo que todavia no hay: DXF.** Los trazos ya viven en coordenadas 2D del plano,
que es exactamente lo que necesita un alzado a escala; falta escribir el fichero.
Mientras tanto, lo que exportas son puntos: se ven, no se acotan.

---

## El ajuste fino del tamaño de punto

Es el control que mas cambia la calidad percibida, asi que esta siempre visible
en la barra inferior, sin abrir el panel.

**Dos modos:**

- **Metros (3D)** — el punto tiene un tamaño real en el mundo y crece al
  acercarte. Es lo que hace que la nube se lea como una **superficie continua**
  en vez de como confeti. Es el modo por defecto.
- **Pixeles (2D)** — todos los puntos miden lo mismo en pantalla. Sirve para
  juzgar la densidad real del escaneo y para ver a traves de la nube.

**El ajuste fino:** el deslizador es logaritmico y cubre tres ordenes de
magnitud alrededor del espaciado estimado de la nube. Cada paso cambia el tamaño
un **0,7 %**, y los botones `−` / `+` avanzan de paso en paso (manteniendo
pulsado, de forma continua). En metros el valor se muestra en mm, cm o m.

Ademas hay **tamaño minimo y maximo en pixeles**, que acotan el resultado: el
minimo evita que los puntos lejanos desaparezcan, y el maximo evita que la
pantalla se llene de manchas cuando te acercas mucho.

---

## Lo que hace que se vea bien

- **Eye-Dome Lighting.** Un post-proceso que oscurece lo que queda detras de una
  discontinuidad de profundidad. Es lo que hace que se lean bordes, huecos y
  relieve en una nube que no tiene normales ni iluminacion. Cuesta una pasada a
  pantalla completa: practicamente gratis. Se puede regular la fuerza y el radio.
- **Puntos redondos con sombreado esferico** (opcional). Calcula una normal
  implicita en el fragmento y aplica un lambert barato: da volumen sin datos
  extra.
- **Correccion de color.** El RGB de los escaneres suele salir oscuro y apagado;
  hay brillo, contraste, saturacion y gamma. Subir gamma y saturacion un poco es
  lo que mas mejora la sensacion de calidad en fotogrametria.
- **Color por altura, intensidad o clasificacion ASPRS**, con rampas Turbo,
  Viridis, Inferno, grises y terreno. La paleta de clases usa filtrado *nearest*
  para que las clases no se mezclen entre si.
- **Fondo degradado** en vez de negro puro: los huecos entre puntos dejan de
  leerse como agujeros.

## Lo que hace que vaya fluido

- **Todo el parseo va en un Web Worker** y los buffers se transfieren sin copia.
  La interfaz no se bloquea ni con ficheros de cientos de MB.
- **Los puntos se barajan al cargar** (Fisher-Yates in-place). Con el buffer
  barajado, dibujar los primeros N puntos es un submuestreo uniforme de toda la
  nube: el nivel de detalle sale gratis moviendo el `drawRange`, sin octrees.
  Sin barajar, dibujar el 30 % te dejaria un tercio del edificio y el resto
  vacio.
- **Calidad adaptativa.** Mientras arrastras el dedo baja la densidad (40 % por
  defecto) y la resolucion de render; al soltar vuelve la nube completa.
- **Los render targets se cachean por tamaño**, asi que ese cambio de resolucion
  no reasigna buffers de GPU en cada gesto.
- **Se redibuja solo cuando cambia algo.** Con la nube quieta el bucle no gasta
  GPU ni bateria.

## Precision: por que la nube no tiembla

Un LAS en UTM tiene coordenadas del orden de 500.000 m. El epsilon de un Float32
a esa magnitud es de unos **6 cm**: si subes esas coordenadas tal cual a la GPU,
la nube vibra visiblemente al orbitar y las superficies planas se rompen.

El visor resta el centro del bounding box antes de convertir a Float32, y guarda
el origen aparte (se muestra en la pestaña *Vista*). Dentro de un bloque de
tamaño normal el error baja al orden de las micras.

---

## Despliegue en GitHub Pages

Hay un workflow en `.github/workflows/desplegar.yml` que compila y publica en
cada push. Para que funcione, en **Settings -> Pages** el *Source* tiene que
estar en **"GitHub Actions"**.

Con la opcion *"Deploy from a branch"* la web sale en blanco: publica los
ficheros del repositorio sin compilar, y `index.html` apunta a `src/main.js`,
que importa `three` por su nombre de paquete. El navegador no sabe resolver eso
sin empaquetado.

El `base: './'` de `vite.config.js` esta puesto para que la app funcione servida
desde un subdirectorio, que es como publica Pages los sitios de proyecto
(`usuario.github.io/repositorio/`). El worker de carga y el `.wasm` de LAZ se
referencian con URL relativas por el mismo motivo.

## Desarrollo

```bash
npm install
npm run dev        # servidor de desarrollo, accesible desde la red local
npm run build      # genera dist/
npm run preview    # sirve dist/
```

### Nubes de prueba

Sin datos a mano, hay un generador que crea una escena sintetica (terreno,
edificio con ventanas y un arbol) con color, intensidad y clasificacion, en
coordenadas tipo UTM para ejercitar la resta de origen:

```bash
node tools/generar-nube-de-prueba.mjs prueba.las 400000
node tools/generar-nube-de-prueba.mjs prueba.ply 250000
node tools/generar-nube-de-prueba.mjs prueba.xyz 150000
```

### Estructura

```
src/
  io/          lectura de ficheros (todo dentro del worker)
    worker.js    despacho por contenido, no por extension
    reader.js    lectura por bloques de Blob, sin cargarlo entero
    sample.js    buffer de puntos, submuestreo en streaming y barajado
    las.js       LAS 1.0-1.4, formatos de punto 0-10
    laz.js       LAZ via laz-perf (WASM), carga diferida
    ply.js  pcd.js  xyz.js
    exportar.js  escritura de PLY binario y LAS 1.2
  viewer/
    Viewer.js    escena, camara, LOD, seleccion por profundidad
    shaders.js   puntos, Eye-Dome Lighting y empaquetado de profundidad
    colormaps.js rampas y paleta de clases ASPRS
  dibujo/
    Dibujo.js    gestos, herramientas, deshacer, persistencia
    plano.js     planos de trabajo y ajuste PCA a la nube
    trazos.js    polilineas en coordenadas del papel, simplificado y suavizado
  ui/
    app.js       estado, carga, panel
    controls.js  fabricas de controles tactiles
tools/
  generar-nube-de-prueba.mjs
```

---

## Limitaciones conocidas

- **Sin octree**: todo se carga en un solo buffer. Ver la nota del principio
  sobre nubes de mas de 30 M de puntos.
- **LAZ entero en memoria**: la API JS de `laz-perf` no expone la tabla de
  chunks, asi que no se puede descomprimir por bloques. Un `.laz` de mas de
  ~250 MB es arriesgado en un iPhone.
- **Sin medicion ni secciones**: no hay herramientas de distancia, perfil ni
  recorte. Es un visor con anotacion, no CloudCompare.
- **El dibujo no sale a DXF todavia**: se exporta como puntos coloreados dentro
  del PLY/LAS, que se ven pero no se acotan ni se editan en CAD.
- **Cada trazo vive en un plano**: no hay trazos que envuelvan una esquina. Para
  la fachada de al lado se fija un papel nuevo.
- **Sin E57.**
- El sistema de coordenadas del fichero (VLR de CRS) se ignora: la nube se
  dibuja en su propio sistema local.
- **El eje vertical de un PLY es una conjetura.** El formato no lo declara, asi
  que se deduce de la forma de la nube: si es una plancha (terreno, vuelo) la
  vertical es la dimension menor; en cualquier otro caso se asume Z. Con una
  fachada tan ancha como alta no hay señal que valga, por eso el visor avisa de
  que lo ha supuesto y deja cambiarlo en la pestaña *Vista*.
