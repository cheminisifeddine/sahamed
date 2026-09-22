#!/usr/bin/env node
/**
 * Search common locations for sahamed.db
 * Usage: node tools/find-db.js [rootDir...]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const roots = process.argv.slice(2);
if (!roots.length) {
  const home = require('os').homedir();
  roots.push(
    home,
    path.join(home, 'AppData', 'Roaming'),
    path.join(home, '.config'),
    path.join(home, '.local', 'share'),
    'C:\\Users',
    '/mnt/c/Users',
    '/media',
    '/mnt'
  );
}

const hits = [];
function walk(dir, depth) {
  if (depth > 6 || hits.length > 50) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, depth + 1);
    } else if (/^sahamed\.db/i.test(e.name) || e.name === 'activation.dat' || e.name === 'network-mode.json') {
      try {
        const st = fs.statSync(p);
        hits.push({ path: p, size: st.size, mtime: st.mtime.toISOString() });
      } catch {}
    }
  }
}
for (const r of roots) walk(r, 0);
console.log(JSON.stringify(hits, null, 2));
if (!hits.length) console.error('No sahamed.db found under:', roots.join(', '));
