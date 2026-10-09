import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const output = resolve(root, process.argv[2] || `dist/PlaniFiKateur-apercu-v${version}.html`);
let html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const cssTag = html.match(/<link[^>]*href="([^"]+\.css)"[^>]*>/);
const jsTag = html.match(/<script[^>]*src="([^"]+\.js)"[^>]*><\/script>/);
if (!cssTag || !jsTag) throw new Error('Compilez l’application avant d’exporter l’aperçu.');

const css = readFileSync(resolve(dist, cssTag[1].replace(/^\//, '')), 'utf8').replace(
  /url\((\/assets\/[^)]+)\)/g,
  (_, asset) => {
    const mime = asset.endsWith('.woff2') ? 'font/woff2' : 'font/woff';
    return `url(data:${mime};base64,${readFileSync(resolve(dist, asset.slice(1))).toString('base64')})`;
  },
);
const js = readFileSync(resolve(dist, jsTag[1].replace(/^\//, '')), 'utf8');
html = html.replace(cssTag[0], () => `<style>${css}</style>`);
html = html.replace(jsTag[0], () => `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`);
writeFileSync(output, html);
console.log(`Aperçu autonome v${version} : ${output}`);
