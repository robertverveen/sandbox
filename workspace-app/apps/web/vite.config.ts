import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const apiPort = Number(process.env.HZ_API_PORT ?? 8700);
const webPort = Number(process.env.HZ_WEB_PORT ?? 5700);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  preview: {
    port: webPort,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
  },
});
