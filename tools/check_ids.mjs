import fs from 'node:fs';
import path from 'node:path';

const pairs = [
  ['popup/popup.js', 'popup/popup.html'],
  ['options/options.js', 'options/options.html'],
];

let bad = 0;
for (const [js, html] of pairs) {
  const code = fs.readFileSync(js, 'utf8');
  const markup = fs.readFileSync(html, 'utf8');
  const ids = new Set();
  for (const m of code.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)['"]\)/g)) ids.add(m[1]);
  for (const m of code.matchAll(/getElementById\(['"]([A-Za-z0-9_-]+)['"]\)/g)) ids.add(m[1]);
  for (const id of ids) {
    if (!new RegExp(`id=["']${id}["']`).test(markup)) {
      console.log(`MISSING ${html}: #${id} (used by ${js})`);
      bad++;
    }
  }
  if (!bad) console.log(`ok ${js} -> ${html} (${ids.size} ids)`);
}
process.exit(bad ? 1 : 0);
