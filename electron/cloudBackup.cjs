'use strict';
/**
 * SahaMed — sauvegarde automatique Cloudflare (D1 + R2).
 * 100% optionnelle : si la config n'existe pas, l'app reste 100% hors-ligne.
 *
 * Config : <userData>/cloud-backup.json
 * {
 *   "enabled": true,
 *   "intervalMinutes": 60,
 *   "accountId": "...",
 *   "apiToken": "...",          // Cloudflare API Token (D1 edit + R2 edit)
 *   "d1DatabaseId": "...",
 *   "r2Bucket": "sahamed-backups",
 *   "r2Endpoint": "https://<accountId>.r2.cloudflarestorage.com",
 *   "r2AccessKeyId": "...",
 *   "r2SecretAccessKey": "..."
 * }
 *
 * - D1  : journal de sauvegarde + export JSON des tables critiques (requêtes SQL).
 * - R2  : copie binaire complète du fichier .db (restore one-shot).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_NAME = 'cloud-backup.json';

function loadConfig(userDataPath) {
  try {
    const p = path.join(userDataPath, CONFIG_NAME);
    if (!fs.existsSync(p)) return null;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!cfg || cfg.enabled === false) return null;
    if (!cfg.accountId || !cfg.apiToken) return null;
    return cfg;
  } catch {
    return null;
  }
}

function saveConfig(userDataPath, cfg) {
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(path.join(userDataPath, CONFIG_NAME), JSON.stringify(cfg, null, 2), 'utf8');
}

/* ─── Cloudflare REST (D1) ─────────────────────────────────────── */
async function d1Request(cfg, method, pathname, body) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}${pathname}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const msg = (data.errors && data.errors[0] && data.errors[0].message) || res.statusText || 'D1 error';
    throw new Error(`D1: ${msg}`);
  }
  return data;
}

async function d1Query(cfg, sql, params = []) {
  return d1Request(cfg, 'POST', `/d1/database/${cfg.d1DatabaseId}/query`, { sql, params });
}

/* ─── R2 S3-compatible PUT (upload binaire .db) ────────────────── */
function rfc3339(d = new Date()) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function r2PutObject(cfg, key, bodyBuf) {
  const endpoint = new URL(cfg.r2Endpoint || `https://${cfg.accountId}.r2.cloudflarestorage.com`);
  const host = endpoint.host;
  const region = 'auto';
  const service = 's3';
  const amzDate = rfc3339();
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(bodyBuf);
  const canonicalUri = `/${encodeURIComponent(cfg.r2Bucket).replace(/%2F/g, '/')}/${key.split('/').map(encodeURIComponent).join('/')}`;

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${cfg.r2SecretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${cfg.r2AccessKeyId}/${scope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  const url = `${endpoint.protocol}//${host}${canonicalUri}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...headers,
      Authorization: authorization,
    },
    body: bodyBuf,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`R2 PUT ${res.status}: ${text.slice(0, 300)}`);
  }
  return true;
}

/* ─── Export SQL → structures JSON pour D1 ─────────────────────── */
function listTables(store) {
  const rows = store.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return rows.map((r) => r.name);
}

function tableRows(store, table) {
  // table names come only from sqlite_master — no user input
  return store.all(`SELECT * FROM "${table.replace(/"/g, '""')}"`);
}

async function ensureD1Schema(cfg) {
  await d1Query(cfg, `
    CREATE TABLE IF NOT EXISTS backup_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      message TEXT,
      db_size INTEGER,
      r2_key TEXT
    );
  `);
  await d1Query(cfg, `
    CREATE TABLE IF NOT EXISTS backup_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,
      table_name TEXT NOT NULL,
      row_count INTEGER,
      payload_json TEXT,
      FOREIGN KEY (run_id) REFERENCES backup_runs(id)
    );
  `);
}

const CRITICAL_TABLES = [
  'users', 'patients', 'rdv', 'consultations', 'ordonnances',
  'paiements', 'parametres', 'actes', 'motifs', 'medicaments',
];

