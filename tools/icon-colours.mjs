import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
const map = JSON.parse(await fs.readFile('src/app-icons.json', 'utf8'));
let css =
  '\n/* Extend installed icon backgrounds across their cards. */\n.app-face:has(.brand-installed)::after { background: none; }\n.brand-installed-icon { border-radius: 0; }\n';
for (const [id, relative] of Object.entries(map)) {
  const { data, info } = await sharp(path.join('public', relative))
    .resize(48, 48, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bins = new Map();
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 48; x++) {
      if (x > 5 && x < 42 && y > 5 && y < 42) continue;
      const i = (y * 48 + x) * info.channels;
      if (data[i + 3] < 230) continue;
      const rgb = [data[i], data[i + 1], data[i + 2]],
        key = rgb.map((v) => v >> 4).join(',');
      const bin = bins.get(key) || { n: 0, sum: [0, 0, 0] };
      bin.n++;
      rgb.forEach((v, j) => (bin.sum[j] += v));
      bins.set(key, bin);
    }
  const best = [...bins.values()].sort((a, b) => b.n - a.n)[0];
  const rgb = best ? best.sum.map((v) => Math.round(v / best.n)) : [20, 20, 20];
  css += `.app-tile[data-app-id=${JSON.stringify(id)}] .app-face:has(.brand-installed) { background: rgb(${rgb.join(',')}); }\n`;
}
await fs.writeFile('src/icon-colours.css', css);
console.log('Matched backgrounds for', Object.keys(map).length, 'apps');
