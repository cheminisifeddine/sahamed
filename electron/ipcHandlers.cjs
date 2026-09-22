'use strict';
const { app, ipcMain, shell, dialog, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let sessionUser = null;

const ok = (fn) => {
  try {
    return { ok: true, data: fn() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
};

const requireAuth = () => {
  if (!sessionUser) throw new Error('Session expirée');
  return sessionUser;
};

const requireMedecin = () => {
  const user = requireAuth();
  if (user.role !== 'medecin') throw new Error('Accès réservé au médecin');
  return user;
};

function registerIpcHandlers(db, socketServer) {
  ipcMain.handle('auth:users', () => ok(() => db.services.listLoginUsers()));
  ipcMain.handle('auth:login', (_event, login, password) => ok(() => {
    sessionUser = db.services.login(login, password);
    return sessionUser;
  }));
  ipcMain.handle('auth:logout', () => ok(() => {
    sessionUser = null;
    return true;
  }));

  ipcMain.handle('patients:list', (_event, filters) => ok(() => {
    requireAuth();
    return db.services.listPatients(filters);
  }));
  ipcMain.handle('patients:count', (_event, filters) => ok(() => {
    requireAuth();
    return db.services.countPatients(filters);
  }));
  ipcMain.handle('patients:get', (_event, id) => ok(() => {
    requireAuth();
    return db.services.getPatient(id);
  }));
  ipcMain.handle('patients:dossier', (_event, id) => ok(() => {
    requireAuth();
    return db.services.getPatientDossier(id);
  }));
  ipcMain.handle('patients:stats', (_event, id) => ok(() => {
    requireAuth();
    return db.services.getPatientStats(id);
  }));
  ipcMain.handle('patients:create', (_event, data) => ok(() => {
    requireAuth();
    const patient = db.services.createPatient(data);
    socketServer.emit('patients:changed', patient);
    return patient;
  }));
  ipcMain.handle('patients:update', (_event, id, data) => ok(() => {
    requireAuth();
    const patient = db.services.updatePatient(id, data);
    socketServer.emit('patients:changed', patient);
    return patient;
  }));
  ipcMain.handle('patients:delete', (_event, id) => ok(() => {
    requireMedecin();
    const deleted = db.services.deletePatient(id);
    socketServer.emit('patients:changed', { id, deleted });
    return deleted;
  }));

  ipcMain.handle('consultations:list', (_event, patientId) => ok(() => {
    requireAuth();
    if (typeof patientId === 'object') return patientId.patientId ? db.services.listConsultations(patientId.patientId) : db.services.getConsultationsJour(patientId.dateDebut);
    return db.services.listConsultations(patientId);
  }));
  ipcMain.handle('consultations:get', (_event, id) => ok(() => {
    requireAuth();
    return db.services.getConsultation(id);
  }));
  ipcMain.handle('consultations:jour', (_event, date) => ok(() => {
    requireAuth();
    return db.services.getConsultationsJour(date);
  }));
  ipcMain.handle('consultations:range', (_event, filters) => ok(() => {
    requireAuth();
    return db.services.listConsultationsRange(filters?.from, filters?.to);
  }));
  ipcMain.handle('consultations:detail', (_event, id) => ok(() => {
    requireAuth();
    return db.services.getConsultationDetail(id);
  }));
  ipcMain.handle('consultations:create', (_event, data) => ok(() => {
    const user = requireMedecin();
    const row = db.services.createConsultation({ ...data, user_id: user.id });
    socketServer.emit('consultations:changed', row);
    return row;
  }));
  ipcMain.handle('consultations:update', (_event, id, data) => ok(() => {
    requireMedecin();
    return db.services.updateConsultation(id, data);
  }));

  ipcMain.handle('ordonnances:list', (_event, patientId) => ok(() => {
    requireAuth();
    return db.services.listOrdonnances(patientId);
  }));
  ipcMain.handle('ordonnances:search', (_event, filters) => ok(() => {
    requireAuth();
    return db.services.rechercherOrdonnances(filters);
  }));
  ipcMain.handle('ordonnances:create', (_event, data) => ok(() => {
    const user = requireMedecin();
    const row = db.services.createOrdonnance({ ...data, user_id: user.id });
    socketServer.emit('ordonnances:changed', row);
    return row;
  }));
  ipcMain.handle('ordonnances:print', (_event, id) => ok(() => {
    requireAuth();
    const ordonnance = db.services.getOrdonnance(id);
    if (ordonnance?.pdf_path) shell.openPath(ordonnance.pdf_path);
    return ordonnance;
  }));
  ipcMain.handle('medicaments:search', (_event, query) => ok(() => {
    requireAuth();
    return db.services.searchMedicaments(query);
  }));
  ipcMain.handle('medicaments:dosages', (_event, nom) => ok(() => {
    requireAuth();
    return db.services.getMedicamentDosages(nom);
  }));
  ipcMain.handle('medicaments:list', (_event, filters) => ok(() => {
    requireAuth();
    return db.services.listMedicaments(filters);
  }));
  ipcMain.handle('medicaments:classes', () => ok(() => {
    requireAuth();
    return db.services.listMedicamentClasses();
  }));
  ipcMain.handle('medicaments:create', (_event, data) => ok(() => {
    requireMedecin();
    return db.services.createMedicament(data);
  }));
  ipcMain.handle('medicaments:update', (_event, id, data) => ok(() => {
    requireMedecin();
    return db.services.updateMedicament(id, data);
  }));
  ipcMain.handle('medicaments:delete', (_event, id) => ok(() => {
    requireMedecin();
    return db.services.deleteMedicament(id);
  }));

  ipcMain.handle('rdv:list', (_event, dateDebut, dateFin) => ok(() => {
    requireAuth();
    if (typeof dateDebut === 'object') return db.services.listRDV(dateDebut.dateDebut, dateDebut.dateFin);
    return db.services.listRDV(dateDebut, dateFin);
  }));
  ipcMain.handle('rdv:jour', (_event, date) => ok(() => {
    requireAuth();
    return db.services.listRDVJour(date);
  }));
  ipcMain.handle('rdv:byPatient', (_event, patientId) => ok(() => {
    requireAuth();
    return db.services.listRDVByPatient(patientId);
  }));
  ipcMain.handle('rdv:create', (_event, data) => ok(() => {
    const user = requireAuth();
    const row = db.services.createRDV({ ...data, created_by: user.id });
    socketServer.emit('rdv:changed', row);
    return row;
  }));
  ipcMain.handle('rdv:update', (_event, id, data) => ok(() => {
    requireAuth();
    const changed = db.services.updateRDV(id, data);
    socketServer.emit('rdv:changed', { id });
    return changed;
  }));
  ipcMain.handle('rdv:delete', (_event, id) => ok(() => {
    requireAuth();
    const deleted = db.services.deleteRDV(id);
    socketServer.emit('rdv:changed', { id, deleted });
    return deleted;
  }));
  ipcMain.handle('rdv:status', (_event, id, statut) => ok(() => {
    requireAuth();
    const changed = db.services.updateStatutRDV(id, statut);
    socketServer.emit('rdv:changed', { id, statut });
    return changed;
  }));

  ipcMain.handle('paiements:list', (_event, filters) => ok(() => {
    requireAuth();
    return db.services.listPaiements(filters);
  }));
  ipcMain.handle('paiements:byPatient', (_event, patientId) => ok(() => {
    requireAuth();
    return db.services.listPaiementsByPatient(patientId);
  }));
  ipcMain.handle('paiements:create', (_event, data) => ok(() => {
    const user = requireAuth();
    const row = db.services.createPaiement({ ...data, created_by: user.id });
    socketServer.emit('paiements:changed', row);
    return row;
  }));
  ipcMain.handle('paiements:fromRDV', (_event, data) => ok(() => {
    const user = requireAuth();
    const row = db.services.createPaiement({ ...data, created_by: user.id });
    socketServer.emit('paiement:created', { ...row, rdv_id: data.rdv_id });
    return row;
  }));
  ipcMain.handle('paiements:nextReceipt', () => ok(() => {
    requireAuth();
    return db.services.getProchainNumeroRecu();
  }));
  ipcMain.handle('paiements:rapport', (_event, filters) => ok(() => {
    requireAuth();
    return db.services.rapportCaisse(filters?.from, filters?.to);
  }));

  ipcMain.handle('depenses:create', (_event, data) => ok(() => {
    const user = requireAuth();
    return db.services.createDepense({ ...data, created_by: user.id });
  }));
  ipcMain.handle('depenses:list', (_event, filters) => ok(() => {
    requireAuth();
    return db.services.listDepenses(filters);
  }));
  ipcMain.handle('depenses:rapport', (_event, filters) => ok(() => {
    requireAuth();
    return db.services.rapportDepenses(filters?.from, filters?.to);
  }));
  ipcMain.handle('data:clear', (_event, password) => ok(() => {
    return db.services.clearData(password);
  }));

  ipcMain.handle('documents:list', (_event, patientId) => ok(() => {
    requireAuth();
    return db.services.listDocuments(patientId);
  }));
  ipcMain.handle('documents:create', (_event, data) => ok(() => {
    requireAuth();
    return db.services.createDocument(data);
  }));
  ipcMain.handle('documents:upload', (_event, patientId, filePath) => ok(() => {
    requireAuth();
    return db.services.createDocument({ patient_id: patientId, type: 'autre', titre: filePath.split(/[\\/]/).pop(), fichier_path: filePath });
  }));
  ipcMain.handle('documents:delete', (_event, id) => ok(() => {
    requireAuth();
    return db.services.deleteDocument(Number(id));
  }));
  ipcMain.handle('dialog:pickFile', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Fichiers médicaux', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'bmp', 'tiff'] }]
      });
      if (result.canceled || !result.filePaths.length) return { ok: true, data: null };
      return { ok: true, data: result.filePaths[0] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('dialog:pickLogo', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'svg'] }]
      });
      if (result.canceled || !result.filePaths.length) return { ok: true, data: null };
      const filePath = result.filePaths[0];
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml' };
      const mime = mimeMap[ext] || 'image/jpeg';
      return { ok: true, data: `data:${mime};base64,${data.toString('base64')}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('parametres:list', () => ok(() => {
    requireAuth();
    return db.services.listParametres();
  }));
  ipcMain.handle('parametres:set', (_event, cle, valeur) => ok(() => {
    requireMedecin();
    return db.services.setParametre(cle, valeur);
  }));
  ipcMain.handle('users:list', () => ok(() => {
    requireMedecin();
    return db.services.listUsers();
  }));
  ipcMain.handle('users:save', (_event, data) => ok(() => {
    requireMedecin();
    return db.services.saveUser(data);
  }));
  ipcMain.handle('users:create', (_event, data) => ok(() => {
    requireMedecin();
    return db.services.saveUser(data);
  }));
  ipcMain.handle('users:update', (_event, id, data) => ok(() => {
    requireMedecin();
    return db.services.saveUser({ ...data, id });
  }));
  ipcMain.handle('motifs:list', () => ok(() => {
    requireAuth();
    return db.services.listMotifs();
  }));
  ipcMain.handle('motifs:all', () => ok(() => {
    requireAuth();
    return db.services.listAllMotifs();
  }));
  ipcMain.handle('motifs:save', (_event, data) => ok(() => {
    requireAuth();
    return db.services.saveMotif(data);
  }));
  ipcMain.handle('motifs:delete', (_event, id) => ok(() => {
    requireAuth();
    return db.services.deleteMotif(id);
  }));

  ipcMain.handle('actes:list', () => ok(() => {
    requireAuth();
    return db.services.listActes();
  }));
  ipcMain.handle('actes:save', (_event, data) => ok(() => {
    requireMedecin();
    return db.services.saveActe(data);
  }));
  ipcMain.handle('actes:create', (_event, data) => ok(() => {
    requireMedecin();
    return db.services.saveActe(data);
  }));
  ipcMain.handle('actes:update', (_event, id, data) => ok(() => {
    requireMedecin();
    return db.services.saveActe({ ...data, id });
  }));

  ipcMain.handle('chat:list', () => ok(() => {
    requireAuth();
    return db.services.listMessages();
  }));
  ipcMain.handle('chat:send', (_event, message) => ok(() => {
    const user = requireAuth();
    const saved = db.services.sendMessage(user.id, message);
    if (saved) socketServer.emit('chat:new', saved);
    return saved;
  }));
  ipcMain.handle('chat:read', () => ok(() => {
    requireAuth();
    return true;
  }));

  ipcMain.handle('alarme:sonner', (_event, data) => ok(() => {
    const user = requireAuth();
    const payload = {
      fromUserId: user.id,
      fromName: `${user.prenom || ''} ${user.nom || ''}`.trim() || user.login,
      mode: data?.mode === 'unique' ? 'unique' : 'continu',
      at: new Date().toISOString(),
    };
    socketServer.emit('alarme:sonnee', payload);
    return payload;
  }));
  ipcMain.handle('alarme:accuser', (_event, data) => ok(() => {
    const user = requireAuth();
    const payload = {
      byUserId: user.id,
      byName: `${user.prenom || ''} ${user.nom || ''}`.trim() || user.login,
      toUserId: data?.toUserId ?? null,
      at: new Date().toISOString(),
    };
    socketServer.emit('alarme:accusee', payload);
    return payload;
  }));

  ipcMain.handle('dashboard:get', () => ok(() => {
    requireAuth();
    return db.services.dashboard();
  }));
  ipcMain.handle('stats:get', (_event, options) => ok(() => {
    requireAuth();
    return db.services.statistiques(options || {});
  }));
  ipcMain.handle('system:backup', (_event, destPath) => ok(() => {
    requireMedecin();
    fs.copyFileSync(db.dbPath, destPath);
    return destPath;
  }));
  ipcMain.handle('system:restore', (_event, srcPath) => ok(() => {
    requireMedecin();
    fs.copyFileSync(srcPath, db.dbPath);
    return true;
  }));
  ipcMain.handle('system:version', () => ok(() => app.getVersion()));
  ipcMain.handle('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.maximize();
  });
  ipcMain.handle('app:quit', () => { app.quit(); });
  ipcMain.handle('system:localIP', () => ok(() => {
    const interfaces = os.networkInterfaces();
    for (const rows of Object.values(interfaces)) {
      for (const item of rows || []) {
        if (item.family === 'IPv4' && !item.internal) return item.address;
      }
    }
    return '127.0.0.1';
  }));

  ipcMain.handle('dialog:pickPhoto', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
      });
      if (result.canceled || result.filePaths.length === 0) return { ok: true, data: null };
      const srcPath = result.filePaths[0];
      const photosDir = path.join(app.getPath('userData'), 'photos');
      if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });
      const ext = path.extname(srcPath);
      const destName = `patient_${Date.now()}${ext}`;
      const destPath = path.join(photosDir, destName);
      fs.copyFileSync(srcPath, destPath);
      return { ok: true, data: destPath };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('dialog:openDataFolder', () => ok(() => {
    shell.showItemInFolder(db.dbPath);
    return true;
  }));

  // N'autorise que les liens WhatsApp — pas un ouvreur d'URL generique.
  ipcMain.handle('system:openWhatsApp', (_event, url) => ok(() => {
    const allowed = /^https:\/\/(wa\.me|api\.whatsapp\.com)\//.test(url);
    if (!allowed) throw new Error('URL non autorisée');
    shell.openExternal(url);
    return true;
  }));

  ipcMain.handle('dialog:backupDB', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const result = await dialog.showSaveDialog(win, {
        title: 'Sauvegarder la base de donnees',
        defaultPath: path.join(app.getPath('documents'), `SahaMed_backup_${date}.db`),
        filters: [{ name: 'Base de donnees', extensions: ['db'] }]
      });
      if (result.canceled || !result.filePath) return { ok: true, data: null };
      fs.copyFileSync(db.dbPath, result.filePath);
      return { ok: true, data: result.filePath };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('dialog:restoreDB', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, {
        title: 'Restaurer la base de donnees',
        properties: ['openFile'],
        filters: [{ name: 'Base de donnees', extensions: ['db'] }]
      });
      if (result.canceled || result.filePaths.length === 0) return { ok: true, data: null };
      fs.copyFileSync(result.filePaths[0], db.dbPath);
      return { ok: true, data: result.filePaths[0] };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  /* ── Impression ────────────────────────────────────────────────── */
  ipcMain.handle('printers:list', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const printers = await win.webContents.getPrintersAsync();
      return { ok: true, data: printers.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: !!p.isDefault })) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // formatDemande : format du document imprime (A5 pour une ordonnance ou un
  // certificat, A4 pour un courrier). Il prime sur le reglage general, qui ne sert
  // que de valeur par defaut : imprimer un courrier A4 sur une page A5 ecrasait la
  // mise en page.
  function printOptions(win, formatDemande) {
    const params = db.services.listParametres();
    const demande = String(formatDemande || '').toUpperCase();
    const format = demande === 'A4' || demande === 'A5'
      ? demande
      : (params.imprimante_format === 'A4' ? 'A4' : 'A5');
    const printerName = params.imprimante_nom || '';
    return {
      silent: true,
      printBackground: true,
      deviceName: printerName || undefined,
      pageSize: format,
      margins: { marginType: 'none' },
    };
  }

  // webContents.print() n'appelle jamais son callback dans certains cas
  // (imprimante virtuelle, pilote qui attend une confirmation malgré silent:true...).
  // On borne toujours l'attente pour ne jamais bloquer l'UI ni laisser une fenêtre orpheline.
  function printWithTimeout(webContents, options, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: "Délai d'impression dépassé (imprimante injoignable ?)" }), timeoutMs);
      try {
        webContents.print(options, (success, reason) => {
          clearTimeout(timer);
          finish(success ? { ok: true, data: true } : { ok: false, error: reason || 'Impression annulée' });
        });
      } catch (error) {
        clearTimeout(timer);
        finish({ ok: false, error: error.message });
      }
    });
  }

  // Impression d'une image deja rendue (meme rendu que le PDF), dans une fenetre
  // vierge : le document imprime ne depend plus du tout de la mise en page de
  // l'application, ni de sa geometrie residuelle, ni de ses animations.
  // A5 et A4 ayant le meme rapport de forme, l'image remplit exactement la feuille
  // dans les deux cas.
  // Impression d'un PDF par SumatraPDF, embarque avec le paquet pdf-to-printer.
  // Une fois l'application packagee, l'executable vit dans app.asar.unpacked
  // (voir asarUnpack dans package.json) : on remet le chemin d'aplomb si besoin.
  async function imprimerPdf(cheminPdf, options) {
    const { print } = require('pdf-to-printer');
    return print(cheminPdf, options);
  }

  // Formats papier, en millimetres et en microns (l'unite attendue par Electron).
  const FORMATS_PAPIER = {
    A5: { mm: [148, 210], microns: { width: 148000, height: 210000 } },
    A4: { mm: [210, 297], microns: { width: 210000, height: 297000 } },
  };

  // Impression d'une image deja rendue — le meme rendu que le PDF, qui lui sort
  // correct. Le document est compose aux dimensions EXACTES du papier, en
  // millimetres, pour qu'aucune mise a l'echelle ne soit necessaire :
  // depuis un changement de Chromium, l'impression silencieuse d'Electron reduit si
  // besoin mais n'agrandit jamais (electron/electron#45218, corrige a partir
  // d'Electron 33 — le projet est en 31). Un document plus petit que la feuille
  // etait donc pose tel quel, avec une large bande blanche autour.
  // pageSize est passe en microns : la forme chaine ('A5') est signalee inoperante
  // en impression silencieuse sous Windows (electron/electron#31705).
  ipcMain.handle('print:image', async (event, dataUrl, format) => {
    if (!dataUrl || typeof dataUrl !== 'string') return { ok: false, error: 'Rien a imprimer' };
    // Le papier est celui REELLEMENT charge dans le bac (Parametres > Imprimante),
    // pas le format naturel du document : un courrier A4 tire sur une feuille A5
    // depassait des deux cotes. A5 et A4 ayant le meme rapport de forme, la piece
    // remplit la feuille dans les deux cas, simplement plus grande ou plus petite.
    const reglages = db.services.listParametres();
    const demande = String(format || '').toUpperCase();
    const configure = reglages.imprimante_format === 'A4' ? 'A4' : 'A5';
    const nom = FORMATS_PAPIER[configure] ? configure : (demande === 'A4' ? 'A4' : 'A5');
    const papier = FORMATS_PAPIER[nom];
    const [largeurMm, hauteurMm] = papier.mm;

    // Fenetre au format du papier (96 points par pouce), pour que la composition
    // ne parte pas d'une zone d'affichage sans rapport avec la feuille.
    const enPx = (mm) => Math.round((mm / 25.4) * 96);
    const fenetre = new BrowserWindow({
      show: false,
      width: enPx(largeurMm),
      height: enPx(hauteurMm),
      webPreferences: { sandbox: false, javascript: false },
    });

    try {
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        @page { size: ${largeurMm}mm ${hauteurMm}mm; margin: 0; }
        html, body { margin: 0; padding: 0; width: ${largeurMm}mm; height: ${hauteurMm}mm; background: #fff; overflow: hidden; }
        img { display: block; width: ${largeurMm}mm; height: ${hauteurMm}mm; }
      </style></head><body><img src="${dataUrl}"></body></html>`;
      await fenetre.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

      const params = reglages;
      const imprimante = params.imprimante_nom || undefined;
      // Filet de securite : le cabinet peut demander la boite de dialogue, qui
      // compose correctement sur tous les postes.
      const avecDialogue = params.imprimante_dialogue === '1';

      // On produit d'abord un vrai PDF a la taille exacte du papier, puis on
      // l'imprime via SumatraPDF (paquet pdf-to-printer).
      // webContents.print() en mode silencieux ignore pageSize sous Windows et
      // retombe sur le format par defaut de l'imprimante (electron/electron#31705) :
      // une page A5 envoyee a une imprimante reglee en A4 sortait decalee, avec une
      // bande blanche en haut. Passer par un PDF supprime cette negociation.
      const pdf = await fenetre.webContents.printToPDF({
        pageSize: papier.microns,
        margins: { marginType: 'none' },
        printBackground: true,
        preferCSSPageSize: true,
      });

      const cheminPdf = path.join(app.getPath('temp'), `sahamed-${nom}-${Date.now()}.pdf`);
      fs.writeFileSync(cheminPdf, pdf);
      try {
        await imprimerPdf(cheminPdf, {
          printer: imprimante,
          paperSize: nom,
          scale: 'fit',
          silent: !avecDialogue,
          printDialog: avecDialogue,
        });
        return { ok: true, data: true };
      } catch (erreurPdf) {
        // Repli sur l'impression directe : mieux vaut un tirage mal cale que rien.
        console.warn('[SahaMed] Impression via PDF impossible, repli :', erreurPdf.message);
        const repli = await printWithTimeout(fenetre.webContents, {
          silent: !avecDialogue,
          printBackground: true,
          deviceName: imprimante,
          pageSize: papier.microns,
          margins: { marginType: 'none' },
        });
        if (repli.ok) return repli;
        return { ok: false, error: `Impression impossible : ${erreurPdf.message}` };
      } finally {
        try { fs.unlinkSync(cheminPdf); } catch { /* fichier temporaire */ }
      }
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      if (!fenetre.isDestroyed()) fenetre.destroy();
    }
  });

  ipcMain.handle('print:silent', (event, format) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return printWithTimeout(win.webContents, printOptions(win, format));
  });

  ipcMain.handle('print:test', async (event) => {
    const testWin = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
    try {
      const params = db.services.listParametres();
      const printerName = params.imprimante_nom || '(imprimante par défaut du système)';
      const format = params.imprimante_format === 'A4' ? 'A4' : 'A5';
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:Arial,sans-serif;padding:24px;color:#111}
        h1{font-size:18px;margin:0 0 12px}
        p{font-size:12px;margin:4px 0;color:#333}
        .box{border:1px solid #999;border-radius:6px;padding:12px;margin-top:16px}
      </style></head><body>
        <h1>SahaMed — Impression test</h1>
        <p>Date : ${new Date().toLocaleString('fr-FR')}</p>
        <p>Imprimante configurée : ${printerName}</p>
        <p>Format papier : ${format}</p>
        <div class="box">Si cette page s'imprime correctement, la configuration est fonctionnelle.</div>
      </body></html>`;
      await new Promise((resolve) => {
        testWin.webContents.once('did-finish-load', resolve);
        testWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      });
      return await printWithTimeout(testWin.webContents, printOptions(testWin));
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      if (!testWin.isDestroyed()) testWin.close();
    }
  });
}

module.exports = { registerIpcHandlers };
