'use strict';
const { BrowserWindow } = require('electron');
const { createServer }  = require('node:http');
const { Server }        = require('socket.io');
const fs                = require('node:fs');
const path              = require('node:path');
const crypto            = require('node:crypto');
const os                = require('node:os');
const guard             = require('./guard.cjs');

const DIST_DIR = path.join(__dirname, '..', 'dist');

// Version réelle de l'app, servie aux postes réseau (auparavant '1.0.0' en dur).
let APP_VERSION = '0.0.0';
try { APP_VERSION = require(path.join(__dirname, '..', 'package.json')).version; } catch {}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.map':  'application/json',
  '.webp': 'image/webp',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/* ─── Sessions persistantes ──────────────────────────────────────── */
let _sessionsFile = null;
const sessions = new Map(); // token → user object

function loadSessions(filePath) {
  _sessionsFile = filePath;
  try {
    if (fs.existsSync(filePath)) {
      const entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(entries)) entries.forEach(([k, v]) => sessions.set(k, v));
    }
  } catch {}
}

function saveSessions() {
  if (!_sessionsFile) return;
  try { fs.writeFileSync(_sessionsFile, JSON.stringify([...sessions.entries()])); } catch {}
}

function startSocketServer(db, port = 3789, userDataPath = null) {
  if (userDataPath) loadSessions(path.join(userDataPath, 'sessions.json'));
  let io; // référence pour les broadcasts dans handleApi

  const httpServer = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    // CORS (pour les clients réseau)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── API REST ────────────────────────────────────────────────────
    if (url === '/api' && req.method === 'POST') {
      handleApi(req, res, db, sessions, () => io).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
      return;
    }

    // ── Fichiers statiques (app React buildée) ─────────────────────
    if (!url.startsWith('/socket.io')) serveStatic(req, res, url);
  });

  io = new Server(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    socket.emit('chat:history', db.services.listMessages());

    socket.on('chat:send', ({ userId, message }) => {
      try {
        const saved = db.services.sendMessage(userId, message);
        io.emit('chat:new', saved);
        broadcastToWindows('chat:new', saved);
      } catch (error) {
        socket.emit('error:message', error.message);
      }
    });

    // Broadcast de tous les événements métier aux clients réseau
    socket.on('relay', ({ event, payload }) => {
      socket.broadcast.emit(event, payload);
    });
  });

  // EADDRINUSE arrive parfois si l'app vient d'être fermée et que le port
  // n'est pas encore libéré par l'OS. On retente quelques fois avant d'abandonner
  // (sans jamais faire planter l'app : le cabinet reste utilisable en local).
  let listenAttempts = 0;
  const tryListen = () => {
    httpServer.listen(port, '0.0.0.0', () => {
      const ip = getLocalIP();
      console.log(`[SahaMed] Serveur réseau démarré — http://${ip}:${port}`);
    });
  };
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && listenAttempts < 5) {
      listenAttempts += 1;
      console.warn(`[SahaMed] Port ${port} occupé, nouvelle tentative dans 1s (${listenAttempts}/5)...`);
      setTimeout(tryListen, 1000);
    } else {
      console.error(`[SahaMed] Impossible de démarrer le serveur réseau sur le port ${port} :`, err.message);
    }
  });
  tryListen();

  return {
    io,
    port,
    emit(event, payload) {
      io.emit(event, payload);
      broadcastToWindows(event, payload);
    },
    close() { io.close(); httpServer.close(); },
  };
}

/* ─── Fichiers statiques ─────────────────────────────────────────── */
function serveStatic(req, res, url) {
  if (!fs.existsSync(DIST_DIR)) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Application non construite</h1><p>Lancez <code>npm run build</code> sur le PC principal puis redémarrez SahaMed.</p>');
    return;
  }

  let filePath = path.join(DIST_DIR, url === '/' ? 'index.html' : url);
  // SPA fallback
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html');
  }
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }

  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}

