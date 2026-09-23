'use strict';
/**
 * Clinixos — sauvegarde automatique Cloudflare (D1 + R2).
 * 100% optionnelle : sans config, l'app reste 100% hors-ligne.
 *
 * Config : <userData>/cloud-backup.json
 * {
 *   "enabled": true,
 *   "intervalMinutes": 60,
 *   "accountId": "...",
 *   "apiToken": "...",          // Cloudflare API Token (D1 edit + R2 edit)
 *   "d1DatabaseId": "...",      // optionnel — omis ⇒ R2 seul
 *   "r2Bucket": "sahamed-backups"
 * }
 *
 * - R2 : PUT via l'API Cloudflare (pas de clés S3).
 * - D1 : journal backup_runs + export JSON des tables critiques.
 */
const fs = require('node:fs');
const path = require('node:path');

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

async function cfFetch(cfg, method, pathname, body, rawBody, contentType) {
  const url = `https://api.cloudflare.com/client/v4${pathname}`;
  const headers = {
    Authorization: `Bearer ${cfg.apiToken}`,
  };
  let payload;
  if (rawBody !== undefined) {
    headers['Content-Type'] = contentType || 'application/octet-stream';
    payload = rawBody;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const msg = (data.errors && data.errors[0] && data.errors[0].message) || res.statusText || 'Cloudflare error';
    throw new Error(`CF ${method} ${pathname}: ${msg}`);
  }
  return data;
}

async function d1Query(cfg, sql, params = []) {
  if (!cfg.d1DatabaseId) throw new Error('d1DatabaseId manquant');
  return cfFetch(cfg, 'POST', `/accounts/${cfg.accountId}/d1/database/${cfg.d1DatabaseId}/query`, {
    sql,
    params,
  });
}

/** Upload binaire vers R2 via l'API Cloudflare (clé objet URL-encoded par segment). */
async function r2PutObject(cfg, key, bodyBuf) {
  const bucket = cfg.r2Bucket || 'sahamed-backups';
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  await cfFetch(
    cfg,
    'PUT',
    `/accounts/${cfg.accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodedKey}`,
    undefined,
    bodyBuf,
    'application/octet-stream'
  );
  return true;
}

function listTables(store) {
  const rows = store.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return rows.map((r) => r.name);
}

function tableRows(store, table) {
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
      payload_json TEXT
    );
  `);
}

const CRITICAL_TABLES = [
  'users', 'patients', 'rdv', 'consultations', 'ordonnances',
  'paiements', 'parametres', 'actes', 'motifs', 'medicaments',
];

/**
 * Sauvegarde complète. Jamais d'exception non gérée.
 * @returns {{ok:boolean, error?:string, r2Key?:string, runId?:number, d1?:boolean, r2?:boolean}}
 */
async function runBackup(db, userDataPath) {
  const cfg = loadConfig(userDataPath);
  if (!cfg) return { ok: false, error: 'config absente ou désactivée' };

  const dbPath = db.dbPath;
  const started = new Date().toISOString();
  let runId = null;
  let r2Ok = false;
  let d1Ok = false;
  let r2Key = null;
  const notes = [];

  try {
    // ── R2 (toujours tenté) ─────────────────────────────────────
    const dbBuf = fs.readFileSync(dbPath);
    const stamp = started.replace(/[:.]/g, '-');
    r2Key = `sahamed/${stamp}/sahamed.db`;
    await r2PutObject(cfg, r2Key, dbBuf);
    r2Ok = true;

    // ── D1 (optionnel) ──────────────────────────────────────────
    if (cfg.d1DatabaseId) {
      try {
        await ensureD1Schema(cfg);
        const ins = await d1Query(
          cfg,
          'INSERT INTO backup_runs (started_at, status) VALUES (?, ?) RETURNING id',
          [started, 'running']
        );
        runId = ins.results && ins.results[0] && ins.results[0].id;

        const tables = listTables(db).filter((t) => CRITICAL_TABLES.includes(t));
        for (const t of tables) {
          const rows = tableRows(db, t);
          const payload = JSON.stringify(rows);
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
          [finished, r2Ok ? 'ok' : 'partial', 'R2+D1', dbBuf.length, r2Key, runId]
        );
        d1Ok = true;
      } catch (e) {
        notes.push(`D1: ${e.message}`);
        if (runId) {
          try {
            await d1Query(
              cfg,
              'UPDATE backup_runs SET finished_at=?, status=?, message=? WHERE id=?',
              [new Date().toISOString(), 'error', String(e.message).slice(0, 500), runId]
            );
          } catch {}
        }
      }
    } else {
      notes.push('D1 non configuré (d1DatabaseId absent) — R2 seul');
    }

    if (!r2Ok && !d1Ok) {
      return { ok: false, error: notes.join('; ') || 'aucune destination' };
    }
    return { ok: true, r2Key, runId, r2: r2Ok, d1: d1Ok, notes };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

/** Démarre la boucle automatique. Retourne { stop, trigger }. */
function startAutoBackup(db, userDataPath) {
  const cfg = loadConfig(userDataPath);
  if (!cfg) {
    console.log('[Clinixos] Sauvegarde Cloudflare inactive (pas de cloud-backup.json).');
    return { stop() {}, trigger: async () => ({ ok: false, error: 'non configurée' }) };
  }
  const minutes = Math.max(5, Number(cfg.intervalMinutes) || 60);
  let running = false;

  const trigger = async () => {
    if (running) return { ok: false, error: 'sauvegarde déjà en cours' };
    running = true;
    try {
      const result = await runBackup(db, userDataPath);
      console.log(
        '[Clinixos] Backup Cloudflare →',
        result.ok
          ? `OK R2=${result.r2 ? 'oui' : 'non'} D1=${result.d1 ? 'oui' : 'non'} ${result.r2Key || ''}`
          : `ÉCHEC ${result.error}`
      );
      return result;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { trigger().catch(() => {}); }, minutes * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();

  const kickoff = setTimeout(() => { trigger().catch(() => {}); }, 15_000);
  if (typeof kickoff.unref === 'function') kickoff.unref();

  console.log(`[Clinixos] Sauvegarde Cloudflare auto toutes les ${minutes} min.`);
  return {
    stop() { clearInterval(timer); clearTimeout(kickoff); },
    trigger,
  };
}

module.exports = { loadConfig, saveConfig, runBackup, startAutoBackup, CONFIG_NAME };
