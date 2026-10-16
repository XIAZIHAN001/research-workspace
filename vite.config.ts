import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * pdf.js optional data files: the standard font programmes and the CMap tables.
 *
 * They live in the installed package and are only fetched for PDFs that use a non-embedded
 * standard font or a CJK encoding. Copying them into the repository would duplicate ~2 MB of
 * binaries and go stale on the next upgrade, so they are read from `node_modules` — served
 * from there in dev, emitted into the build output for production. Nothing is fetched from a
 * CDN at any point.
 */
const PDFJS_DATA_DIRS = ['standard_fonts', 'cmaps'];
const PDFJS_OUT = 'pdfjs';

function pdfjsDataFiles(): Plugin {
  const packageRoot = join(process.cwd(), 'node_modules', 'pdfjs-dist');
  const readDir = (name: string): { file: string; source: Buffer }[] => {
    try {
      return readdirSync(join(packageRoot, name))
        .filter((file) => statSync(join(packageRoot, name, file)).isFile())
        .map((file) => ({ file, source: readFileSync(join(packageRoot, name, file)) }));
    } catch {
      return [];
    }
  };

  return {
    name: 'pdfjs-data-files',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = /^\/pdfjs\/([a-z_]+)\/([\w.-]+)$/.exec(request.url ?? '');
        if (match === null || !PDFJS_DATA_DIRS.includes(match[1] ?? '')) {
          next();
          return;
        }
        try {
          const source = readFileSync(join(packageRoot, match[1] ?? '', match[2] ?? ''));
          response.setHeader('Content-Type', 'application/octet-stream');
          response.end(source);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const dir of PDFJS_DATA_DIRS) {
        for (const { file, source } of readDir(dir)) {
          this.emitFile({ type: 'asset', fileName: `${PDFJS_OUT}/${dir}/${file}`, source });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsDataFiles()],
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
