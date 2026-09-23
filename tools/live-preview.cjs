'use strict';
/**
 * Clinixos — live preview localhost (sans Electron GUI).
 *
 *   npm run preview
 *   → http://127.0.0.1:3789
 *
 * - API + socket.io temps réel (ajouts / suppressions → auto-refresh)
 * - Watch dist/ + electron/ → reload navigateur
 * - Données via SQL local (hors ligne), Cloudflare optionnel
 */
process.env.SAHAMED_LIVE = '1';

const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WORKER = path.join(__filename);

/* ─── Mode parent : supervise le worker + restart si electron/ change ─── */
if (!process.argv.includes('--worker')) {
  let child = null;
  let restarting = false;

  const startWorker = () => {
    child = fork(WORKER, ['--worker'], {
      env: { ...process.env, SAHAMED_LIVE: '1' },
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => {
      if (restarting) return;
      if (code === 0) process.exit(0);
      console.error(`[preview] worker exited (code=${code} signal=${signal}) — restart dans 1s`);
      setTimeout(startWorker, 1000);
    });
  };

  // Surveille le backend : redémarre le worker
  const watchBackend = () => {
    const dirs = [path.join(ROOT, 'electron')];
    const seen = new Map();
    const snapshot = (dir) => {
      const map = new Map();
      try {
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith('.cjs')) continue;
          const p = path.join(dir, name);
          try {
            const st = fs.statSync(p);
            map.set(p, `${st.mtimeMs}:${st.size}`);
          } catch {}
        }
      } catch {}
      return map;
    };
    for (const d of dirs) seen.set(d, snapshot(d));

    const tick = () => {
      for (const [dir, prev] of seen) {
        const next = snapshot(dir);
        for (const [p, sig] of next) {
          if (prev.get(p) !== undefined && prev.get(p) !== sig) {
            console.log(`[preview] backend modifié: ${path.basename(p)} — redémarrage…`);
            restarting = true;
            try { child && child.kill('SIGTERM'); } catch {}
            setTimeout(() => { restarting = false; startWorker(); watchBackend(); }, 400);
            return;
          }
        }
        seen.set(dir, next);
      }
    };
    setInterval(tick, 700).unref();
  };

  console.log('[Clinixos preview] démarrage…');
  startWorker();
  watchBackend();

  process.on('SIGINT', () => { try { child && child.kill('SIGINT'); } catch {} process.exit(0); });
  process.on('SIGTERM', () => { try { child && child.kill('SIGTERM'); } catch {} process.exit(0); });
} else {
  /* ─── Mode worker : serveur + watch dist/ → preview:reload ─── */
  (async () => {
    const userData = path.join(
      process.env.SAHAMED_USERDATA ||
        (process.platform === 'win32'
          ? process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming')
          : path.join(require('os').homedir(), '.config')),
      'Clinixos'
    );
    fs.mkdirSync(userData, { recursive: true });

    const { initDatabase } = require(path.join(ROOT, 'electron', 'database.cjs'));
    const { startSocketServer } = require(path.join(ROOT, 'electron', 'server.cjs'));
    const cloudBackup = require(path.join(ROOT, 'electron', 'cloudBackup.cjs'));
    const guard = require(path.join(ROOT, 'electron', 'guard.cjs'));

    const db = await initDatabase(userData);
    guard.init(userData);
    const server = startSocketServer(db, Number(process.env.PORT) || 3789, userData);
    cloudBackup.startAutoBackup(db, userData);

    // Watch dist/ → reload navigateurs connectés
    const distDir = path.join(ROOT, 'dist');
    let last = new Map();
    let timer = null;
    const sigOf = (p) => {
      try { const st = fs.statSync(p); return `${st.mtimeMs}:${st.size}`; } catch { return 'gone'; }
    };
    const walk = (dir, acc = new Map()) => {
      try {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(p, acc);
          else acc.set(p, sigOf(p));
        }
      } catch {}
      return acc;
    };
    last = walk(distDir);

    const bump = (reason) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const now = walk(distDir);
        let changed = false;
        for (const [p, sig] of now) {
          if (last.get(p) !== sig) { changed = true; break; }
        }
        for (const p of last.keys()) if (!now.has(p)) { changed = true; break; }
        last = now;
        if (!changed) return;
        console.log(`[preview] dist modifié → reload (${reason})`);
        try { server.io.emit('preview:reload', { at: Date.now(), reason }); } catch {}
      }, 200);
    };

    if (fs.watch) {
      try {
        fs.watch(distDir, { recursive: true }, (_e, file) => bump(String(file || 'dist')));
      } catch {
        // non-récursif : fallback polling
        setInterval(() => bump('poll'), 1500).unref();
      }
    } else {
      setInterval(() => bump('poll'), 1500).unref();
    }

    console.log('[Clinixos preview] ouvrez http://127.0.0.1:3789');
    console.log('[Clinixos preview] modifiez dist/** → auto-reload ; ajoutez/supprimez des données → auto-refresh');

    const shutdown = () => {
      try { server.close(); } catch {}
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })().catch((e) => {
    console.error('[preview] échec:', e);
    process.exit(1);
  });
}
