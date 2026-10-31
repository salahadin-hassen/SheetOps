import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The console is static: it builds to plain files and talks to no server in
// this milestone. `base: './'` lets dist/ be opened from any path.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
