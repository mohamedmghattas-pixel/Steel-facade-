// Inline the offline build's script and stylesheet into one HTML file.
import { readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'dist-offline';
let html = readFileSync(join(dir, 'index.html'), 'utf8');
const read = (rel) => readFileSync(join(dir, rel.replace(/^\.\//, '')), 'utf8');

// Stylesheets → <style>.
html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => `<style>\n${read(href)}\n</style>`);
// Module scripts → inline module script. Escape "</script" inside the code.
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, src) => {
  const code = read(src).replace(/<\/script/gi, '<\\/script');
  return `<script type="module">\n${code}\n</script>`;
});
// Favicon → data URL.
html = html.replace(/<link rel="icon"[^>]*href="\.\/favicon\.svg"[^>]*>/, () => {
  const svg = readFileSync(join(dir, 'favicon.svg'));
  return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${svg.toString('base64')}">`;
});
if (/src="\.\/assets\//.test(html) || /href="\.\/assets\//.test(html)) throw new Error('An asset reference was not inlined');

const out = join(dir, 'FacadeSteel.html');
writeFileSync(out, html);
for (const f of readdirSync(dir)) if (f !== 'FacadeSteel.html') rmSync(join(dir, f), { recursive: true, force: true });
console.log(`${out}: ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
