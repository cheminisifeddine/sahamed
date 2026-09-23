#!/usr/bin/env node
/**
 * Reset Clinixos admin password (and optionally all users).
 * Usage:
 *   node tools/reset-admin.js /path/to/sahamed.db
 *   node tools/reset-admin.js /path/to/sahamed.db NewPass123
 * Default new password: admin
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');

async function main() {
  const dbPath = process.argv[2];
  const newPass = process.argv[3] || 'admin';
  if (!dbPath) {
    console.error('Usage: node tools/reset-admin.js /path/to/sahamed.db [newPassword]');
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error('DB not found:', dbPath);
    process.exit(1);
  }
  const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
  const SQL = await initSqlJs({ locateFile: (f) => path.join(wasmDir, f) });
  const db = new SQL.Database(fs.readFileSync(dbPath));

  const users = db.exec('SELECT id, nom, prenom, login, role, actif FROM users');
  console.log('Existing users:');
  if (users.length) {
    const cols = users[0].columns;
    for (const row of users[0].values) {
      console.log(' ', Object.fromEntries(cols.map((c, i) => [c, row[i]])));
    }
  } else {
    console.log('  (none)');
  }

  const hash = bcrypt.hashSync(newPass, 10);
  const existing = db.exec("SELECT id FROM users WHERE login = 'admin'");
  if (existing.length) {
    db.run("UPDATE users SET password_hash = ?, actif = 1 WHERE login = 'admin'", [hash]);
    console.log("Reset password for user 'admin' →", newPass);
  } else {
    db.run(
      `INSERT INTO users (nom, prenom, role, login, password_hash, actif, specialite, telephone)
       VALUES ('Administrateur', '', 'medecin', 'admin', ?, 1, 'Médecin Générale', '')`,
      [hash]
    );
    console.log("Created user 'admin' →", newPass);
  }

  // Also clear any lockout-ish settings if present
  try {
    db.run("UPDATE parametres SET valeur = '60' WHERE cle = 'verrouillage_minutes'");
  } catch {}

  const out = Buffer.from(db.export());
  fs.writeFileSync(dbPath, out);
  console.log('Saved:', dbPath, `(${out.length} bytes)`);

  const counts = db.exec(`SELECT
    (SELECT COUNT(*) FROM patients) AS patients,
    (SELECT COUNT(*) FROM consultations) AS consultations,
    (SELECT COUNT(*) FROM rdv) AS rdv,
    (SELECT COUNT(*) FROM paiements) AS paiements,
    (SELECT COUNT(*) FROM users) AS users`);
  if (counts.length) {
    const cols = counts[0].columns;
    console.log('Row counts:', Object.fromEntries(cols.map((c, i) => [c, counts[0].values[0][i]])));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
