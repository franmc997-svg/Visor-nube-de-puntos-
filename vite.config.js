import { defineConfig } from 'vite';

/**
 * laz-perf se publica como UMD y arrastra `require("fs")`/`require("path")` para
 * su rama de Node. En un bundle de navegador eso rompe la resolucion, asi que
 * neutralizamos esas ramas (nunca se ejecutan: ENVIRONMENT_IS_NODE es false) y
 * le añadimos un export por defecto para poder importarlo desde un worker ESM.
 */
function lazPerfComoEsm() {
  return {
    name: 'laz-perf-esm',
    enforce: 'pre',
    transform(code, id) {
      // En dev, Vite añade sufijos de cache (?v=...) al id: hay que comparar
      // solo la ruta.
      const ruta = id.split('?')[0];
      if (!ruta.includes('laz-perf') || !ruta.endsWith('laz-perf.js')) return null;
      const out = code
        .replace(/require\("fs"\)/g, '(null)')
        .replace(/require\("path"\)/g, '(null)')
        .replace(/require\('fs'\)/g, '(null)')
        .replace(/require\('path'\)/g, '(null)');
      return { code: `${out}\nexport default createLazPerf;\n`, map: null };
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [lazPerfComoEsm()],
  // Sin esto, el pre-bundler de dev se come el modulo antes de que el plugin
  // pueda transformarlo.
  optimizeDeps: { exclude: ['laz-perf'] },
  worker: { format: 'es', plugins: () => [lazPerfComoEsm()] },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,   // el .wasm debe quedarse como fichero aparte
    chunkSizeWarningLimit: 2000,
  },
  server: { host: true },
});
