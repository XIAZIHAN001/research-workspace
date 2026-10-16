import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Tauri expects a fixed dev port. strictPort makes a clash fail loudly instead of
// silently moving to another port that tauri.conf.json does not know about.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Declared up front so the first `vite` run bundles React and its consumers together.
  // Without it, lucide-react is discovered late and one page load can mix two React copies.
  optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/.cache/**'] },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
