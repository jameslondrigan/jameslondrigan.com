import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import react from '@astrojs/react';

// Stamp the Track Record service worker with a build-hashed precache list of
// the game route's shell (HTML + content-hashed /_astro assets) and song JSON.
function trackRecordSW() {
  return {
    name: 'tr-sw',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        try {
          const distPath = fileURLToPath(dir);
          const html = await readFile(join(distPath, 'trackrecord', 'index.html'), 'utf8');
          // /_astro URLs appear inside inline hydration scripts, not just attributes.
          const assets = [...html.matchAll(/\/_astro\/[A-Za-z0-9._-]+\.(?:js|css)/g)].map((m) => m[0]);
          const precache = Array.from(new Set(['/trackrecord', '/data/tr-songs.json', ...assets]));
          const version = createHash('sha1').update(precache.join('|')).digest('hex').slice(0, 12);
          const templatePath = fileURLToPath(new URL('./scripts/tr-sw.template.js', import.meta.url));
          const template = await readFile(templatePath, 'utf8');
          const sw = template.replaceAll('__VERSION__', version).replaceAll('__PRECACHE__', JSON.stringify(precache));
          await writeFile(join(distPath, 'tr-sw.js'), sw);
          logger.info(`stamped tr-sw.js version ${version} with ${precache.length} precache entries`);
        } catch (err) {
          logger.warn('tr-sw stamping skipped: ' + (err && err.message));
        }
      },
    },
  };
}

export default defineConfig({
  integrations: [mdx(), react(), trackRecordSW()],
  vite: {
    plugins: [tailwindcss()],
  },
});