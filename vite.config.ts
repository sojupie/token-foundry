import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { workspaceDev } from './scripts/workspace-dev.ts';

const md3Sample = process.env['MD3_TOKEN_BENCHMARK'];
const cacheDir = process.env['FOUNDRY_VITE_CACHE_DIR'];
const browserTests = process.env['FOUNDRY_BROWSER_TEST'] === '1';

export default defineConfig({
  ...(cacheDir ? { cacheDir } : {}),
  define: { 'import.meta.env.VITE_MD3_SAMPLE': JSON.stringify(md3Sample ? '1' : '0') },
  optimizeDeps: { include: ['colorjs.io/fn'] },
  // Open editors must remain usable after a deployment replaces its asset manifest.
  build: { rolldownOptions: { output: { codeSplitting: false } } },
  // Let the scoped Figma relay answer opaque-origin preflights. Vite 8 installs CORS before plugin middleware.
  server: { cors: { preflightContinue: true }, ...(browserTests ? { hmr: false } : {}) },
  resolve: { alias: { '@': fileURLToPath(new URL('./editor', import.meta.url)) } },
  plugins: [react(), tailwindcss(), workspaceDev(), {
    name: 'local-md3-sample',
    apply: 'serve',
    configureServer(server) {
      if (!md3Sample) return;
      server.middlewares.use('/__md3-sample.json', (_request, response) => {
        void readFile(md3Sample).then((sample) => {
          response.setHeader('Content-Type', 'application/json');
          return response.end(sample);
        }, () => {
          response.statusCode = 404;
          return response.end();
        });
      });
    },
  }],
});
