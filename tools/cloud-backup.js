'use strict';
/**
 * CLI : sauvegarde Cloudflare ponctuelle (D1 + R2).
 * Usage:
 *   node tools/cloud-backup.js
 *   node tools/cloud-backup.js /chemin/vers/userData
 *
 * Lit <userData>/cloud-backup.json (voir electron/cloudBackup.cjs).
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

async function main() {
  const userData = process.argv[2] || path.join(os.homedir(), '.config', 'SahaMed');
  const cfgPath = path.join(userData, 'cloud-backup.json');
  if (!fs.existsSync(cfgPath)) {
    console.error(`Config absente : ${cfgPath}`);
    console.error('Créez ce fichier (modèle dans README.md § Sauvegarde Cloudflare).');
    process.exit(2);
  }

  const { initDatabase } = require('../electron/database.cjs');
  const cloudBackup = require('../electron/cloudBackup.cjs');

  const db = await initDatabase(userData);
  const result = await cloudBackup.runBackup(db, userData);
  if (result.ok) {
    console.log('Backup OK', result);
    process.exit(0);
  }
  console.error('Backup ÉCHEC', result);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
