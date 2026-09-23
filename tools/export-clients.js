#!/usr/bin/env node
/**
 * Export Clinixos patients (client list) + optional full dump to CSV/JSON.
 * Usage:
 *   node tools/export-clients.js /path/to/sahamed.db
 *   node tools/export-clients.js /path/to/sahamed.db /path/outdir
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function rowsToCsv(columns, values) {
  const lines = [columns.join(',')];
  for (const row of values) lines.push(row.map(csvEscape).join(','));
  return lines.join('\n');
}

async function main() {
  const dbPath = process.argv[2];
  const outDir = process.argv[3] || path.join(path.dirname(dbPath || '.'), 'sahamed-export');
  if (!dbPath || !fs.existsSync(dbPath)) {
    console.error('Usage: node tools/export-clients.js /path/to/sahamed.db [outDir]');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
  const SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) });
  const db = new SQL.Database(fs.readFileSync(dbPath));

  // Client list (patients)
  const patients = db.exec('SELECT * FROM patients ORDER BY nom, prenom');
  if (patients.length) {
    const csv = rowsToCsv(patients[0].columns, patients[0].values);
    fs.writeFileSync(path.join(outDir, 'clients_patients.csv'), csv);
    console.log(`clients_patients.csv ← ${patients[0].values.length} patients`);
    // pretty JSON
    const json = patients[0].values.map((row) =>
      Object.fromEntries(patients[0].columns.map((c, i) => [c, row[i]]))
    );
    fs.writeFileSync(path.join(outDir, 'clients_patients.json'), JSON.stringify(json, null, 2));
  } else {
    fs.writeFileSync(path.join(outDir, 'clients_patients.csv'), 'id,nom,prenom\n');
    console.log('No patients in this DB');
  }

  // Users
  const users = db.exec('SELECT id, nom, prenom, role, login, actif, specialite, telephone, created_at FROM users');
  if (users.length) {
    fs.writeFileSync(path.join(outDir, 'users.csv'), rowsToCsv(users[0].columns, users[0].values));
    console.log(`users.csv ← ${users[0].values.length} users`);
  }

  // Table summary
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const summary = [];
  if (tables.length) {
    for (const [name] of tables[0].values) {
      try {
        const c = db.exec(`SELECT COUNT(*) FROM "${name}"`);
        const n = c[0]?.values?.[0]?.[0] ?? 0;
        summary.push({ table: name, rows: n });
        if (n > 0 && ['consultations', 'rdv', 'paiements', 'ordonnances', 'depenses', 'messages_chat', 'actes', 'parametres', 'medicaments'].includes(name)) {
          const r = db.exec(`SELECT * FROM "${name}"`);
          fs.writeFileSync(path.join(outDir, `${name}.csv`), rowsToCsv(r[0].columns, r[0].values));
        }
      } catch (e) {
        summary.push({ table: name, error: e.message });
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('Tables:', summary.map((s) => `${s.table}=${s.rows ?? s.error}`).join(', '));
  console.log('Export dir:', outDir);
}

main().catch((e) => { console.error(e); process.exit(1); });
