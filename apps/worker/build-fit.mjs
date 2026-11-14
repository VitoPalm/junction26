import { build } from 'esbuild';
await build({
  entryPoints: ['browser/check.tsx'],
  outdir: 'fit',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  conditions: ['junction26-source'],
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://fit.invalid/check.js"' },
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
});
