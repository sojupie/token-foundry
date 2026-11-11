import { defineConfig } from '@playwright/test';

const origin = 'http://127.0.0.1:4319';

export default defineConfig({
  testDir: './tests/browser',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
  use: { baseURL: origin },
  webServer: {
    command: 'npm run dev -- --mode hosted --host 127.0.0.1 --port 4319 --strictPort',
    url: origin,
  },
});
