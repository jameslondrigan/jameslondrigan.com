// Generate Track Record PWA icons from an inline SVG (maroon vinyl record,
// amber center label, espresso field). Run: node scripts/gen-tr-icons.mjs
// Requires: npm i -D sharp
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// scale = fraction of the canvas the record fills. Use a small scale for the
// maskable variant so the record stays inside the circular safe zone.
function svg(size, scale) {
  const c = size / 2;
  const R = (size * scale) / 2;
  const label = R * 0.34;
  const hole = R * 0.05;
  let grooves = '';
  for (let i = 0; i < 7; i++) {
    const rr = label + ((R - label) * (i + 1)) / 8;
    grooves += `<circle cx="${c}" cy="${c}" r="${rr}" fill="none" stroke="#3a0000" stroke-width="${size * 0.004}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#160f08"/>
  <circle cx="${c}" cy="${c}" r="${R}" fill="#500000"/>
  <circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="#6a0000" stroke-width="${size * 0.006}"/>
  ${grooves}
  <circle cx="${c}" cy="${c}" r="${label}" fill="#F2A93B"/>
  <circle cx="${c}" cy="${c}" r="${label}" fill="none" stroke="#FFC768" stroke-width="${size * 0.004}"/>
  <circle cx="${c}" cy="${c}" r="${hole}" fill="#160f08"/>
</svg>`;
}

const targets = [
  { name: 'tr-192.png', size: 192, scale: 0.9 },
  { name: 'tr-512.png', size: 512, scale: 0.9 },
  { name: 'tr-maskable-512.png', size: 512, scale: 0.62 },
  { name: 'tr-apple-touch.png', size: 180, scale: 0.9 },
];

await mkdir(OUT, { recursive: true });
for (const t of targets) {
  await sharp(Buffer.from(svg(t.size, t.scale))).png().toFile(join(OUT, t.name));
  console.log('wrote', t.name, `(${t.size}x${t.size})`);
}
console.log('done ->', OUT);
