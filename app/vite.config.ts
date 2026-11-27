import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function dataVersion(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = statSync(p); h.update(`${p.slice(dir.length)}:${s.size}:${Math.round(s.mtimeMs)}\n`); }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 12);
}

export default defineConfig({
  base: './',
  define: { __DATA_VERSION__: JSON.stringify(dataVersion(fileURLToPath(new URL('./public', import.meta.url)))) },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/app[extname]',
      },
    },
  },
  server: { port: 5181, strictPort: true },
});