/**
 * Exécute une sauvegarde complète. Ne lance jamais d'exception non gérée
 * (appelé depuis un intervalle — on log et on continue).
 * @returns {{ok:boolean, error?:string, r2Key?:string, runId?:number}}
 */
async function runBackup(db, userDataPath) {
  const cfg = loadConfig(userDataPath);
  if (!cfg) return { ok: false, error: 'config absente ou désactivée' };

  const dbPath = db.dbPath;
  const started = new Date().toISOString();
  let runId = null;
  try {
    await ensureD1Schema(cfg);
    const ins = await d1Query(
      cfg,
      'INSERT INTO backup_runs (started_at, status) VALUES (?, ?) RETURNING id',
      [started, 'running']
    );
    runId = ins.results && ins.results[0] && ins.results[0].id;

    const dbBuf = fs.readFileSync(dbPath);
    const stamp = started.replace(/[:.]/g, '-');
    const r2Key = `sahamed/${stamp}/sahamed.db`;
    await r2PutObject(cfg, r2Key, dbBuf);

    const tables = listTables(db).filter((t) => CRITICAL_TABLES.includes(t) || t === 'backup_runs');
    for (const t of tables) {
      if (t.startsWith('backup_')) continue;
      const rows = tableRows(db, t);
      const payload = JSON.stringify(rows);
      // D1 string limit ~1MB per value; skip huge payloads with a marker
      const safe = payload.length > 900_000
        ? JSON.stringify({ truncated: true, rowCount: rows.length, note: 'voir R2 pour le binaire complet' })
        : payload;
      await d1Query(
        cfg,
        'INSERT INTO backup_tables (run_id, table_name, row_count, payload_json) VALUES (?, ?, ?, ?)',
        [runId, t, rows.length, safe]
      );
    }

    const finished = new Date().toISOString();
    await d1Query(
      cfg,
      'UPDATE backup_runs SET finished_at=?, status=?, message=?, db_size=?, r2_key=? WHERE id=?',
      [finished, 'ok', 'D1+R2', dbBuf.length, r2Key, runId]
    );
    return { ok: true, r2Key, runId };
  } catch (error) {
    try {
      const finished = new Date().toISOString();
      await d1Query(
        cfg,
        'UPDATE backup_runs SET finished_at=?, status=?, message=? WHERE id=?',
        [finished, 'error', String(error.message || error).slice(0, 500), runId]
      );
    } catch {}
    return { ok: false, error: String(error.message || error) };
  }
}

/** Démarre la boucle automatique. Retourne un handle { stop, trigger }. */
function startAutoBackup(db, userDataPath) {
  const cfg = loadConfig(userDataPath);
  if (!cfg) {
    console.log('[SahaMed] Sauvegarde Cloudflare inactive (pas de cloud-backup.json).');
    return { stop() {}, trigger: async () => ({ ok: false, error: 'non configurée' }) };
  }
  const minutes = Math.max(5, Number(cfg.intervalMinutes) || 60);
  let running = false;

  const trigger = async () => {
    if (running) return { ok: false, error: 'sauvegarde déjà en cours' };
    running = true;
    try {
      const result = await runBackup(db, userDataPath);
      console.log('[SahaMed] Backup Cloudflare →', result.ok ? `OK ${result.r2Key}` : `ÉCHEC ${result.error}`);
      return result;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { trigger().catch(() => {}); }, minutes * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();

  // Première sauvegarde un peu après le démarrage (laisse le DB se stabiliser)
  const kickoff = setTimeout(() => { trigger().catch(() => {}); }, 15_000);
  if (typeof kickoff.unref === 'function') kickoff.unref();

  console.log(`[SahaMed] Sauvegarde Cloudflare auto toutes les ${minutes} min.`);
  return {
    stop() { clearInterval(timer); clearTimeout(kickoff); },
    trigger,
  };
}

module.exports = { loadConfig, saveConfig, runBackup, startAutoBackup, CONFIG_NAME };
