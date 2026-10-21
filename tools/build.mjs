import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'dist', 'app');
// This is generated output. Start clean so removed assets and Finder metadata
// cannot accidentally travel into the TV package.
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.cp(path.join(root, 'public'), output, {
  recursive: true,
  filter: (source) => path.basename(source) !== '.DS_Store',
});
// Classic IIFE + relative local assets: no module fetches or file:// CORS issues.
await build({
  entryPoints: [path.join(root, 'src/main.tsx')],
  bundle: true,
  minify: true,
  outfile: path.join(output, 'app.js'),
  format: 'iife',
  target: ['chrome108'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.svg': 'dataurl', '.woff2': 'file' },
  external: ['/fonts/*'],
  legalComments: 'eof',
});
const cssPath = path.join(output, 'app.css');
let css = await fs.readFile(cssPath, 'utf8');
css = css.replaceAll('url(/fonts/', 'url(./fonts/').replaceAll('url("/fonts/', 'url("./fonts/');
await fs.writeFile(cssPath, css);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'appinfo.json'), 'utf8'));
await fs.writeFile(path.join(output, 'appinfo.json'), JSON.stringify(manifest, null, 2) + '\n');
await fs.copyFile(path.join(root, 'license'), path.join(output, 'license'));
await fs.copyFile(path.join(root, 'assets.md'), path.join(output, 'assets.md'));
await fs.copyFile(path.join(root, 'tv', 'autostart.sh'), path.join(output, 'autostart.sh'));
await fs.chmod(path.join(output, 'autostart.sh'), 0o755);
for (const [name, size] of [
  [manifest.icon, 80],
  [manifest.largeIcon, 130],
]) {
  // Let webOS supply the tile background/mask. A second painted panel gets its
  // own image clipping radius and looks like a rounded tile inside another tile.
  await sharp(path.join(root, 'public/app-icon.svg'))
    .resize(size, size)
    .png()
    .toFile(path.join(output, name));
}
await fs.writeFile(
  path.join(output, 'index.html'),
  `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#17191c"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src https://api.open-meteo.com https://geocoding-api.open-meteo.com http: https: ws: wss:; object-src 'none'; base-uri 'none'"><title>Luma</title><link rel="icon" href="./${manifest.icon}"><link rel="stylesheet" href="./app.css"></head><body><div id="root"></div><script defer src="./app.js"></script></body></html>\n`,
);
const files = await fs.readdir(output);
const js = await fs.stat(path.join(output, 'app.js'));
console.log(
  `Built Luma ${manifest.version}: dist/app (${Math.round(js.size / 1024)} KB JavaScript, ${files.length} top-level files)`,
);
