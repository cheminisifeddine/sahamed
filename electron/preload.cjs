const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getPatients: (search) => invoke('patients:list', search),
  countPatients: (filters) => invoke('patients:count', filters),
  getPatient: (id) => invoke('patients:get', id),
  getPatientStats: (id) => invoke('patients:stats', id),
  getPatientDossier: (id) => invoke('patients:dossier', id),
  createPatient: (data) => invoke('patients:create', data),
  updatePatient: (id, data) => invoke('patients:update', id, data),
  deletePatient: (id) => invoke('patients:delete', id),

  getConsultations: (patientId) => invoke('consultations:list', patientId),
  getConsultation: (id) => invoke('consultations:get', id),
  getConsultationsJour: (date) => invoke('consultations:jour', date),
  getConsultationsRange: (filters) => invoke('consultations:range', filters),
  getConsultationDetail: (id) => invoke('consultations:detail', id),
  createConsultation: (data) => invoke('consultations:create', data),
  updateConsultation: (id, data) => invoke('consultations:update', id, data),

  getOrdonnances: (patientId) => invoke('ordonnances:list', patientId),
  searchOrdonnances:   (filters) => invoke('ordonnances:search', filters),
  createOrdonnance: (data) => invoke('ordonnances:create', data),
  printOrdonnance: (id) => invoke('ordonnances:print', id),
  generateOrdonnancePDF: (id) => invoke('ordonnances:print', id),
  searchMedicaments: (query) => invoke('medicaments:search', query),
  getMedicamentDosages: (nom) => invoke('medicaments:dosages', nom),
  listMedicaments: (filters) => invoke('medicaments:list', filters),
  getMedicamentClasses: () => invoke('medicaments:classes'),
  createMedicament: (data) => invoke('medicaments:create', data),
  updateMedicament: (id, data) => invoke('medicaments:update', id, data),
  deleteMedicament: (id) => invoke('medicaments:delete', id),

  getRDV: (dateDebut, dateFin) => invoke('rdv:list', dateDebut, dateFin),
  getRDVByPatient: (patientId) => invoke('rdv:byPatient', patientId),
  getRDVJour: (date) => invoke('rdv:jour', date),
  createRDV: (data) => invoke('rdv:create', data),
  updateRDV: (id, data) => invoke('rdv:update', id, data),
  deleteRDV: (id) => invoke('rdv:delete', id),
  updateStatutRDV: (id, statut) => invoke('rdv:status', id, statut),

  getPaiements: (filters) => invoke('paiements:list', filters),
  getPaiementsByPatient: (patientId) => invoke('paiements:byPatient', patientId),
  createPaiement: (data) => invoke('paiements:create', data),
  createPaiementFromRDV: (data) => invoke('paiements:fromRDV', data),
  getRapportCaisse: (periode) => invoke('paiements:rapport', periode),
  getProchainNumeroRecu: () => invoke('paiements:nextReceipt'),
  createDepense: (data) => invoke('depenses:create', data),
  getDepenses: (filters) => invoke('depenses:list', filters),
  getRapportDepenses: (periode) => invoke('depenses:rapport', periode),
  clearData: (password) => invoke('data:clear', password),

  getDocuments: (patientId) => invoke('documents:list', patientId),
  createDocument: (data) => invoke('documents:create', data),
  deleteDocument: (id) => invoke('documents:delete', id),
  uploadFichier: (patientId, filePath) => invoke('documents:upload', patientId, filePath),
  pickFile: () => invoke('dialog:pickFile'),
  pickLogo: () => invoke('dialog:pickLogo'),

  login: (login, password) => invoke('auth:login', login, password),
  logout: () => invoke('auth:logout'),
  getLoginUsers: () => invoke('auth:users'),
  getDashboard: () => invoke('dashboard:get'),
  getStatistiques: (options) => invoke('stats:get', options),

  getParametres: () => invoke('parametres:list'),
  setParametre: (cle, valeur) => invoke('parametres:set', cle, valeur),
  getUsers: () => invoke('users:list'),
  saveUser: (data) => invoke('users:save', data),
  createUser: (data) => invoke('users:create', data),
  updateUser: (id, data) => invoke('users:update', id, data),
  getMotifs: () => invoke('motifs:list'),
  getAllMotifs: () => invoke('motifs:all'),
  saveMotif: (data) => invoke('motifs:save', data),
  deleteMotif: (id) => invoke('motifs:delete', id),

  getActes: () => invoke('actes:list'),
  saveActe: (data) => invoke('actes:save', data),
  createActe: (data) => invoke('actes:create', data),
  updateActe: (id, data) => invoke('actes:update', id, data),
  deleteActe: (id) => invoke('actes:delete', id),

  getMessages: () => invoke('chat:list'),
  sendMessage: (message) => invoke('chat:send', message),
  markMessagesLu: () => invoke('chat:read'),
  sonnerAlarme: (data) => invoke('alarme:sonner', data),
  accuserAlarme: (data) => invoke('alarme:accuser', data),
  onSocketEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('socket:event', listener);
    return () => ipcRenderer.removeListener('socket:event', listener);
  },

  backupDB: () => invoke('dialog:backupDB'),
  restoreDB: () => invoke('dialog:restoreDB'),
  openDataFolder: () => invoke('dialog:openDataFolder'),
  openWhatsApp: (url) => invoke('system:openWhatsApp', url),
  listPrinters: () => invoke('printers:list'),
  silentPrint: (format) => invoke('print:silent', format),
  printImage: (dataUrl, format) => invoke('print:image', dataUrl, format),
  testPrint: () => invoke('print:test'),
  getLocalIP: () => invoke('system:localIP'),
  getAppVersion: () => invoke('system:version'),
  pickPhoto: () => invoke('dialog:pickPhoto'),
  maximize: () => invoke('window:maximize'),
  quit: () => invoke('app:quit'),

  // ── Module Algérie ──
  dz: (channel, ...args) => invoke(channel, ...args),
  dzCaisseStatut: (jour) => invoke('dz:caisse.statut', { jour }),
  dzCaisseCloturer: (billets, secretaire_nom) => invoke('dz:caisse.cloturer', { billets, secretaire_nom }),
  dzCaisseRapport: (periode) => invoke('dz:caisse.rapport', periode),
  dzActeCreate: (data) => invoke('dz:acte.create', data),
  dzPosologie: (poids_kg, code_medicament, duree_jours) => invoke('dz:posologie', { poids_kg, code_medicament, duree_jours }),
  dzDdiCheck: (codes) => invoke('dz:ddi.check', { codes }),
  dzEquivalents: (code) => invoke('dz:equivalents', code),
  dzAnppSearch: (q) => invoke('dz:anpp.search', q),
  dzTicketCreate: (data) => invoke('dz:ticket.create', data),
  dzFileList: () => invoke('dz:file.list'),
  dzTicketStatut: (ticket, statut, salle) => invoke('dz:ticket.statut', { ticket, statut, salle }),
  dzArretCreate: (data) => invoke('dz:arret.create', data),
  dzPsychoCreate: (data) => invoke('dz:psycho.create', data),
  dzCbvCreate: (data) => invoke('dz:cbv.create', data),
  dzMutuelleBon: (data) => invoke('dz:mutuelle.bon', data),
  dzMutuelleBordereau: (organisme, mois) => invoke('dz:mutuelle.bordereau', { organisme, mois }),
  dzWhatsapp: (telephone, template, langue, vars) => invoke('dz:whatsapp', { telephone, template, langue, vars }),
  dzIngest: (source, rows, dryRun) => invoke('dz:ingest', { source, rows, dryRun }),
  dzBackupChiffre: (passphrase, dossier) => invoke('dz:backup.chiffre', { passphrase, dossier }),
  dzPrintPayload: (kind, id) => invoke('dz:print.payload', { kind, id }),
  dzAuditVerify: () => invoke('dz:audit.verify'),

  // Licence
  guardStatus: () => invoke('guard:status'),
  guardBind: (token) => invoke('guard:bind', token),
  onGuardRecheck: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('guard:recheck', listener);
    return () => ipcRenderer.removeListener('guard:recheck', listener);
  },
});
