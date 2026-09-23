'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, Menu, nativeImage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const networkConfig = require('./networkConfig.cjs');

let mainWindow;
let socketServer;
let clientRetryTimer = null;

function logError(message, error) {
  const details = [new Date().toISOString(), message, error && (error.stack || error.message) || String(error || '')].join('\n');
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'sahamed-error.log'), `${details}\n\n`);
  } catch {}
  console.error(details);
}

function showFatal(message, error) {
  logError(message, error);
  dialog.showErrorBox('Clinixos - Erreur', `${message}\n\n${error && error.message ? error.message : error || ''}\n\nUn journal sahamed-error.log a ete cree dans le dossier utilisateur Clinixos.`);
}

/* ═══════════════════════════ Poste principal (Médecin) ═══════════════════════════ */

async function createApp() {
  try {
    Menu.setApplicationMenu(null);
    const isDev = false; // forced prod: load dist/index.html (5173 vite not running)
    const { initDatabase }       = require('./database.cjs');
    const { registerIpcHandlers } = require('./ipcHandlers.cjs');
    const { startSocketServer }  = require('./server.cjs');
    const guard                  = require('./guard.cjs');

    const db = await initDatabase(app.getPath('userData'));
    guard.init(app.getPath('userData'));
    socketServer = startSocketServer(db, 3789, app.getPath('userData'));

    // Sauvegarde Cloudflare optionnelle (D1 + R2) — inactive sans config
    const cloudBackup = require('./cloudBackup.cjs');
    const backupHandle = cloudBackup.startAutoBackup(db, app.getPath('userData'));
    ipcMain.handle('backup:cloud', async () => backupHandle.trigger());
    ipcMain.handle('backup:cloudConfig', (_ev, next) => {
      try {
        if (next && typeof next === 'object') {
          cloudBackup.saveConfig(app.getPath('userData'), next);
          return { ok: true, data: cloudBackup.loadConfig(app.getPath('userData')) };
        }
        return { ok: true, data: cloudBackup.loadConfig(app.getPath('userData')) };
      } catch (e) { return { ok: false, error: e.message }; }
    });

  // ── Canaux exemptés du contrôle de licence ────────────────────
    const _exempt = new Set([
    'guard:status','guard:bind',
    'auth:login','auth:logout','auth:users',
    'app:quit','window:maximize','system:version','system:localIP',
  ]);
    const _hx = ipcMain.handle.bind(ipcMain);

  // Enregistrer les canaux licence AVANT le wrapper
    _hx('guard:status', () => ({ ok: true,  data: guard.status() }));
    _hx('guard:bind',  (_ev, token) => {
      try { guard.bind(token); return { ok: true, data: guard.status() }; }
      catch (e) { return { ok: false, error: e.message }; }
    });

  // Wrapper : bloque tous les autres canaux si licence expirée
    ipcMain.handle = (ch, fn) => {
      if (_exempt.has(ch)) return _hx(ch, fn);
      return _hx(ch, (ev, ...a) => {
        const s = guard.status();
        if (s.mode !== 'bound' && s.mode !== 'eval' && s.mode !== 'locked') return null;
        return fn(ev, ...a);
      });
    };
    registerIpcHandlers(db, socketServer);
    ipcMain.handle = _hx; // restaurer

    createMainWindow(isDev);

  // ── Heartbeat toutes les 5 minutes ────────────────────────────
    const _beat = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(_beat); return; }
      mainWindow.webContents.send('guard:recheck', guard.status());
    }, 5 * 60 * 1000);

  // ── Blocage DevTools en production ───────────────────────────
    if (!isDev) {
      mainWindow.webContents.on('devtools-opened', () => mainWindow.webContents.closeDevTools());
      mainWindow.webContents.on('before-input-event', (_, input) => {
        const block = input.key === 'F12' ||
          (input.control && input.shift && ['I','J','C'].includes(input.key.toUpperCase()));
        if (block) _.preventDefault();
      });
    }
  } catch (error) {
    showFatal("Clinixos n'a pas pu demarrer.", error);
    app.quit();
  }
}

function appIcon() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  return fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;
}

function createMainWindow(isDev) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: 'Clinixos',
    backgroundColor: '#f8fafc',
    icon: appIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  mainWindow.maximize();
  mainWindow.show();

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html')).catch((error) => {
      showFatal("Impossible de charger l'interface Clinixos.", error);
    });
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    showFatal(`Chargement impossible (${errorCode}) : ${validatedURL}`, new Error(errorDescription));
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    showFatal(`Erreur preload : ${preloadPath}`, error);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    showFatal('Le processus renderer Clinixos a quitte de maniere inattendue.', new Error(JSON.stringify(details)));
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) logError(`Console renderer ${sourceId}:${line}`, new Error(message));
  });
}

/* ═══════════════════════════ Poste secrétaire (client réseau) ═══════════════════════════ */