/* ─── API REST générique ─────────────────────────────────────────── */
async function handleApi(req, res, db, sessions, getIo) {
  // Parser le body JSON
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { body = {}; }

  const { channel, args = [] } = body;
  const io = getIo();

  const send = (result) => {
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
  };

  // ── Canaux publics (sans authentification) ──────────────────────
  if (channel === 'auth:users') {
    return send({ ok: true, data: db.services.listLoginUsers() });
  }

  if (channel === 'auth:login') {
    try {
      const user = db.services.login(args[0], args[1]);
      const token = crypto.randomUUID();
      sessions.set(token, user);
      saveSessions();
      send({ ok: true, data: { token, ...user } });
    } catch (e) { send({ ok: false, error: e.message }); }
    return;
  }

  // Licence + infos système : accessibles SANS session. L'écran de licence
  // (LicenseGate) s'affiche avant l'écran de connexion sur les postes réseau ;
  // exiger une session ici renvoyait « Session expirée », ce qui déclenchait
  // un rechargement de page en boucle (écran bleu/blanc figé côté secrétaire).
  if (channel === 'guard:status') {
    return send({ ok: true, data: guard.status() });
  }

  if (channel === 'guard:bind') {
    try { guard.bind(args[0]); return send({ ok: true, data: guard.status() }); }
    catch (e) { return send({ ok: false, error: e.message }); }
  }

  if (channel === 'system:version') return send({ ok: true, data: APP_VERSION });
  if (channel === 'system:localIP') return send({ ok: true, data: getLocalIP() });

  // ── Vérification session ────────────────────────────────────────
  const rawToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const sessionUser = rawToken ? sessions.get(rawToken) : null;
  if (!sessionUser) return send({ ok: false, error: 'Session expirée. Reconnectez-vous.' });

  if (channel === 'auth:logout') {
    sessions.delete(rawToken);
    saveSessions();
    return send({ ok: true, data: true });
  }

  // ── Helpers rôle ────────────────────────────────────────────────
  const mustBeMedecin = () => {
    if (sessionUser.role !== 'medecin') throw new Error('Accès réservé au médecin');
  };

  // ── Dispatch ────────────────────────────────────────────────────
  try {
    let data;
    const [a0, a1] = args;

    switch (channel) {
      // Patients
      case 'patients:list':   data = db.services.listPatients(a0); break;
      case 'patients:count':  data = db.services.countPatients(a0); break;
      case 'patients:get':    data = db.services.getPatient(a0); break;
      case 'patients:stats':  data = db.services.getPatientStats(a0); break;
      case 'patients:dossier': data = db.services.getPatientDossier(a0); break;
      case 'patients:create': { const p = db.services.createPatient(a0); io.emit('patients:changed', p); data = p; break; }
      case 'patients:update': { const p = db.services.updatePatient(a0, a1); io.emit('patients:changed', p); data = p; break; }
      case 'patients:delete': { mustBeMedecin(); const d = db.services.deletePatient(a0); io.emit('patients:changed', { id: a0, deleted: d }); data = d; break; }
      // Consultations
      case 'consultations:list':   data = db.services.listConsultations(a0); break;
      case 'consultations:get':    data = db.services.getConsultation(a0); break;
      case 'consultations:jour':   data = db.services.getConsultationsJour(a0); break;
      case 'consultations:range':  data = db.services.listConsultationsRange(a0?.from, a0?.to); break;
      case 'consultations:detail': data = db.services.getConsultationDetail(a0); break;
      case 'consultations:create': { mustBeMedecin(); const c = db.services.createConsultation({ ...a0, user_id: sessionUser.id }); io.emit('consultations:changed', c); data = c; break; }
      case 'consultations:update': { mustBeMedecin(); data = db.services.updateConsultation(a0, a1); break; }
      // Ordonnances
      case 'ordonnances:list':   data = db.services.listOrdonnances(a0); break;
      case 'ordonnances:search': data = db.services.rechercherOrdonnances(a0); break;
      case 'ordonnances:create': { mustBeMedecin(); const o = db.services.createOrdonnance({ ...a0, user_id: sessionUser.id }); io.emit('ordonnances:changed', o); data = o; break; }
      case 'ordonnances:print':  data = db.services.getOrdonnance(a0); break;
      // Médicaments
      case 'medicaments:search':  data = db.services.searchMedicaments(a0); break;
      case 'medicaments:dosages': data = db.services.getMedicamentDosages(a0); break;
      case 'medicaments:list':    data = db.services.listMedicaments(a0); break;
      case 'medicaments:classes': data = db.services.listMedicamentClasses(); break;
      case 'medicaments:create':  { mustBeMedecin(); data = db.services.createMedicament(a0); break; }
      case 'medicaments:update':  { mustBeMedecin(); data = db.services.updateMedicament(a0, a1); break; }
      case 'medicaments:delete':  { mustBeMedecin(); data = db.services.deleteMedicament(a0); break; }
      // RDV
      case 'rdv:list': {
        const from = typeof a0 === 'object' ? a0?.dateDebut : a0;
        const to   = typeof a0 === 'object' ? a0?.dateFin   : a1;
        data = db.services.listRDV(from, to); break;
      }
      case 'rdv:create': { const r = db.services.createRDV({ ...a0, created_by: sessionUser.id }); io.emit('rdv:changed', r); data = r; break; }
      case 'rdv:update': { const r = db.services.updateRDV(a0, a1); io.emit('rdv:changed', { id: a0 }); data = r; break; }
      case 'rdv:delete': { const d = db.services.deleteRDV(a0); io.emit('rdv:changed', { id: a0, deleted: d }); data = d; break; }
      case 'rdv:status': { const r = db.services.updateStatutRDV(a0, a1); io.emit('rdv:changed', { id: a0, statut: a1 }); data = r; break; }
      case 'rdv:byPatient': data = db.services.listRDVByPatient(a0); break;
      case 'rdv:jour': data = db.services.listRDVJour(a0); break;
      // Paiements
      case 'paiements:list':        data = db.services.listPaiements(a0); break;
      case 'paiements:byPatient':   data = db.services.listPaiementsByPatient(a0); break;
      case 'paiements:create':      { const p = db.services.createPaiement({ ...a0, created_by: sessionUser.id }); io.emit('paiements:changed', p); data = p; break; }
      case 'paiements:fromRDV':     { const p = db.services.createPaiement({ ...a0, created_by: sessionUser.id }); io.emit('paiement:created', { ...p, rdv_id: a0.rdv_id }); data = p; break; }
      case 'paiements:nextReceipt': data = db.services.getProchainNumeroRecu(); break;
      case 'paiements:rapport':     data = db.services.rapportCaisse(a0?.from, a0?.to); break;
      // Motifs RDV (accessibles a tout utilisateur authentifie, comme cote Electron)
      case 'motifs:list':   data = db.services.listMotifs(); break;
      case 'motifs:all':    data = db.services.listAllMotifs(); break;
      case 'motifs:save':   data = db.services.saveMotif(a0); break;
      case 'motifs:delete': data = db.services.deleteMotif(a0); break;
      // Dépenses
      case 'depenses:create':  data = db.services.createDepense({ ...a0, created_by: sessionUser.id }); break;
      case 'depenses:list':    data = db.services.listDepenses(a0); break;
      case 'depenses:rapport': data = db.services.rapportDepenses(a0?.from, a0?.to); break;
      // Documents
      case 'documents:list':   data = db.services.listDocuments(a0); break;
      case 'documents:create': data = db.services.createDocument(a0); break;
      case 'documents:delete': data = db.services.deleteDocument(Number(a0)); break;
      // Chat
      case 'chat:list': data = db.services.listMessages(); break;
      case 'chat:send': {
        const m = db.services.sendMessage(sessionUser.id, a0);
        if (m) { io.emit('chat:new', m); broadcastToWindows('chat:new', m); }
        data = m; break;
      }
      case 'chat:read': data = true; break;
      // Alarme secretaire
      case 'alarme:sonner': {
        const payload = {
          fromUserId: sessionUser.id,
          fromName: `${sessionUser.prenom || ''} ${sessionUser.nom || ''}`.trim() || sessionUser.login,
          mode: a0?.mode === 'unique' ? 'unique' : 'continu',
          at: new Date().toISOString(),
        };
        io.emit('alarme:sonnee', payload);
        broadcastToWindows('alarme:sonnee', payload);
        data = payload; break;
      }
      case 'alarme:accuser': {
        const payload = {
          byUserId: sessionUser.id,
          byName: `${sessionUser.prenom || ''} ${sessionUser.nom || ''}`.trim() || sessionUser.login,
          toUserId: a0?.toUserId ?? null,
          at: new Date().toISOString(),
        };
        io.emit('alarme:accusee', payload);
        broadcastToWindows('alarme:accusee', payload);
        data = payload; break;
      }
      // Dashboard
      case 'dashboard:get': data = db.services.dashboard(); break;
      case 'stats:get': data = db.services.statistiques(a0 || {}); break;
      // Paramètres
      case 'parametres:list': data = db.services.listParametres(); break;
      case 'parametres:set':  { mustBeMedecin(); data = db.services.setParametre(a0, a1); break; }
      // Utilisateurs
      case 'users:list':   { mustBeMedecin(); data = db.services.listUsers(); break; }
      case 'users:save':   { mustBeMedecin(); data = db.services.saveUser(a0); break; }
      case 'users:create': { mustBeMedecin(); data = db.services.saveUser(a0); break; }
      case 'users:update': { mustBeMedecin(); data = db.services.saveUser({ ...a1, id: a0 }); break; }
      // Actes
      case 'actes:list':   data = db.services.listActes(); break;
      case 'actes:save':   { mustBeMedecin(); data = db.services.saveActe(a0); break; }
      case 'actes:create': { mustBeMedecin(); data = db.services.saveActe(a0); break; }
      case 'actes:update': { mustBeMedecin(); data = db.services.saveActe({ ...a1, id: a0 }); break; }
      // (system:* et guard:* sont traités plus haut, en canaux publics)

      default:
        return send({ ok: false, error: `Canal non supporté: ${channel}` });
    }
    send({ ok: true, data });
  } catch (e) {
    send({ ok: false, error: e.message });
  }
}

/* ─── Helpers ────────────────────────────────────────────────────── */
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const rows of Object.values(interfaces)) {
    for (const item of rows || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}

function broadcastToWindows(event, payload) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('socket:event', { event, payload });
  });
}

module.exports = { startSocketServer };
