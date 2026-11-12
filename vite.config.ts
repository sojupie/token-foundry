import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const md3Sample = process.env['MD3_TOKEN_BENCHMARK'];

export default defineConfig({
  define: { 'import.meta.env.VITE_MD3_SAMPLE': JSON.stringify(md3Sample ? '1' : '0') },
  resolve: { alias: { '@': fileURLToPath(new URL('./editor', import.meta.url)) } },
  plugins: [react(), tailwindcss(), {
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