function serverUrl(ip) {
  return `http://${ip}:3789`;
}

function createClientWindow(serverIP) {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: 'Clinixos — Poste secretaire',
    backgroundColor: '#f8fafc',
    icon: appIcon(),
    show: false,
    webPreferences: {
      // Preload volontairement minimal : n'expose PAS window.api, ce qui fait
      // automatiquement basculer le frontend sur le client réseau httpApi.js
      // (même logique que l'accès navigateur, déjà testée) au lieu de sql.js local.
      // Il expose seulement window.offlineApi, utilisé par offline.html.
      preload: path.join(__dirname, 'offline-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  mainWindow.maximize();
  mainWindow.show();

  attemptClientLoad(serverIP);

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.alt && (input.key || '').toLowerCase() === 'r') {
      event.preventDefault();
      reconfigure();
    }
  });
}

function attemptClientLoad(serverIP) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearClientRetryTimer();
  mainWindow.loadURL(serverUrl(serverIP)).catch(() => showClientOffline(serverIP));
}

function showClientOffline(serverIP) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadFile(path.join(__dirname, 'offline.html'), { query: { ip: serverIP } });
  clearClientRetryTimer();
  clientRetryTimer = setInterval(() => attemptClientLoad(serverIP), 4000);
}

function clearClientRetryTimer() {
  if (clientRetryTimer) { clearInterval(clientRetryTimer); clientRetryTimer = null; }
}

function reconfigure() {
  clearClientRetryTimer();
  networkConfig.clearConfig(app.getPath('userData'));
  app.relaunch();
  app.exit(0);
}

/* ═══════════════════════════ Écran de configuration (1er lancement) ═══════════════════════════ */

function createSetupWindow() {
  Menu.setApplicationMenu(null);
  const setupWindow = new BrowserWindow({
    width: 760,
    height: 560,
    resizable: false,
    title: 'Configuration Clinixos',
    backgroundColor: '#f8fafc',
    icon: appIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.once('ready-to-show', () => setupWindow.show());
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
  return setupWindow;
}

function registerSetupHandlers() {
  ipcMain.handle('setup:getLocalIP', () => networkConfig.getLocalIP());

  ipcMain.handle('setup:testConnection', async (_event, ip) => {
    const cleanIP = String(ip || '').trim();
    if (!cleanIP) return { ok: false, error: 'Adresse IP vide' };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await net.fetch(`${serverUrl(cleanIP)}/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'auth:users', args: [] }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return { ok: false, error: `Réponse HTTP ${res.status}` };
      const json = await res.json();
      if (json && json.ok) return { ok: true };
      return { ok: false, error: 'Adresse trouvée mais réponse inattendue (Clinixos est-il bien lancé ?)' };
    } catch (error) {
      return { ok: false, error: 'Aucune réponse à cette adresse (vérifiez le réseau et le pare-feu).' };
    }
  });

  ipcMain.handle('setup:chooseMain', async (event) => {
    networkConfig.writeConfig(app.getPath('userData'), { mode: 'server' });
    const setupWin = BrowserWindow.fromWebContents(event.sender);
    await createApp();
    setupWin?.close();
  });

  ipcMain.handle('setup:chooseSecretary', (event, ip) => {
    const cleanIP = String(ip || '').trim();
    networkConfig.writeConfig(app.getPath('userData'), { mode: 'client', serverIP: cleanIP });
    const setupWin = BrowserWindow.fromWebContents(event.sender);
    createClientWindow(cleanIP);
    setupWin?.close();
  });

  ipcMain.handle('client:retry', (event) => {
    const config = networkConfig.readConfig(app.getPath('userData'));
    if (config?.mode === 'client') attemptClientLoad(config.serverIP);
  });

  ipcMain.handle('client:reconfigure', () => reconfigure());

  ipcMain.handle('client:quit', () => { app.quit(); return true; });
}

/* ═══════════════════════════ Démarrage ═══════════════════════════ */

app.setAppUserModelId('com.sahamed.app');

app.whenReady().then(() => {
  // Custom protocol to serve local files (photos) from http:// renderer in dev mode
  protocol.handle('sahamed', (req) => {
    const filePath = decodeURIComponent(req.url.replace('sahamed:///', ''));
    return net.fetch('file:///' + filePath);
  });

  registerSetupHandlers();

  const config = networkConfig.readConfig(app.getPath('userData'));
  if (!config) {
    createSetupWindow();
  } else if (config.mode === 'client') {
    createClientWindow(config.serverIP);
  } else {
    createApp();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  clearClientRetryTimer();
  socketServer?.close();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const config = networkConfig.readConfig(app.getPath('userData'));
    if (!config) createSetupWindow();
    else if (config.mode === 'client') createClientWindow(config.serverIP);
    else createMainWindow(!app.isPackaged);
  }
});
