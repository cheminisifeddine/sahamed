'use strict';
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const fs = require('node:fs');
const path = require('node:path');
const dz = require('./dz.cjs');

const required = (value, field) => {
  if (value === undefined || value === null || String(value).trim() === '') throw new Error(`${field} est obligatoire`);
  return String(value).trim();
};
const nullable = (value) => (value === undefined || value === null || value === '' ? null : value);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function migrateLegacyBrandFolder(userDataPath) {
  try {
    const dbPath = path.join(userDataPath, 'sahamed.db');
    if (fs.existsSync(dbPath)) return;
    const parent = path.dirname(userDataPath);
    const legacy = path.join(parent, 'SahaMed');
    if (path.resolve(legacy) === path.resolve(userDataPath)) return;
    if (!fs.existsSync(path.join(legacy, 'sahamed.db'))) return;
    fs.mkdirSync(userDataPath, { recursive: true });
    for (const f of fs.readdirSync(legacy)) {
      const dst = path.join(userDataPath, f);
      if (!fs.existsSync(dst)) fs.copyFileSync(path.join(legacy, f), dst);
    }
    console.log('[Clinixos] Données migrées depuis', legacy);
  } catch (e) {
    console.warn('[Clinixos] Migration ancien dossier ignorée :', e.message);
  }
}

async function initDatabase(userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  migrateLegacyBrandFolder(userDataPath);
  const dbPath = path.join(userDataPath, 'sahamed.db');
  const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
  const SQL = await initSqlJs({ locateFile: (file) => path.join(wasmDir, file) });
  const dbBrute = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  const db = reparerReferencesUtilisateurs(SQL, dbBrute, dbPath);
  const store = createStore(db, dbPath);
  // Résilience coupures (délestages) : WAL + NORMAL + timeout + FK.
  // (sql.js rejoue ces PRAGMA à chaque ouverture ; le snapshot disque reste cohérent.)
  try { store.exec('PRAGMA journal_mode = WAL'); } catch {}
  try { store.exec('PRAGMA synchronous = NORMAL'); } catch {}
  try { store.exec('PRAGMA busy_timeout = 5000'); } catch {}
  store.exec('PRAGMA foreign_keys = ON');
  migrate(store);
  seed(store);
  attachQueries(store);
  store.save();
  return store;
}

// Repare les bases dont les tables filles pointent vers « users_old_role », une
// table de travail creee puis supprimee par une ancienne migration. Tant que cette
// reference morte subsiste, SQLite refuse toute suppression dans ces tables :
// impossible d'effacer un rendez-vous, une consultation ou un patient.
// On reecrit le schema, puis on rouvre la base pour qu'elle soit relue proprement.
function reparerReferencesUtilisateurs(SQL, db, dbPath) {
  try {
    const compte = (sql) => {
      const r = db.exec(sql);
      return r[0] ? r[0].values[0][0] : 0;
    };
    const tablesCassees = compte("SELECT COUNT(*) FROM sqlite_master WHERE sql LIKE '%users_old_role%'");
    if (!tablesCassees) return db;
    if (compte("SELECT COUNT(*) FROM sqlite_master WHERE name='users_old_role'")) return db;

    db.exec('PRAGMA writable_schema = ON');
    db.exec("UPDATE sqlite_master SET sql = replace(sql, 'users_old_role', 'users') WHERE sql LIKE '%users_old_role%'");
    db.exec('PRAGMA writable_schema = OFF');
    const octets = Buffer.from(db.export());
    db.close();
    fs.writeFileSync(dbPath, octets);
    console.log(`[Clinixos] Schema repare : ${tablesCassees} table(s) pointaient vers une table utilisateurs disparue.`);
    return new SQL.Database(octets);
  } catch (e) {
    console.warn('[Clinixos] Reparation du schema ignoree :', e.message);
    return db;
  }
}

function createStore(db, dbPath) {
  return {
    db,
    dbPath,
    services: {},
    exec(sql) {
      db.exec(sql);
    },
    run(sql, params = {}) {
      const stmt = db.prepare(sql);
      bind(stmt, params);
      stmt.step();
      stmt.free();
      // IMPORTANT : lire changes()/last_insert_rowid() AVANT save(). db.export() (appelé par
      // save()) réinitialise ces compteurs de connexion sql.js — les lire après renvoie toujours 0.
      const changes = db.getRowsModified();
      const lastInsertRowid = this.get('SELECT last_insert_rowid() AS id').id;
      this.save();
      return { changes, lastInsertRowid };
    },
    all(sql, params = {}) {
      const stmt = db.prepare(sql);
      bind(stmt, params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    get(sql, params = {}) {
      return this.all(sql, params)[0] || null;
    },
    save() {
      // Durabilité coupures : write + fsync avant de rendre la main.
      // Sans fsync, un délestage pendant le flush OS = base tronquée au reboot.
      const data = Buffer.from(db.export());
      const fd = fs.openSync(dbPath, 'w');
      try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  };
}

function bind(stmt, params) {
  if (Array.isArray(params)) stmt.bind(params);
  else stmt.bind(Object.fromEntries(Object.entries(params).map(([key, value]) => [key.startsWith('$') || key.startsWith('@') || key.startsWith(':') ? key : `@${key}`, value])));
}

function migrate(store) {
  store.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT NOT NULL, prenom TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('medecin','infirmiere')), login TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, actif INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS patients (id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT NOT NULL, prenom TEXT NOT NULL, date_naissance TEXT, sexe TEXT CHECK(sexe IN ('M','F')), telephone TEXT, telephone2 TEXT, email TEXT, adresse TEXT, ville TEXT, wilaya TEXT, numero_securite TEXT, mutuelle TEXT, groupe_sanguin TEXT, allergies TEXT, antecedents TEXT, notes TEXT, photo_path TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS consultations (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id), date_consultation TEXT DEFAULT (datetime('now')), motif TEXT, anamnese TEXT, examen_clinique TEXT, diagnostic TEXT, traitement TEXT, observations TEXT, tension TEXT, poids REAL, taille REAL, temperature REAL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS ordonnances (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE, consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL, user_id INTEGER NOT NULL REFERENCES users(id), date_ordonnance TEXT DEFAULT (datetime('now')), contenu TEXT NOT NULL, pdf_path TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE, type TEXT NOT NULL, titre TEXT NOT NULL, contenu TEXT, fichier_path TEXT, date_document TEXT DEFAULT (datetime('now')), created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS rdv (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL, nom_patient_libre TEXT, telephone_libre TEXT, date_rdv TEXT NOT NULL, heure_debut TEXT NOT NULL, heure_fin TEXT NOT NULL, motif TEXT, statut TEXT DEFAULT 'planifie' CHECK(statut IN ('planifie','confirme','annule','effectue','absent')), couleur TEXT DEFAULT '#3B82F6', notes TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS actes (id INTEGER PRIMARY KEY AUTOINCREMENT, libelle TEXT NOT NULL, tarif REAL NOT NULL DEFAULT 0, actif INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS paiements (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL, consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL, rdv_id INTEGER REFERENCES rdv(id) ON DELETE SET NULL, acte_id INTEGER REFERENCES actes(id) ON DELETE SET NULL, montant REAL NOT NULL, mode_paiement TEXT DEFAULT 'especes' CHECK(mode_paiement IN ('especes','cheque','virement','ccp','autre')), date_paiement TEXT DEFAULT (datetime('now')), remarque TEXT, created_by INTEGER REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS messages_chat (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), message TEXT NOT NULL, lu INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS parametres (cle TEXT PRIMARY KEY, valeur TEXT);
    CREATE TABLE IF NOT EXISTS medicaments (id INTEGER PRIMARY KEY AUTOINCREMENT, nom_commercial TEXT NOT NULL, dci TEXT, forme TEXT, dosage TEXT, classe TEXT, fabricant TEXT, actif INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS depenses (id INTEGER PRIMARY KEY AUTOINCREMENT, montant REAL NOT NULL, categorie TEXT NOT NULL DEFAULT 'autre', mode_paiement TEXT DEFAULT 'especes', date_depense TEXT DEFAULT (datetime('now')), description TEXT, fournisseur TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS motifs (id INTEGER PRIMARY KEY AUTOINCREMENT, libelle TEXT NOT NULL, couleur TEXT DEFAULT '#3B82F6', ordre INTEGER DEFAULT 0, actif INTEGER DEFAULT 1);
  `);
  addColumn(store, 'users', 'specialite', 'TEXT');
  addColumn(store, 'users', 'telephone', 'TEXT');
  addColumn(store, 'patients', 'antecedents_familiaux', 'TEXT');
  addColumn(store, 'patients', 'traitement_en_cours', 'TEXT');
  addColumn(store, 'consultations', 'rdv_id', 'INTEGER REFERENCES rdv(id)');
  addColumn(store, 'consultations', 'tension_systolique', 'INTEGER');
  addColumn(store, 'consultations', 'tension_diastolique', 'INTEGER');
  addColumn(store, 'consultations', 'pouls', 'INTEGER');
  addColumn(store, 'consultations', 'saturation', 'INTEGER');
  addColumn(store, 'consultations', 'glycemie', 'REAL');
  addColumn(store, 'consultations', 'imc', 'REAL');
  addColumn(store, 'consultations', 'cim10_code', 'TEXT');
  addColumn(store, 'consultations', 'instructions', 'TEXT');
  addColumn(store, 'consultations', 'prochain_rdv_dans', 'INTEGER');
  addColumn(store, 'consultations', 'duree_minutes', 'INTEGER DEFAULT 20');
  addColumn(store, 'consultations', 'updated_at', "TEXT DEFAULT (datetime('now'))");
  addColumn(store, 'ordonnances', 'lignes', 'TEXT');
  addColumn(store, 'ordonnances', 'notes_pharmacien', 'TEXT');
  addColumn(store, 'ordonnances', 'numero', 'TEXT');
  store.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ordonnance_numero ON ordonnances(numero) WHERE numero IS NOT NULL');
  addColumn(store, 'documents', 'consultation_id', 'INTEGER REFERENCES consultations(id)');
  addColumn(store, 'documents', 'numero', 'TEXT');
  addColumn(store, 'rdv', 'updated_at', "TEXT DEFAULT (datetime('now'))");
  addColumn(store, 'actes', 'code', 'TEXT');
  addColumn(store, 'actes', 'categorie', "TEXT DEFAULT 'consultation'");
  addColumn(store, 'paiements', 'recu_numero', 'TEXT');
  addColumn(store, 'messages_chat', 'type', "TEXT DEFAULT 'text'");
  addColumn(store, 'patients', 'code_patient', 'TEXT');
  addColumn(store, 'patients', 'taille', 'REAL');
  addColumn(store, 'patients', 'poids', 'REAL');
  addColumn(store, 'consultations', 'acte_id', 'INTEGER REFERENCES actes(id)');
  addColumn(store, 'consultations', 'montant_prevu', 'REAL');
  migrateUsersRoleAndPerms(store);
  addColumn(store, 'users', 'permissions', 'TEXT');
  addColumn(store, 'users', 'specialite', 'TEXT');
  addColumn(store, 'users', 'telephone', 'TEXT');
  store.exec(`DELETE FROM medicaments WHERE id NOT IN (SELECT MIN(id) FROM medicaments GROUP BY nom_commercial, dosage, forme)`);
  store.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_med_uniq ON medicaments(nom_commercial, dosage, forme)');
  migratePaiementsMode(store);
  nettoyerMentionsMigration(store);
  corrigerDatesConsultationsAberrantes(store);
  // Apres les corrections de dates : une ordonnance redatee doit etre numerotee
  // dans la bonne annee.
  numeroterOrdonnancesExistantes(store);

  // Index de performance — cabinets avec un gros volume de donnees (migration depuis un
  // ancien logiciel notamment) : evite un scan complet des tables a chaque recherche/ouverture
  // de dossier patient.
  store.exec(`
    CREATE INDEX IF NOT EXISTS idx_patients_nom ON patients(nom, prenom);
    CREATE INDEX IF NOT EXISTS idx_patients_code ON patients(code_patient);
    CREATE INDEX IF NOT EXISTS idx_patients_tel ON patients(telephone);
    CREATE INDEX IF NOT EXISTS idx_patients_updated ON patients(updated_at);
    CREATE INDEX IF NOT EXISTS idx_consultations_patient ON consultations(patient_id);
    CREATE INDEX IF NOT EXISTS idx_ordonnances_patient ON ordonnances(patient_id);
    CREATE INDEX IF NOT EXISTS idx_documents_patient ON documents(patient_id);
    CREATE INDEX IF NOT EXISTS idx_rdv_patient ON rdv(patient_id);
    CREATE INDEX IF NOT EXISTS idx_rdv_date ON rdv(date_rdv);
    CREATE INDEX IF NOT EXISTS idx_paiements_patient ON paiements(patient_id);
  `);
  // ── Module Algérie (caisse aveugle, ANPP, file d'attente, médico-légal…) ──
  dz.migrateDZ(store);
}

// Les donnees reprises d'un ancien logiciel portaient un marqueur technique
// « (migration) », visible par l'utilisateur dans les motifs de consultation, les
// notes patient et les certificats. On l'efface une fois pour toutes ; l'operation
// est idempotente (plus rien a mettre a jour une fois la base nettoyee).
function nettoyerMentionsMigration(store) {
  try {
    const reste = store.db.exec(
      "SELECT 1 FROM consultations WHERE motif LIKE '%(migration)%' "
      + "UNION ALL SELECT 1 FROM patients WHERE notes LIKE '%(migration)%' "
      + "UNION ALL SELECT 1 FROM documents WHERE contenu LIKE '%(migration)%' LIMIT 1"
    );
    if (!reste.length) return;
    store.db.run('BEGIN TRANSACTION');
    // « Historique (migration) » -> « Historique » ; « Profession (migration) : X » -> « Profession : X »
    store.db.run("UPDATE consultations SET motif = trim(replace(motif, ' (migration)', '')) WHERE motif LIKE '%(migration)%'");
    store.db.run("UPDATE patients SET notes = trim(replace(notes, ' (migration)', '')) WHERE notes LIKE '%(migration)%'");
    store.db.run("UPDATE documents SET contenu = trim(replace(contenu, ' (migration)', '')) WHERE contenu LIKE '%(migration)%'");
    // Filet de securite si le marqueur n'etait pas precede d'une espace
    store.db.run("UPDATE consultations SET motif = trim(replace(motif, '(migration)', '')) WHERE motif LIKE '%(migration)%'");
    store.db.run("UPDATE patients SET notes = trim(replace(notes, '(migration)', '')) WHERE notes LIKE '%(migration)%'");
    store.db.run("UPDATE documents SET contenu = trim(replace(contenu, '(migration)', '')) WHERE contenu LIKE '%(migration)%'");
    store.db.run('COMMIT');
    console.log('[Clinixos] Mentions « (migration) » supprimees des donnees reprises.');
  } catch (e) {
    try { store.db.run('ROLLBACK'); } catch {}
    console.warn('[Clinixos] Nettoyage des mentions de migration ignore :', e.message);
  }
}

// Quelques consultations reprises de l'ancien logiciel portent une annee saisie de
// travers (0018, 2200, 2202, 1024, 2033, 2029). L'annee reelle a ete retablie a partir
// de la position chronologique de la visite dans le dossier source : la liste
// d'antecedents de l'ancien logiciel est ordonnee dans le temps, donc les visites
// voisines encadrent l'annee. Seuls les cas certains figurent ici.
// Une correction n'est appliquee que si UNE SEULE ligne correspond exactement
// (meme date erronee + meme nom de patient) ; sinon on ne touche a rien.
const DATES_A_CORRIGER = [
  { nom: 'BENKETFI',    de: '0018-09-22', vers: '2018-09-22' },
  { nom: 'BOUZIDI',     de: '2200-10-11', vers: '2020-10-11' },
  { nom: 'BOULAADJOUL', de: '2033-10-28', vers: '2023-10-28' },
  { nom: 'HADJ',        de: '1024-10-10', vers: '2024-10-10' },
  { nom: 'BAIT',        de: '2202-03-15', vers: '2022-03-15' },
  { nom: 'SIFI',        de: '2029-01-27', vers: '2026-01-27' },
  { nom: 'CHAFER',      de: '2202-12-22', vers: '2022-12-22' },
  { nom: 'BENALILECHE', de: '2202-01-09', vers: '2022-01-09' },
];

// Meme travail pour les ordonnances. Cas etabli : l'ordonnance n° 2117 de l'ancien
// logiciel etait datee 19/12/2201. La numerotation d'origine etant chronologique,
// elle se place entre le 05/11/2018 (n° 2116) et le 06/11/2018 (n° 2118), et le
// registre des visites de la patiente porte justement une visite le 06/11/2018
// sans ordonnance rattachee.
const DATES_ORDONNANCES_A_CORRIGER = [
  { nom: 'BENHAMLET', de: '2201-12-19', vers: '2018-11-06' },
];

// Consultations dont l'annee saisie etait impossible : le registre des passages de
// l'ancien logiciel donne la date reelle. Dans neuf cas sur dix le jour et le mois
// sont identiques a la saisie — seule l'annee etait fautive. La visite figurant
// deja au registre, on lui rattache la note plutot que de garder deux lignes.
const DATES_A_RETABLIR = [
  { code: 'P-22439', vers: '2024-02-27' }, // AOUINA Kaouthar      27/02 identique
  { code: 'P-20881', vers: '2023-03-29' }, // AZIOUENE Abbes       29/03 identique
  { code: 'P-02052', vers: '2026-07-25' }, // BENABET Anfel        25/07 identique
  { code: 'P-01524', vers: '2026-03-29' }, // BOUHALI Hedda        29/03 identique
  { code: 'P-04025', vers: '2021-07-06' }, // DJEBIR Abdelaziz     06/07 identique
  { code: 'P-13125', vers: '2026-07-12' }, // HAFIANE Abderahmane  12/07 identique
  { code: 'P-11815', vers: '2024-05-29' }, // KENANA Ahmed         29/05 identique
  { code: 'P-01629', vers: '2024-07-08' }, // MEDKOUR Kharfia      08/07 identique
  { code: 'P-03472', vers: '2019-02-09' }, // MIMOUNI Nouari       09/02 identique
  { code: 'P-01664', vers: '2021-03-17' }, // BENATHMANE Abdelhamid — seule visite libre du dossier
];

// Une ANNEE est impossible si elle est anterieure a 1950 ou posterieure a l'annee en
// cours. On raisonne sur l'annee et non sur la date complete : une consultation datee
// de quelques semaines dans le futur (mois saisi de travers) est une anomalie d'un
// autre genre, qu'on ne touche pas ici.
const OU_ANNEE_IMPOSSIBLE = `(
  CAST(substr(c.date_consultation,1,4) AS INT) < 1950
  OR CAST(substr(c.date_consultation,1,4) AS INT) > CAST(strftime('%Y','now') AS INT)
)`;

function corrigerDatesConsultationsAberrantes(store) {
  try {
    // Les deux traitements ne concernent que les dossiers repris d'un ancien logiciel.
    // On les reconnait a leur code patient : « P- » suivi de 5 chiffres exactement, alors
    // qu'un patient cree dans l'application porte « P-AAAAMM-XXXX ». Chez un cabinet qui
    // n'a pas repris d'historique, rien ne s'applique.
    const aTraiter = store.all(
      `SELECT 1 FROM consultations c JOIN patients p ON p.id = c.patient_id
       WHERE p.code_patient GLOB 'P-[0-9][0-9][0-9][0-9][0-9]' AND c.date_consultation IS NOT NULL
         AND ${OU_ANNEE_IMPOSSIBLE} LIMIT 1`
    );
    const ordonnancesATraiter = store.all(
      `SELECT 1 FROM ordonnances o WHERE substr(o.date_ordonnance,1,10) IN (${DATES_ORDONNANCES_A_CORRIGER.map(() => '?').join(',') || "''"}) LIMIT 1`,
      DATES_ORDONNANCES_A_CORRIGER.map((c) => c.de)
    );
    // Troisieme cas : des consultations attendent encore leur date. Sans ce test,
    // la fonction sortait des que les annees impossibles avaient ete traitees, et
    // le retablissement des dates n'etait jamais atteint.
    const aRetablir = store.all(
      `SELECT 1 FROM consultations c JOIN patients p ON p.id = c.patient_id
       WHERE c.date_consultation IS NULL
         AND p.code_patient IN (${DATES_A_RETABLIR.map(() => '?').join(',')}) LIMIT 1`,
      DATES_A_RETABLIR.map((r) => r.code)
    );
    if (!aTraiter.length && !ordonnancesATraiter.length && !aRetablir.length) return;

    // 1. Les dates dont l'annee reelle a pu etre retablie avec certitude.
    let corrigees = 0;
    for (const c of DATES_A_CORRIGER) {
      const lignes = store.all(
        `SELECT c.id FROM consultations c JOIN patients p ON p.id = c.patient_id
         WHERE substr(c.date_consultation,1,10) = ? AND p.nom LIKE ? AND p.code_patient GLOB 'P-[0-9][0-9][0-9][0-9][0-9]'`,
        [c.de, c.nom + '%']
      );
      if (lignes.length !== 1) continue; // ambigu ou deja corrige : on s'abstient
      store.db.run('UPDATE consultations SET date_consultation = ? WHERE id = ?', [c.vers, lignes[0].id]);
      corrigees++;
    }

    // 1 bis. Ordonnances : meme principe. On remet aussi le numero a blanc pour
    // qu'il soit reattribue dans la bonne annee par la numerotation.
    for (const c of DATES_ORDONNANCES_A_CORRIGER) {
      const lignes = store.all(
        `SELECT o.id FROM ordonnances o JOIN patients p ON p.id = o.patient_id
         WHERE substr(o.date_ordonnance,1,10) = ? AND p.nom LIKE ? AND p.code_patient GLOB 'P-[0-9][0-9][0-9][0-9][0-9]'`,
        [c.de, c.nom + '%']
      );
      if (lignes.length !== 1) continue;
      store.db.run('UPDATE ordonnances SET date_ordonnance = ?, numero = NULL WHERE id = ?', [c.vers, lignes[0].id]);
      corrigees++;
    }

    // 2. Les autres : l'annee est definitivement perdue (le medecin ne s'en souvient
    // pas, et la visite n'a pas de voisine pour l'encadrer). On vide la date plutot
    // que de laisser une date fausse — la consultation et sa note restent dans le
    // dossier, affichees « Date inconnue ».
    const aVider = store.all(
      `SELECT c.id FROM consultations c JOIN patients p ON p.id = c.patient_id
       WHERE p.code_patient GLOB 'P-[0-9][0-9][0-9][0-9][0-9]' AND c.date_consultation IS NOT NULL
         AND ${OU_ANNEE_IMPOSSIBLE}`
    );
    aVider.forEach((l) => store.db.run('UPDATE consultations SET date_consultation = NULL WHERE id = ?', [l.id]));

    // 3. Retablir une date reelle sur les consultations restees sans date, a partir
    // du registre des passages. La visite ayant deja ete reprise comme ligne datee
    // sans note, on la supprime pour ne pas laisser deux lignes le meme jour.
    let retablies = 0;
    for (const r of DATES_A_RETABLIR) {
      const lignes = store.all(
        `SELECT c.id, c.patient_id FROM consultations c JOIN patients p ON p.id = c.patient_id
         WHERE p.code_patient = ? AND c.date_consultation IS NULL`,
        [r.code]
      );
      if (lignes.length !== 1) continue;
      const { id, patient_id } = lignes[0];
      store.db.run(
        `DELETE FROM consultations
         WHERE patient_id = ? AND id != ? AND substr(date_consultation,1,10) = ?
           AND (motif IS NULL OR motif = '') AND (diagnostic IS NULL OR diagnostic = '')`,
        [patient_id, id, r.vers]
      );
      store.db.run('UPDATE consultations SET date_consultation = ? WHERE id = ?', [r.vers, id]);
      retablies++;
    }

    if (corrigees || aVider.length || retablies) {
      store.save();
      console.log(`[Clinixos] Dates reprises : ${corrigees} corrigee(s), ${aVider.length} videe(s), ${retablies} retablie(s) depuis le registre.`);
    }
  } catch (e) {
    console.warn('[Clinixos] Correction des dates aberrantes ignoree :', e.message);
  }
}

function seed(store) {
  store.db.run('BEGIN TRANSACTION');
  try {
    [
      ['cabinet_nom', 'Cabinet Médical'], ['cabinet_adresse', ''], ['cabinet_telephone', ''], ['cabinet_medecin', 'Administrateur'],
      ['cabinet_specialite', 'Médecine Générale'], ['duree_rdv_defaut', '15'], ['heure_debut', '08:00'], ['heure_fin', '17:00'],
      ['mode_reseau', 'serveur'], ['ip_serveur', ''], ['port_socket', '3001'], ['app_nom', 'Clinixos'], ['verrouillage_minutes', '60']
    ].forEach((row) => store.db.run('INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?, ?)', row));
    try { store.db.run("UPDATE parametres SET valeur = 'Clinixos' WHERE cle = 'app_nom' AND valeur = 'SahaMed'"); } catch {}

    [
      ['CS', 'Consultation générale', 1000, 'consultation'],
      ['CSP', 'Consultation spécialisée', 2000, 'consultation'],
      ['ECG', 'Électrocardiogramme', 500, 'acte_technique'],
      ['INJS', 'Injection sous-cutanée', 300, 'acte_technique'],
      ['INJIM', 'Injection intramusculaire', 300, 'acte_technique'],
      ['INJIV', 'Injection intraveineuse', 500, 'acte_technique'],
      ['PANS', 'Pansement simple', 300, 'acte_technique'],
      ['PANSC', 'Pansement complexe', 600, 'acte_technique'],
      ['CERTIF', 'Certificat médical', 500, 'document'],
      ['ARRET', 'Arrêt de travail', 300, 'document']
    ].forEach((row) => store.db.run('INSERT OR IGNORE INTO actes (code, libelle, tarif, categorie) VALUES (?, ?, ?, ?)', row));

    [
      ['Consultation générale',          '#3B82F6', 1],
      ['Consultation de suivi',          '#0E7490', 2],
      ['Urgence',                        '#DC2626', 3],
      ['Certificat médical',             '#7C3AED', 4],
      ['Vaccination',                    '#16A34A', 5],
      ['Bilan de santé',                 '#0F766E', 6],
      ['Renouvellement ordonnance',      '#B45309', 7],
      ['Consultation pédiatrique',       '#1D4ED8', 8],
      ['Acte technique',                 '#9D174D', 9],
    ].forEach((row) => store.db.run('INSERT OR IGNORE INTO motifs (libelle, couleur, ordre) VALUES (?, ?, ?)', row));

    store.db.run('COMMIT');
  } catch (e) {
    store.db.run('ROLLBACK');
    throw e;
  }

  const admin = store.get('SELECT id, password_hash FROM users WHERE login = ?', ['admin']);
  if (!admin) {
    store.run('INSERT INTO users (nom, prenom, role, login, password_hash, specialite, telephone) VALUES (?, ?, ?, ?, ?, ?, ?)', ['Administrateur', '', 'medecin', 'admin', hashPassword('admin'), 'Médecine Générale', '']);
  } else if (bcrypt.compareSync('admin123', admin.password_hash)) {
    store.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword('admin'), admin.id]);
  }
  // Accueil / réception : profil Secrétaire visible sur l'écran de connexion (avec admin).
  const secretaire = store.get('SELECT id FROM users WHERE login = ?', ['secretaire']);
  if (!secretaire) {
    store.run(
      'INSERT INTO users (nom, prenom, role, login, password_hash, actif, specialite, telephone, permissions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['Réception', '', 'secretaire', 'secretaire', hashPassword('secretaire'), 1, null, null,
        JSON.stringify(['dashboard', 'patients', 'planning', 'caisse', 'chat'])]
    );
  }
  seedMedicaments(store);
  dz.seedDZ(store);
}

function addColumn(store, table, column, definition) {
  const columns = store.all(`PRAGMA table_info(${table})`).map((item) => item.name);
  if (!columns.includes(column)) {
    store.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrateUsersRoleAndPerms(store) {
  const meta = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
  if (!meta?.sql || !meta.sql.includes("CHECK(role IN")) return;
  store.exec('PRAGMA foreign_keys = OFF');
  // Depuis SQLite 3.25, ALTER TABLE ... RENAME reecrit aussi les references des
  // AUTRES tables : sans ce mode, les six tables filles se mettaient a pointer vers
  // « users_old_role », aussitot supprimee — et plus aucune suppression n'etait
  // possible dans l'application.
  store.exec('PRAGMA legacy_alter_table = ON');
  store.exec(`
    ALTER TABLE users RENAME TO users_old_role;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nom TEXT NOT NULL,
      prenom TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'medecin',
      login TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      actif INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO users (id, nom, prenom, role, login, password_hash, actif, created_at)
      SELECT id, nom, prenom, role, login, password_hash, actif, created_at FROM users_old_role;
    DROP TABLE users_old_role;
  `);
  store.exec('PRAGMA legacy_alter_table = OFF');
  store.exec('PRAGMA foreign_keys = ON');
}

function migratePaiementsMode(store) {
  const meta = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='paiements'");
  if (!meta?.sql || meta.sql.includes("'ccp'")) return;
  store.exec(`
    ALTER TABLE paiements RENAME TO paiements_old;
    CREATE TABLE paiements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER REFERENCES patients(id),
      consultation_id INTEGER REFERENCES consultations(id),
      rdv_id INTEGER REFERENCES rdv(id),
      acte_id INTEGER REFERENCES actes(id),
      montant REAL NOT NULL,
      mode_paiement TEXT DEFAULT 'especes' CHECK(mode_paiement IN ('especes','cheque','virement','ccp','autre')),
      date_paiement TEXT DEFAULT (datetime('now')),
      remarque TEXT,
      recu_numero TEXT,
      created_by INTEGER REFERENCES users(id)
    );
    INSERT INTO paiements (id, patient_id, consultation_id, rdv_id, acte_id, montant, mode_paiement, date_paiement, remarque, recu_numero, created_by)
    SELECT id, patient_id, consultation_id, rdv_id, acte_id, montant,
      CASE WHEN mode_paiement='carte' THEN 'autre' ELSE mode_paiement END,
      date_paiement, remarque, recu_numero, created_by
    FROM paiements_old;
    DROP TABLE paiements_old;
  `);
  store.save();
}

function generateCodePatient(store) {
  const now = new Date();
  const prefix = `P-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const count = store.get('SELECT COUNT(*) AS n FROM patients WHERE code_patient LIKE ?', [`${prefix}%`]).n;
  return `${prefix}-${String(count + 1).padStart(4, '0')}`;
}

/* ─── Numerotation des ordonnances ──────────────────────────────────
   Une ordonnance est une piece medico-legale : elle porte un numero unique,
   sequentiel, remis a zero chaque annee — format « 000025/2026 ».

   On calcule le numero a partir du MAXIMUM deja attribue dans l'annee, et non
   d'un COUNT : supprimer une ordonnance ne doit jamais permettre de reattribuer
   un numero deja imprime. Un index unique garantit l'absence de doublon meme en
   cas d'incident. */
function formaterNumeroOrdonnance(sequence, annee) {
  return `${String(sequence).padStart(6, '0')}/${annee}`;
}

function genererNumeroOrdonnance(store, date) {
  const annee = String(date || '').slice(0, 4).match(/^\d{4}$/)
    ? String(date).slice(0, 4)
    : String(new Date().getFullYear());
  const row = store.get(
    `SELECT MAX(CAST(substr(numero, 1, 6) AS INTEGER)) AS max FROM ordonnances
     WHERE numero LIKE ?`,
    [`%/${annee}`]
  );
  return formaterNumeroOrdonnance((row && row.max ? row.max : 0) + 1, annee);
}

// Rattrapage unique : les ordonnances deja en base (reprises d'un ancien logiciel
// ou creees avant la numerotation) recoivent leur numero, annee par annee, dans
// l'ordre chronologique.
function numeroterOrdonnancesExistantes(store) {
  try {
    const manquantes = store.all(
      `SELECT id, COALESCE(substr(date_ordonnance, 1, 4), ?) AS annee
       FROM ordonnances WHERE numero IS NULL OR numero = ''
       ORDER BY date_ordonnance, id`,
      [String(new Date().getFullYear())]
    );
    if (!manquantes.length) return;

    // Point de depart par annee : le plus grand numero deja attribue.
    const compteurs = new Map();
    store.all("SELECT substr(numero, 8, 4) AS annee, MAX(CAST(substr(numero, 1, 6) AS INTEGER)) AS max FROM ordonnances WHERE numero IS NOT NULL AND numero != '' GROUP BY annee")
      .forEach((r) => compteurs.set(String(r.annee), Number(r.max) || 0));

    store.db.run('BEGIN TRANSACTION');
    for (const o of manquantes) {
      const annee = /^\d{4}$/.test(String(o.annee)) ? String(o.annee) : String(new Date().getFullYear());
      const suivant = (compteurs.get(annee) || 0) + 1;
      compteurs.set(annee, suivant);
      store.db.run('UPDATE ordonnances SET numero = ? WHERE id = ?', [formaterNumeroOrdonnance(suivant, annee), o.id]);
    }
    store.db.run('COMMIT');
    store.save();
    console.log(`[Clinixos] ${manquantes.length} ordonnance(s) numerotee(s).`);
  } catch (e) {
    try { store.db.run('ROLLBACK'); } catch {}
    console.warn('[Clinixos] Numerotation des ordonnances ignoree :', e.message);
  }
}

function attachQueries(store) {
  const s = store.services;
  s.listLoginUsers = () => store.all('SELECT id, nom, prenom, role, login, actif FROM users ORDER BY actif DESC, nom, prenom');
  s.login = (login, password) => {
    const user = store.get('SELECT * FROM users WHERE login = ? AND actif = 1', [required(login, 'Login')]);
    if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) throw new Error('Identifiants invalides');
    const { password_hash, ...safeUser } = user;
    return safeUser;
  };
  // Construit la clause WHERE + parametres partages entre listPatients et countPatients,
  // avec recherche par mots-cles insensible a l'ordre (voir listPatients).
  function patientsFilterClause(filters) {
    const isObj = filters !== null && typeof filters === 'object';
    const search = isObj ? filters.search || '' : (filters ?? '');
    const sexe = isObj ? filters.sexe || '' : '';
    const tel = isObj ? filters.telephone || '' : '';
    const groupe = isObj ? filters.groupe_sanguin || '' : '';
    const telLike = tel ? `%${tel}%` : '';
    const tokens = String(search || '').trim().split(/\s+/).filter(Boolean);

    // Un numero d'ordonnance (« 004906/2026 ») scanne dans la recherche doit ramener
    // le patient concerne : c'est le code-barres imprime sur l'ordonnance, et le
    // reflexe naturel est de le scanner pour retrouver le dossier.
    const estNumeroOrdonnance = (t) => /^\d{1,6}\/\d{4}$/.test(t);
    const morceaux = [];
    const tokenParams = [];
    for (const t of tokens) {
      if (estNumeroOrdonnance(t)) {
        morceaux.push('(EXISTS (SELECT 1 FROM ordonnances o WHERE o.patient_id = patients.id AND o.numero = ?))');
        tokenParams.push(t.padStart(11, '0'));
      } else {
        morceaux.push('(nom LIKE ? OR prenom LIKE ? OR telephone LIKE ? OR telephone2 LIKE ? OR wilaya LIKE ? OR code_patient LIKE ?)');
        tokenParams.push(...likeParams(t, 6));
      }
    }
    const tokenClause = morceaux.length ? morceaux.join(' AND ') : '1=1';
    return {
      where: `${tokenClause} AND (? = '' OR sexe = ?) AND (? = '' OR telephone LIKE ? OR telephone2 LIKE ?) AND (? = '' OR groupe_sanguin = ?)`,
      params: [...tokenParams, sexe, sexe, telLike, telLike, telLike, groupe, groupe],
    };
  }
  s.listPatients = (filters = '') => {
    if (filters === null || filters === undefined) filters = '';
    const isObj = typeof filters === 'object' && filters !== null;
    const limit = Number(isObj ? filters.limit || 200 : 200);
    const offset = Number(isObj ? filters.offset || 0 : 0);
    const { where, params } = patientsFilterClause(filters);
    return store.all(`
    SELECT *, CAST((julianday('now') - julianday(date_naissance)) / 365.25 AS INTEGER) AS age FROM patients
    WHERE ${where}
    ORDER BY updated_at DESC, nom ASC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);
  };
  s.countPatients = (filters = '') => {
    const { where, params } = patientsFilterClause(filters);
    return store.get(`SELECT COUNT(*) AS total FROM patients WHERE ${where}`, params).total;
  };
  s.getPatientStats = (id) => ({
    nbConsultations: store.get('SELECT COUNT(*) AS total FROM consultations WHERE patient_id=?', [id]).total,
    nbRDV: store.get('SELECT COUNT(*) AS total FROM rdv WHERE patient_id=?', [id]).total,
    totalPaye: store.get('SELECT COALESCE(SUM(montant),0) AS total FROM paiements WHERE patient_id=?', [id]).total
  });
  // Un seul aller-retour IPC pour tout le necessaire a l'ouverture d'un dossier patient
  // (evite 6-7 appels sequentiels, chacun avec son cout fixe d'IPC).
  s.getPatientDossier = (id) => ({
    patient: s.getPatient(id),
    consultations: s.listConsultations(id),
    ordonnances: s.listOrdonnances(id),
    documents: s.listDocuments(id),
    rdv: s.listRDVByPatient(id),
    paiements: s.listPaiementsByPatient(id),
    stats: s.getPatientStats(id),
  });
  // Recherche « intelligente », comme celle des patients : chaque mot saisi est
  // cherche separement et doit se retrouver quelque part dans la fiche. « amox
  // 1g » et « 1g amox » ramenent donc la meme chose, et les noms qui commencent
  // par le premier mot remontent en tete.
  s.searchMedicaments = (query = '') => {
    const mots = String(query || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!mots.length) {
      return store.all("SELECT * FROM medicaments WHERE actif = 1 ORDER BY nom_commercial, dosage LIMIT 100");
    }
    const clauses = [];
    const params = [];
    for (const mot of mots) {
      const q = `%${mot}%`;
      clauses.push('(nom_commercial LIKE ? OR dci LIKE ? OR classe LIKE ? OR fabricant LIKE ? OR dosage LIKE ? OR forme LIKE ?)');
      params.push(q, q, q, q, q, q);
    }
    return store.all(`
      SELECT * FROM medicaments
      WHERE actif = 1 AND ${clauses.join(' AND ')}
      ORDER BY CASE WHEN nom_commercial LIKE ? THEN 0 ELSE 1 END, nom_commercial, dosage
      LIMIT 100
    `, [...params, `${mots[0]}%`]);
  };
  s.getMedicamentDosages = (nom) => store.all('SELECT DISTINCT dosage, forme FROM medicaments WHERE nom_commercial = ? AND actif = 1 ORDER BY dosage', [nom]);
  s.listMedicaments = (filters = {}) => {
    const search = filters.search || '';
    const classe = filters.classe || '';
    const actif = filters.actif !== undefined && filters.actif !== '' ? Number(filters.actif) : null;
    const q = `%${String(search).trim()}%`;
    let sql = 'SELECT * FROM medicaments WHERE 1=1';
    const params = [];
    if (search) { sql += ' AND (nom_commercial LIKE ? OR dci LIKE ? OR classe LIKE ? OR fabricant LIKE ?)'; params.push(q, q, q, q); }
    if (classe) { sql += ' AND classe = ?'; params.push(classe); }
    if (actif !== null) { sql += ' AND actif = ?'; params.push(actif); }
    // Pas de plafond a 1000 : un cabinet qui reprend sa liste de prescription d'un
    // ancien logiciel depasse facilement ce chiffre, et l'ecran affichait alors un
    // total faux sans rien signaler. La pagination se fait cote ecran.
    sql += ' ORDER BY nom_commercial, dosage';
    return store.all(sql, params);
  };
  s.listMedicamentClasses = () => store.all("SELECT DISTINCT classe FROM medicaments WHERE classe IS NOT NULL AND classe != '' ORDER BY classe");
  s.createMedicament = (data) => {
    const info = store.run('INSERT OR IGNORE INTO medicaments (nom_commercial,dci,forme,dosage,classe,fabricant,actif) VALUES (?,?,?,?,?,?,?)', [data.nom_commercial || '', data.dci || '', data.forme || '', data.dosage || '', data.classe || '', data.fabricant || '', data.actif !== undefined ? Number(data.actif) : 1]);
    return { id: info.lastInsertRowid };
  };
  s.updateMedicament = (id, data) => {
    store.run('UPDATE medicaments SET nom_commercial=?,dci=?,forme=?,dosage=?,classe=?,fabricant=?,actif=? WHERE id=?', [data.nom_commercial, data.dci || '', data.forme || '', data.dosage || '', data.classe || '', data.fabricant || '', data.actif ? 1 : 0, id]);
    return store.get('SELECT * FROM medicaments WHERE id=?', [id]);
  };
  s.deleteMedicament = (id) => store.run('DELETE FROM medicaments WHERE id=?', [id]).changes > 0;
  s.getPatient = (id) => store.get('SELECT * FROM patients WHERE id = ?', [id]);
  s.createPatient = (data) => {
    const code = generateCodePatient(store);
    const payload = { ...patientPayload(data), code_patient: code };
    const info = store.run(`INSERT INTO patients (${Object.keys(payload).join(',')}) VALUES (${Object.keys(payload).map((k) => `@${k}`).join(',')})`, payload);
    return { id: info.lastInsertRowid, ...payload };
  };
  s.updatePatient = (id, data) => {
    const payload = patientPayload(data);
    store.run(`UPDATE patients SET ${Object.keys(payload).map((k) => `${k}=@${k}`).join(',')}, updated_at=datetime('now') WHERE id=@id`, { ...payload, id });
    return s.getPatient(id);
  };
  s.deletePatient = (id) => store.run('DELETE FROM patients WHERE id = ?', [id]).changes > 0;
  s.listConsultations = (patientId) => store.all(`SELECT c.*, u.nom || ' ' || u.prenom AS praticien FROM consultations c JOIN users u ON u.id=c.user_id WHERE c.patient_id=? ORDER BY c.date_consultation DESC`, [patientId ?? null]);
  s.getConsultation = (id) => store.get(`SELECT c.*, p.nom AS patient_nom, p.prenom AS patient_prenom, u.nom || ' ' || u.prenom AS praticien FROM consultations c JOIN patients p ON p.id=c.patient_id JOIN users u ON u.id=c.user_id WHERE c.id=?`, [id]);
  s.getConsultationsJour = (date) => store.all(`SELECT c.*, p.nom || ' ' || p.prenom AS patient_nom FROM consultations c JOIN patients p ON p.id=c.patient_id WHERE date(c.date_consultation)=date(?) ORDER BY c.date_consultation DESC`, [date || today()]);
  s.listConsultationsRange = (from, to) => store.all(
    `SELECT c.*, p.id AS patient_id, p.nom AS patient_nom, p.prenom AS patient_prenom, u.nom || ' ' || u.prenom AS praticien, a.libelle AS acte_libelle
     FROM consultations c
     JOIN patients p ON p.id = c.patient_id
     JOIN users u ON u.id = c.user_id
     LEFT JOIN actes a ON a.id = c.acte_id
     WHERE date(c.date_consultation) BETWEEN date(?) AND date(?)
     ORDER BY c.date_consultation DESC`,
    [from || '1900-01-01', to || '2999-12-31']
  );
  s.getConsultationDetail = (id) => {
    const consultation = s.getConsultation(id);
    if (!consultation) return null;
    const ordonnances = store.all('SELECT * FROM ordonnances WHERE consultation_id=? ORDER BY date_ordonnance DESC', [id]);
    const documents = store.all('SELECT * FROM documents WHERE consultation_id=? ORDER BY date_document DESC', [id]);
    const paiements = store.all(`SELECT pa.*, a.libelle AS acte FROM paiements pa LEFT JOIN actes a ON a.id=pa.acte_id WHERE pa.consultation_id=? ORDER BY pa.date_paiement DESC`, [id]);
    return { consultation, ordonnances, documents, paiements };
  };
  s.createConsultation = (data) => insert(store, 'consultations', normalizeRequired(data, ['patient_id', 'user_id', 'motif'], ['rdv_id', 'date_consultation', 'anamnese', 'examen_clinique', 'diagnostic', 'cim10_code', 'traitement', 'instructions', 'prochain_rdv_dans', 'observations', 'tension', 'tension_systolique', 'tension_diastolique', 'pouls', 'poids', 'taille', 'temperature', 'saturation', 'glycemie', 'imc', 'duree_minutes', 'acte_id', 'montant_prevu']));
  s.updateConsultation = (id, data) => update(store, 'consultations', id, normalize(data, ['date_consultation', 'motif', 'anamnese', 'examen_clinique', 'diagnostic', 'cim10_code', 'traitement', 'instructions', 'prochain_rdv_dans', 'observations', 'tension', 'tension_systolique', 'tension_diastolique', 'pouls', 'poids', 'taille', 'temperature', 'saturation', 'glycemie', 'imc', 'duree_minutes', 'acte_id', 'montant_prevu']));
  s.listRDVJour = (date) => store.all(`
    SELECT r.*,
      COALESCE(p.nom || ' ' || p.prenom, r.nom_patient_libre) AS patient_nom,
      p.telephone AS patient_telephone,
      (SELECT id          FROM consultations WHERE rdv_id = r.id ORDER BY id DESC LIMIT 1) AS consultation_id,
      (SELECT acte_id     FROM consultations WHERE rdv_id = r.id ORDER BY id DESC LIMIT 1) AS acte_id,
      (SELECT montant_prevu FROM consultations WHERE rdv_id = r.id ORDER BY id DESC LIMIT 1) AS montant_prevu,
      a.libelle AS acte_libelle,
      a.tarif   AS acte_tarif,
      a.code    AS acte_code,
      pm.id     AS paiement_id,
      pm.montant AS montant_paye,
      pm.recu_numero,
      pm.mode_paiement AS mode_paiement_effectue
    FROM rdv r
    LEFT JOIN patients p ON p.id = r.patient_id
    LEFT JOIN actes a ON a.id = (SELECT acte_id FROM consultations WHERE rdv_id = r.id ORDER BY id DESC LIMIT 1)
    LEFT JOIN paiements pm ON pm.rdv_id = r.id
    WHERE r.date_rdv = date(?)
    ORDER BY r.heure_debut
  `, [date || today()]);
  s.listOrdonnances = (patientId) => store.all('SELECT * FROM ordonnances WHERE patient_id=? ORDER BY date_ordonnance DESC', [patientId ?? null]);
  s.createOrdonnance = (data) => {
    const numero = genererNumeroOrdonnance(store, data.date_ordonnance);
    const res = insert(store, 'ordonnances', {
      ...normalizeRequired(data, ['patient_id', 'user_id'], ['consultation_id', 'date_ordonnance', 'pdf_path', 'notes_pharmacien']),
      contenu: data.contenu || data.lignes || '[]',
      lignes: data.lignes || data.contenu || '[]',
      numero,
    });
    return { ...res, numero };
  };
  // Recherche d'une ordonnance deja delivree : par son numero (saisi ou scanne
  // depuis le code-barres imprime) ou par le nom du patient.
  s.rechercherOrdonnances = (filters = {}) => {
    const search = String(typeof filters === 'object' ? filters.search || '' : filters).trim();
    const limit = Number((typeof filters === 'object' && filters.limit) || 50);
    const offset = Number((typeof filters === 'object' && filters.offset) || 0);
    // Sans recherche : l'historique complet, de la plus recente a la plus ancienne,
    // par pages (plus de 69 000 ordonnances reprises de l'ancien logiciel).
    if (!search) {
      return store.all(`
        SELECT o.*, p.nom AS patient_nom, p.prenom AS patient_prenom, p.date_naissance,
               p.sexe, p.code_patient, p.adresse, p.allergies
        FROM ordonnances o JOIN patients p ON p.id = o.patient_id
        ORDER BY o.date_ordonnance DESC, o.id DESC
        LIMIT ? OFFSET ?
      `, [limit, offset]);
    }
    const tokens = search.split(/\s+/).filter(Boolean);
    const morceaux = [];
    const params = [];
    for (const t of tokens) {
      if (/^\d{1,6}\/\d{4}$/.test(t)) {
        morceaux.push('o.numero = ?');
        params.push(t.padStart(11, '0'));
      } else {
        morceaux.push('(p.nom LIKE ? OR p.prenom LIKE ? OR p.code_patient LIKE ? OR o.numero LIKE ?)');
        params.push(...likeParams(t, 4));
      }
    }
    return store.all(`
      SELECT o.*, p.nom AS patient_nom, p.prenom AS patient_prenom, p.date_naissance,
             p.sexe, p.code_patient, p.adresse, p.allergies
      FROM ordonnances o JOIN patients p ON p.id = o.patient_id
      WHERE ${morceaux.join(' AND ')}
      ORDER BY o.date_ordonnance DESC, o.id DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
  };
  s.getOrdonnance = (id) => store.get('SELECT o.*, p.nom AS patient_nom, p.prenom AS patient_prenom, p.date_naissance FROM ordonnances o JOIN patients p ON p.id=o.patient_id WHERE o.id=?', [id]);
  s.listDocuments = (patientId) => store.all('SELECT * FROM documents WHERE patient_id=? ORDER BY date_document DESC', [patientId ?? null]);
  s.createDocument = (data) => {
    const type = data.type || 'autre';
    const PREFIX_MAP = { certificat:'CERT', arret_travail:'ARRT', courrier:'COUR', resultat_labo:'LABO', imagerie:'IMAG', compte_rendu:'CRDU', autre:'AUTR' };
    const prefix = PREFIX_MAP[type] || 'AUTR';
    const now = new Date();
    const mm = String(now.getMonth()+1).padStart(2,'0');
    const yyyy = now.getFullYear();
    const count = (store.get('SELECT COUNT(*) AS n FROM documents WHERE type=?', [type])?.n || 0) + 1;
    const numero = `${prefix}-${String(count).padStart(4,'0')}-${mm}-${yyyy}`;
    const payload = normalizeRequired({ ...data, numero }, ['patient_id','type','titre'], ['contenu','fichier_path','date_document','numero','consultation_id']);
    const result = insert(store, 'documents', payload);
    return { id: result.id, numero };
  };
  s.deleteDocument = (id) => store.run('DELETE FROM documents WHERE id=?', [id]).changes > 0;
  s.listRDV = (from, to) => store.all(`SELECT r.*, COALESCE(p.nom || ' ' || p.prenom, r.nom_patient_libre) AS patient_nom, p.telephone FROM rdv r LEFT JOIN patients p ON p.id=r.patient_id WHERE r.date_rdv BETWEEN ? AND ? ORDER BY r.date_rdv, r.heure_debut`, [from || '1900-01-01', to || '2999-12-31']);
  s.listRDVByPatient = (patientId) => store.all(`SELECT r.* FROM rdv r WHERE r.patient_id = ? ORDER BY r.date_rdv DESC, r.heure_debut DESC`, [patientId]);
  s.createRDV = (data) => insert(store, 'rdv', { ...normalizeRequired(data, ['date_rdv', 'heure_debut', 'heure_fin'], ['patient_id', 'nom_patient_libre', 'telephone_libre', 'motif', 'notes', 'created_by']), statut: data.statut || 'planifie', couleur: data.couleur || '#3B82F6' });
  s.updateRDV = (id, data) => update(store, 'rdv', id, normalize(data, ['patient_id', 'nom_patient_libre', 'telephone_libre', 'date_rdv', 'heure_debut', 'heure_fin', 'motif', 'statut', 'couleur', 'notes']));
  s.updateStatutRDV = (id, statut) => store.run('UPDATE rdv SET statut=? WHERE id=?', [required(statut, 'Statut'), id]).changes > 0;
  s.deleteRDV = (id) => store.run('DELETE FROM rdv WHERE id=?', [id]).changes > 0;
  s.listPaiements = (filters = {}) => store.all(`SELECT pa.*, p.nom || ' ' || p.prenom AS patient_nom, a.libelle AS acte FROM paiements pa LEFT JOIN patients p ON p.id=pa.patient_id LEFT JOIN actes a ON a.id=pa.acte_id WHERE date(pa.date_paiement) BETWEEN date(?) AND date(?) ORDER BY pa.date_paiement DESC`, [filters.from || '1900-01-01', filters.to || '2999-12-31']);
  s.listPaiementsByPatient = (patientId) => store.all(`SELECT pa.*, a.libelle AS acte FROM paiements pa LEFT JOIN actes a ON a.id=pa.acte_id WHERE pa.patient_id = ? ORDER BY pa.date_paiement DESC`, [patientId]);
  s.getProchainNumeroRecu = () => {
    const prefix = `REC-${today().replaceAll('-', '')}`;
    const count = store.get('SELECT COUNT(*) AS total FROM paiements WHERE recu_numero LIKE ?', [`${prefix}-%`]).total + 1;
    return `${prefix}-${String(count).padStart(4, '0')}`;
  };
  s.createPaiement = (data) => insert(store, 'paiements', { ...normalizeRequired(data, ['montant'], ['patient_id', 'consultation_id', 'rdv_id', 'acte_id', 'mode_paiement', 'date_paiement', 'remarque', 'created_by']), recu_numero: data.recu_numero || s.getProchainNumeroRecu() });
  s.rapportCaisse = (from, to) => {
    const rows = store.all(
      `SELECT date(date_paiement) AS jour, mode_paiement, SUM(montant) AS total, COUNT(*) AS nombre FROM paiements WHERE date(date_paiement) BETWEEN date(?) AND date(?) GROUP BY jour, mode_paiement ORDER BY jour`,
      [from || '1900-01-01', to || '2999-12-31']
    );
    return { rows, total: rows.reduce((sum, row) => sum + Number(row.total || 0), 0) };
  };
  s.listMessages = () => store.all(`SELECT m.*, COALESCE(u.nom || ' ' || u.prenom, '?') AS auteur, COALESCE(u.role, 'inconnu') AS role FROM messages_chat m LEFT JOIN users u ON u.id=m.user_id ORDER BY m.created_at DESC LIMIT 50`).reverse();
  s.sendMessage = (userId, payload) => {
    const data = typeof payload === 'object' ? payload : { message: payload, type: 'text' };
    const type = ['text', 'alerte', 'rdv'].includes(data.type) ? data.type : 'text';
    // INSERT — on n'utilise PAS lastInsertRowid (getAsObject() ignore l'alias AS dans certaines
    // versions de sql.js, rendant .id = undefined → WHERE id = NULL → zéro résultats)
    store.run('INSERT INTO messages_chat (user_id, message, type) VALUES (?, ?, ?)', [userId, required(data.message, 'Message'), type]);
    // On récupère le dernier message de cet utilisateur = celui qu'on vient d'insérer
    return store.get(
      `SELECT m.*, COALESCE(u.nom || ' ' || u.prenom, '?') AS auteur, COALESCE(u.role, 'inconnu') AS role
       FROM messages_chat m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.user_id = ? ORDER BY m.id DESC LIMIT 1`,
      [userId]
    );
  };
  s.listParametres = () => Object.fromEntries(store.all('SELECT cle, valeur FROM parametres ORDER BY cle').map((r) => [r.cle, r.valeur]));
  s.setParametre = (cle, valeur) => store.run('INSERT INTO parametres (cle,valeur) VALUES (?,?) ON CONFLICT(cle) DO UPDATE SET valeur=excluded.valeur', [required(cle, 'Cle'), String(valeur ?? '')]).changes >= 0;
  s.listUsers = () => store.all('SELECT id, nom, prenom, role, login, actif, created_at, specialite, telephone, permissions FROM users ORDER BY actif DESC, nom');
  s.saveUser = (data) => {
    required(data.nom, 'Nom'); required(data.prenom, 'Prenom'); required(data.login, 'Login');
    const role = ['medecin', 'infirmiere', 'secretaire'].includes(data.role) ? data.role : 'medecin';
    const perms = data.permissions == null ? null
      : typeof data.permissions === 'string' ? data.permissions
      : JSON.stringify(data.permissions);
    if (data.id) {
      const base = [data.nom, data.prenom, role, data.login, data.actif ? 1 : 0, nullable(data.specialite), nullable(data.telephone), perms];
      if (data.password) store.run('UPDATE users SET nom=?, prenom=?, role=?, login=?, actif=?, specialite=?, telephone=?, permissions=?, password_hash=? WHERE id=?', [...base, hashPassword(data.password), data.id]);
      else store.run('UPDATE users SET nom=?, prenom=?, role=?, login=?, actif=?, specialite=?, telephone=?, permissions=? WHERE id=?', [...base, data.id]);
      return { id: data.id };
    }
    required(data.password, 'Mot de passe');
    return { id: store.run('INSERT INTO users (nom, prenom, role, login, password_hash, actif, specialite, telephone, permissions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [data.nom, data.prenom, role, data.login, hashPassword(data.password), data.actif ? 1 : 0, nullable(data.specialite), nullable(data.telephone), perms]).lastInsertRowid };
  };
  s.clearData = (password) => {
    if (!bcrypt.compareSync(String(password || ''), '$2a$10$P9lYDZ5xJBHprhR3ZPfbQuyM6C4RbOub3NrXVn4hm9C.Vb4hthHFi')) throw new Error('Mot de passe incorrect');
    store.exec('DELETE FROM paiements');
    store.exec('DELETE FROM depenses');
    store.exec('DELETE FROM messages_chat');
    store.exec('DELETE FROM rdv');
    store.exec('DELETE FROM documents');
    store.exec('DELETE FROM ordonnances');
    store.exec('DELETE FROM consultations');
    store.exec('DELETE FROM patients');
    try { store.exec("DELETE FROM sqlite_sequence WHERE name IN ('patients','consultations','ordonnances','documents','rdv','paiements','depenses','messages_chat')"); } catch {}
    store.save();
    return true;
  };
  s.createDepense = (data) => insert(store, 'depenses', {
    montant: Number(required(data.montant, 'Montant')),
    categorie: data.categorie || 'autre',
    mode_paiement: data.mode_paiement || 'especes',
    date_depense: nullable(data.date_depense),
    description: nullable(data.description),
    fournisseur: nullable(data.fournisseur),
    created_by: nullable(data.created_by),
  });
  s.listDepenses = (filters = {}) => store.all(
    `SELECT d.*, u.nom || ' ' || u.prenom AS auteur FROM depenses d LEFT JOIN users u ON u.id=d.created_by WHERE date(d.date_depense) BETWEEN date(?) AND date(?) ORDER BY d.date_depense DESC`,
    [filters.from || '1900-01-01', filters.to || '2999-12-31']
  );
  s.rapportDepenses = (from, to) => {
    const rows = store.all(
      `SELECT date(date_depense) AS jour, categorie, SUM(montant) AS total, COUNT(*) AS nombre FROM depenses WHERE date(date_depense) BETWEEN date(?) AND date(?) GROUP BY jour, categorie ORDER BY jour`,
      [from || '1900-01-01', to || '2999-12-31']
    );
    return { rows, total: rows.reduce((sum, row) => sum + Number(row.total || 0), 0) };
  };
  s.listMotifs = () => store.all('SELECT * FROM motifs WHERE actif = 1 ORDER BY ordre, libelle');
  s.listAllMotifs = () => store.all('SELECT * FROM motifs ORDER BY ordre, libelle');
  s.saveMotif = (data) => data.id
    ? (store.run('UPDATE motifs SET libelle=?, couleur=?, ordre=?, actif=? WHERE id=?', [required(data.libelle, 'Libelle'), data.couleur || '#3B82F6', Number(data.ordre || 0), data.actif !== undefined ? (data.actif ? 1 : 0) : 1, data.id]), { id: data.id })
    : { id: store.run('INSERT INTO motifs (libelle, couleur, ordre, actif) VALUES (?, ?, ?, ?)', [required(data.libelle, 'Libelle'), data.couleur || '#3B82F6', Number(data.ordre || 0), 1]).lastInsertRowid };
  s.deleteMotif = (id) => store.run('UPDATE motifs SET actif = 0 WHERE id = ?', [id]);

  s.listActes = () => store.all('SELECT * FROM actes ORDER BY actif DESC, libelle');
  s.saveActe = (data) => data.id
    ? (store.run('UPDATE actes SET code=?, libelle=?, tarif=?, categorie=?, actif=? WHERE id=?', [nullable(data.code), required(data.libelle, 'Libelle'), Number(data.tarif || 0), data.categorie || 'consultation', data.actif ? 1 : 0, data.id]), { id: data.id })
    : { id: store.run('INSERT INTO actes (code, libelle, tarif, categorie, actif) VALUES (?, ?, ?, ?, ?)', [nullable(data.code), required(data.libelle, 'Libelle'), Number(data.tarif || 0), data.categorie || 'consultation', data.actif ? 1 : 0]).lastInsertRowid };

  // ── Statistiques du cabinet ────────────────────────────────────────
  // Un seul appel renvoie tout ce qu'affiche l'ecran Statistiques. Les dates
  // posterieures a aujourd'hui sont ecartees partout : quelques fiches reprises
  // de l'ancien logiciel portent une annee saisie de travers et fausseraient
  // toutes les courbes.
  s.statistiques = (options = {}) => {
    const mois = Math.min(Math.max(Number(options.mois) || 12, 1), 120);
    const depuis = `-${mois} months`;

    // Repartition hommes / femmes.
    const sexes = store.all(`
      SELECT CASE WHEN sexe IN ('M','F') THEN sexe ELSE '?' END AS sexe, COUNT(*) AS total
      FROM patients GROUP BY 1
    `);

    // Pyramide des ages : le decoupage se fait ici, en JS, pour rester lisible.
    const TRANCHES = [
      ['0-4 ans', 0, 4], ['5-14 ans', 5, 14], ['15-24 ans', 15, 24],
      ['25-34 ans', 25, 34], ['35-44 ans', 35, 44], ['45-54 ans', 45, 54],
      ['55-64 ans', 55, 64], ['65-74 ans', 65, 74], ['75 ans et +', 75, 200],
    ];
    const ages = TRANCHES.map(([tranche]) => ({ tranche, hommes: 0, femmes: 0, total: 0 }));
    const naissances = store.all(`
      SELECT sexe, date_naissance FROM patients
      WHERE date_naissance IS NOT NULL AND date_naissance != ''
    `);
    let sommeAges = 0;
    let comptesAges = 0;
    const maintenant = new Date();
    for (const ligne of naissances) {
      const nee = new Date(ligne.date_naissance);
      if (Number.isNaN(nee.getTime())) continue;
      let age = maintenant.getFullYear() - nee.getFullYear();
      const m = maintenant.getMonth() - nee.getMonth();
      if (m < 0 || (m === 0 && maintenant.getDate() < nee.getDate())) age -= 1;
      if (age < 0 || age > 120) continue;
      sommeAges += age;
      comptesAges += 1;
      const i = TRANCHES.findIndex(([, min, max]) => age >= min && age <= max);
      if (i === -1) continue;
      ages[i].total += 1;
      if (ligne.sexe === 'M') ages[i].hommes += 1;
      else if (ligne.sexe === 'F') ages[i].femmes += 1;
    }

    // Palmares texte libre : on regroupe sur la valeur nettoyee (minuscules,
    // espaces en trop) mais on reaffiche le libelle le plus frequent.
    const palmares = (table, colonne, colonneDate) => store.all(`
      SELECT TRIM(${colonne}) AS libelle, COUNT(*) AS total
      FROM ${table}
      WHERE ${colonne} IS NOT NULL AND TRIM(${colonne}) != ''
        AND date(${colonneDate}) BETWEEN date('now', ?) AND date('now')
      GROUP BY LOWER(TRIM(${colonne}))
      ORDER BY total DESC, libelle
      LIMIT 12
    `, [depuis]);

    // Medicaments prescrits : les lignes sont stockees en JSON, il faut les lire.
    const compteurMedicaments = new Map();
    let lignesPrescrites = 0;
    const ordonnances = store.all(`
      SELECT lignes, contenu FROM ordonnances
      WHERE date(date_ordonnance) BETWEEN date('now', ?) AND date('now')
    `, [depuis]);
    for (const o of ordonnances) {
      let lignes = [];
      try { lignes = JSON.parse(o.lignes || o.contenu || '[]'); } catch { lignes = []; }
      if (!Array.isArray(lignes)) continue;
      for (const l of lignes) {
        const nom = String(l?.medicament_nom || '').trim();
        if (!nom) continue;
        lignesPrescrites += 1;
        const cle = nom.toLowerCase();
        const actuel = compteurMedicaments.get(cle);
        if (actuel) actuel.total += 1;
        else compteurMedicaments.set(cle, { libelle: nom, total: 1 });
      }
    }
    const medicaments = [...compteurMedicaments.values()]
      .sort((a, b) => b.total - a.total || a.libelle.localeCompare(b.libelle))
      .slice(0, 12);

    // Allergies : champ libre, plusieurs valeurs separees par , ; ou /.
    const compteurAllergies = new Map();
    for (const ligne of store.all("SELECT allergies FROM patients WHERE allergies IS NOT NULL AND TRIM(allergies) != ''")) {
      for (const brut of String(ligne.allergies).split(/[,;/\n]+/)) {
        const nom = brut.trim();
        if (nom.length < 2) continue;
        const cle = nom.toLowerCase();
        const actuel = compteurAllergies.get(cle);
        if (actuel) actuel.total += 1;
        else compteurAllergies.set(cle, { libelle: nom, total: 1 });
      }
    }
    const allergies = [...compteurAllergies.values()]
      .sort((a, b) => b.total - a.total || a.libelle.localeCompare(b.libelle))
      .slice(0, 10);

    const JOURS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
    const parJour = store.all(`
      SELECT strftime('%w', date_consultation) AS jour, COUNT(*) AS total
      FROM consultations
      WHERE date(date_consultation) BETWEEN date('now', ?) AND date('now')
      GROUP BY jour ORDER BY jour
    `, [depuis]);
    const semaine = JOURS.map((nom, i) => ({
      jour: nom,
      total: Number(parJour.find((r) => Number(r.jour) === i)?.total || 0),
    }));

    return {
      periodeMois: mois,
      sexes,
      ages,
      ageMoyen: comptesAges ? Math.round(sommeAges / comptesAges) : 0,
      patientsTotal: store.get('SELECT COUNT(*) AS total FROM patients').total,
      patientsAvecDateNaissance: comptesAges,
      patientsSuivis: store.get(`
        SELECT COUNT(DISTINCT patient_id) AS total FROM consultations
        WHERE date(date_consultation) BETWEEN date('now', ?) AND date('now')
      `, [depuis]).total,
      nouveauxPatients: store.all(`
        SELECT strftime('%Y-%m', created_at) AS mois, COUNT(*) AS total
        FROM patients
        WHERE date(created_at) BETWEEN date('now', ?) AND date('now')
        GROUP BY mois ORDER BY mois
      `, [depuis]),
      consultationsParMois: store.all(`
        SELECT strftime('%Y-%m', date_consultation) AS mois, COUNT(*) AS total
        FROM consultations
        WHERE date(date_consultation) BETWEEN date('now', ?) AND date('now')
        GROUP BY mois ORDER BY mois
      `, [depuis]),
      consultationsTotal: store.get(`
        SELECT COUNT(*) AS total FROM consultations
        WHERE date(date_consultation) BETWEEN date('now', ?) AND date('now')
      `, [depuis]).total,
      ordonnancesTotal: ordonnances.length,
      lignesPrescrites,
      semaine,
      motifs: palmares('consultations', 'motif', 'date_consultation'),
      diagnostics: palmares('consultations', 'diagnostic', 'date_consultation'),
      medicaments,
      allergies,
      groupesSanguins: store.all(`
        SELECT TRIM(groupe_sanguin) AS libelle, COUNT(*) AS total
        FROM patients WHERE groupe_sanguin IS NOT NULL AND TRIM(groupe_sanguin) != ''
        GROUP BY LOWER(TRIM(groupe_sanguin)) ORDER BY total DESC LIMIT 10
      `),
      villes: store.all(`
        SELECT TRIM(ville) AS libelle, COUNT(*) AS total
        FROM patients WHERE ville IS NOT NULL AND TRIM(ville) != ''
        GROUP BY LOWER(TRIM(ville)) ORDER BY total DESC LIMIT 10
      `),
      constantes: store.get(`
        SELECT
          ROUND(AVG(NULLIF(imc, 0)), 1) AS imc,
          ROUND(AVG(NULLIF(tension_systolique, 0))) AS systolique,
          ROUND(AVG(NULLIF(tension_diastolique, 0))) AS diastolique,
          ROUND(AVG(NULLIF(glycemie, 0)), 2) AS glycemie,
          ROUND(AVG(NULLIF(poids, 0)), 1) AS poids
        FROM consultations
        WHERE date(date_consultation) BETWEEN date('now', ?) AND date('now')
      `, [depuis]) || {},
      statutsRdv: store.all(`
        SELECT statut, COUNT(*) AS total FROM rdv
        WHERE date(date_rdv) BETWEEN date('now', ?) AND date('now')
        GROUP BY statut ORDER BY total DESC
      `, [depuis]),
    };
  };

  s.dashboard = () => ({
    rdvToday: store.all('SELECT statut, COUNT(*) AS total FROM rdv WHERE date_rdv=? GROUP BY statut', [today()]),
    nextRDV: store.all(`SELECT r.*, COALESCE(p.nom || ' ' || p.prenom, r.nom_patient_libre) AS patient_nom FROM rdv r LEFT JOIN patients p ON p.id=r.patient_id WHERE date_rdv >= ? ORDER BY date_rdv, heure_debut LIMIT 5`, [today()]),
    patientsTotal: store.get('SELECT COUNT(*) AS total FROM patients').total,
    // « Dernieres consultations » : on ecarte les dates posterieures a aujourd'hui.
    // Quelques fiches reprises d'un ancien logiciel portent une annee saisie de travers
    // (2202, 3020...) ; sans ce filtre elles resteraient indefiniment en tete de liste.
    dernieresConsultations: store.all(`SELECT c.*, p.nom || ' ' || p.prenom AS patient_nom FROM consultations c JOIN patients p ON p.id=c.patient_id WHERE date(c.date_consultation) <= date('now') ORDER BY c.date_consultation DESC LIMIT 5`),
    ca: store.all(`SELECT date(date_paiement) AS jour, SUM(montant) AS total FROM paiements WHERE date(date_paiement) >= date('now','-30 days') GROUP BY jour ORDER BY jour`),
    rappelsSuivi: store.all(`
      SELECT c.id AS consultation_id, c.patient_id, c.date_consultation, c.prochain_rdv_dans, c.motif,
             p.nom, p.prenom, p.telephone,
             date(c.date_consultation, '+' || c.prochain_rdv_dans || ' days') AS date_prevue
      FROM consultations c
      JOIN patients p ON p.id = c.patient_id
      WHERE c.prochain_rdv_dans IS NOT NULL AND c.prochain_rdv_dans != ''
        AND c.id = (SELECT MAX(id) FROM consultations c2 WHERE c2.patient_id = c.patient_id)
        AND date(c.date_consultation, '+' || c.prochain_rdv_dans || ' days') <= date('now', '+7 days')
      ORDER BY date_prevue ASC
      LIMIT 30
    `)
  });

  // ── Module Algérie ──
  dz.attachDZ(store);
}

function insert(store, table, payload) {
  const keys = Object.keys(payload);
  return { id: store.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => `@${k}`).join(',')})`, payload).lastInsertRowid };
}
function update(store, table, id, payload) {
  return store.run(`UPDATE ${table} SET ${Object.keys(payload).map((k) => `${k}=@${k}`).join(',')} WHERE id=@id`, { ...payload, id }).changes > 0;
}
// Ne conserve que les cles reellement fournies par l'appelant (data[key] !== undefined).
// Important : une cle absente (ex. date_paiement non precisee) doit etre omise de l'INSERT/UPDATE
// pour laisser le DEFAULT SQL s'appliquer (datetime('now'), 'especes'...) — l'inclure avec NULL
// ecraserait silencieusement ce defaut. Une cle explicitement vide/nulle reste normalisee en NULL.
function normalize(data, keys) {
  const out = {};
  for (const key of keys) {
    if (data && Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined) {
      out[key] = nullable(data[key]);
    }
  }
  return out;
}
function normalizeRequired(data, req, optional) {
  const base = Object.fromEntries(req.map((key) => [key, required(data?.[key], key)]));
  return { ...base, ...normalize(data, optional) };
}
function likeParams(search, count) {
  const q = `%${String(search || '').trim()}%`;
  return Array.from({ length: count }, () => q);
}
function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}
function seedMedicaments(store) {
  if (store.get('SELECT COUNT(*) AS total FROM medicaments').total >= 400) return;
  const rows = [
    // ANTALGIQUES / ANTIPYRETIQUES
    ['Paracetamol Biogaran','Paracetamol','comprime','500mg','Antalgique/Antipyretique','BIOGARAN'],
    ['Paracetamol Biogaran','Paracetamol','comprime','1000mg','Antalgique/Antipyretique','BIOGARAN'],
    ['Doliprane','Paracetamol','comprime','1000mg','Antalgique/Antipyretique','SANOFI'],
    ['Doliprane','Paracetamol','sirop','2.4%','Antalgique/Antipyretique','SANOFI'],
    ['Doliprane','Paracetamol','suppositoire','150mg','Antalgique/Antipyretique','SANOFI'],
    ['Doliprane','Paracetamol','suppositoire','300mg','Antalgique/Antipyretique','SANOFI'],
    ['Doliprane','Paracetamol','suppositoire','600mg','Antalgique/Antipyretique','SANOFI'],
    ['Efferalgan','Paracetamol','comprime effervescent','1000mg','Antalgique/Antipyretique','UPSA'],
    ['Efferalgan Codeine','Paracetamol + Codeine','comprime','500mg/30mg','Antalgique','UPSA'],
    ['Algocod','Paracetamol + Codeine','comprime','400mg/20mg','Antalgique','SAIDAL'],
    ['Dafalgan','Paracetamol','comprime','500mg','Antalgique/Antipyretique','UPSA'],
    ['Dafalgan','Paracetamol','sachet','1000mg','Antalgique/Antipyretique','UPSA'],
    ['Perfalgan','Paracetamol','solution perfusable','10mg/ml','Antalgique/Antipyretique','UPSA'],
    ['Tramadol','Tramadol','gelule','50mg','Antalgique opioide','SAIDAL'],
    ['Tramal','Tramadol','gelule','50mg','Antalgique opioide','GRUNENTHAL'],
    ['Tramal LP','Tramadol','comprime LP','100mg','Antalgique opioide','GRUNENTHAL'],
    ['Topalgic','Tramadol','gelule','50mg','Antalgique opioide','PIERRE FABRE'],
    ['Novalgin','Metamizole','comprime','500mg','Antalgique','SANOFI'],
    ['Novalgin','Metamizole','injectable','500mg/ml','Antalgique','SANOFI'],
    // AINS
    ['Ibuprofene Biogaran','Ibuprofene','comprime','400mg','AINS','BIOGARAN'],
    ['Advil','Ibuprofene','comprime pellicule','400mg','AINS','PFIZER'],
    ['Brufen','Ibuprofene','comprime','400mg','AINS','ABBOTT'],
    ['Brufen','Ibuprofene','sirop','200mg/5ml','AINS','ABBOTT'],
    ['Brufen','Ibuprofene','suppositoire','500mg','AINS','ABBOTT'],
    ['Voltarene','Diclofenac','comprime','50mg','AINS','NOVARTIS'],
    ['Voltarene LP','Diclofenac','comprime LP','75mg','AINS','NOVARTIS'],
    ['Voltarene','Diclofenac','gel','1%','AINS Topique','NOVARTIS'],
    ['Voltarene','Diclofenac','injectable','75mg/3ml','AINS','NOVARTIS'],
    ['Bi-profenid','Ketoprofene','comprime LP','150mg','AINS','SANOFI'],
    ['Profenid','Ketoprofene','comprime','100mg','AINS','SANOFI'],
    ['Profenid','Ketoprofene','gel','2.5%','AINS Topique','SANOFI'],
    ['Celebrex','Celecoxib','gelule','200mg','AINS COX-2','PFIZER'],
    ['Naproxene','Naproxene','comprime','500mg','AINS','SAIDAL'],
    ['Naprosyne','Naproxene','comprime','500mg','AINS','ROCHE'],
    ['Mobic','Meloxicam','comprime','15mg','AINS COX-2','BOEHRINGER'],
    ['Mobic','Meloxicam','injectable','15mg/1.5ml','AINS COX-2','BOEHRINGER'],
    ['Indocid','Indometacine','gelule','25mg','AINS','MSD'],
    ['Indocid','Indometacine','suppositoire','100mg','AINS','MSD'],
    ['Feldene','Piroxicam','gelule','20mg','AINS','PFIZER'],
    ['Feldene','Piroxicam','gel','0.5%','AINS Topique','PFIZER'],
    // ANTIBIOTIQUES - Penicillines
    ['Amoxicilline Biogaran','Amoxicilline','gelule','500mg','Antibiotique - Penicilline','BIOGARAN'],
    ['Amoxicilline Biogaran','Amoxicilline','gelule','1g','Antibiotique - Penicilline','BIOGARAN'],
    ['Clamoxyl','Amoxicilline','gelule','500mg','Antibiotique - Penicilline','GSK'],
    ['Amoxipen','Amoxicilline','gelule','500mg','Antibiotique - Penicilline','SAIDAL'],
    ['Augmentin','Amoxicilline + Clavulanate','comprime','875mg/125mg','Antibiotique - Penicilline','GSK'],
    ['Augmentin','Amoxicilline + Clavulanate','sirop','100mg/12.5mg/ml','Antibiotique - Penicilline','GSK'],
    ['Augmentin','Amoxicilline + Clavulanate','poudre injectable','1g/200mg','Antibiotique - Penicilline','GSK'],
    ['Ampiclox','Ampicilline + Cloxacilline','gelule','250mg/250mg','Antibiotique - Penicilline','SAIDAL'],
    ['Ampicilline','Ampicilline','poudre injectable','1g','Antibiotique - Penicilline','SAIDAL'],
    // ANTIBIOTIQUES - Fluoroquinolones
    ['Ciproxine','Ciprofloxacine','comprime','500mg','Antibiotique - Fluoroquinolone','BAYER'],
    ['Ciproxine','Ciprofloxacine','comprime','250mg','Antibiotique - Fluoroquinolone','BAYER'],
    ['Ciproxine','Ciprofloxacine','solution injectable','200mg/100ml','Antibiotique - Fluoroquinolone','BAYER'],
    ['Oflocet','Ofloxacine','comprime','200mg','Antibiotique - Fluoroquinolone','SANOFI'],
    ['Noroxine','Norfloxacine','comprime','400mg','Antibiotique - Fluoroquinolone','MSD'],
    ['Tavanic','Levofloxacine','comprime','500mg','Antibiotique - Fluoroquinolone','SANOFI'],
    ['Izilox','Moxifloxacine','comprime','400mg','Antibiotique - Fluoroquinolone','BAYER'],
    // ANTIBIOTIQUES - Macrolides
    ['Azithromed','Azithromycine','comprime','500mg','Antibiotique - Macrolide','SAIDAL'],
    ['Zithromax','Azithromycine','gelule','250mg','Antibiotique - Macrolide','PFIZER'],
    ['Zithromax','Azithromycine','sachet','500mg','Antibiotique - Macrolide','PFIZER'],
    ['Rulid','Roxithromycine','comprime','150mg','Antibiotique - Macrolide','SANOFI'],
    ['Josacine','Josamycine','comprime','500mg','Antibiotique - Macrolide','ASTELLAS'],
    ['Erythromycine','Erythromycine','comprime','500mg','Antibiotique - Macrolide','SAIDAL'],
    ['Clamycin','Clarithromycine','comprime','500mg','Antibiotique - Macrolide','SAIDAL'],
    ['Zeclar','Clarithromycine','comprime','500mg','Antibiotique - Macrolide','ABBOTT'],
    // ANTIBIOTIQUES - Cephalosporines
    ['Keforal','Cefalexine','gelule','500mg','Antibiotique - Cephalosporine G1','LILLY'],
    ['Zinnat','Cefuroxime','comprime','500mg','Antibiotique - Cephalosporine G2','GSK'],
    ['Zinnat','Cefuroxime','sirop','125mg/5ml','Antibiotique - Cephalosporine G2','GSK'],
    ['Rocephine','Ceftriaxone','poudre injectable','1g','Antibiotique - Cephalosporine G3','ROCHE'],
    ['Rocephine','Ceftriaxone','poudre injectable','500mg','Antibiotique - Cephalosporine G3','ROCHE'],
    ['Orelox','Cefpodoxime','comprime','100mg','Antibiotique - Cephalosporine G3','SANOFI'],
    ['Orelox','Cefpodoxime','sachet','40mg','Antibiotique - Cephalosporine G3','SANOFI'],
    ['Cefixoral','Cefixime','gelule','200mg','Antibiotique - Cephalosporine G3','SAIDAL'],
    ['Suprax','Cefixime','comprime','400mg','Antibiotique - Cephalosporine G3','PFIZER'],
    ['Fortum','Ceftazidime','poudre injectable','1g','Antibiotique - Cephalosporine G3','GSK'],
    ['Cefazoline','Cefazoline','poudre injectable','1g','Antibiotique - Cephalosporine G1','SAIDAL'],
    // ANTIBIOTIQUES - Autres
    ['Bactrim','Trimethoprime + Sulfamethoxazole','comprime','80mg/400mg','Antibiotique - Sulfamide','ROCHE'],
    ['Bactrim Forte','Trimethoprime + Sulfamethoxazole','comprime','160mg/800mg','Antibiotique - Sulfamide','ROCHE'],
    ['Doxycycline','Doxycycline','gelule','100mg','Antibiotique - Tetracycline','SAIDAL'],
    ['Vibramycine','Doxycycline','gelule','100mg','Antibiotique - Tetracycline','PFIZER'],
    ['Flagyl','Metronidazole','comprime','500mg','Antibiotique - Nitroimidazole','SANOFI'],
    ['Flagyl','Metronidazole','ovule','500mg','Antibiotique - Nitroimidazole','SANOFI'],
    ['Flagyl','Metronidazole','injectable','500mg/100ml','Antibiotique - Nitroimidazole','SANOFI'],
    ['Tazocilline','Piperacilline + Tazobactam','poudre injectable','4g/500mg','Antibiotique - Penicilline + BetaLact','PFIZER'],
    ['Imipenem','Imipenem + Cilastatine','poudre injectable','500mg/500mg','Antibiotique - Carbapenem','MSD'],
    ['Vancomycine','Vancomycine','poudre injectable','500mg','Antibiotique - Glycopeptide','SAIDAL'],
    ['Rifampicine','Rifampicine','gelule','300mg','Antituberculeux','SANOFI'],
    ['Rifampicine','Rifampicine','gelule','600mg','Antituberculeux','SANOFI'],
    ['Isoniazide','Isoniazide','comprime','100mg','Antituberculeux','SAIDAL'],
    ['Pyrazinamide','Pyrazinamide','comprime','500mg','Antituberculeux','SAIDAL'],
    ['Ethambutol','Ethambutol','comprime','400mg','Antituberculeux','SAIDAL'],
    ['Furadantine','Nitrofurantoine','gelule','100mg','Antibiotique - Infection urinaire','PROCTER'],
    // ANTIHYPERTENSEURS
    ['Amlor','Amlodipine','comprime','5mg','Antihypertenseur - ICA','PFIZER'],
    ['Amlor','Amlodipine','comprime','10mg','Antihypertenseur - ICA','PFIZER'],
    ['Amlodipine Biogaran','Amlodipine','comprime','5mg','Antihypertenseur - ICA','BIOGARAN'],
    ['Coversyl','Perindopril','comprime','5mg','Antihypertenseur - IEC','SERVIER'],
    ['Coversyl','Perindopril','comprime','10mg','Antihypertenseur - IEC','SERVIER'],
    ['Ramipril','Ramipril','comprime','5mg','Antihypertenseur - IEC','SAIDAL'],
    ['Ramipril','Ramipril','comprime','10mg','Antihypertenseur - IEC','SAIDAL'],
    ['Triatec','Ramipril','comprime','5mg','Antihypertenseur - IEC','SANOFI'],
    ['Aprovel','Irbesartan','comprime','150mg','Antihypertenseur - ARA2','SANOFI'],
    ['Aprovel','Irbesartan','comprime','300mg','Antihypertenseur - ARA2','SANOFI'],
    ['Cozaar','Losartan','comprime','50mg','Antihypertenseur - ARA2','MSD'],
    ['Cozaar','Losartan','comprime','100mg','Antihypertenseur - ARA2','MSD'],
    ['Micardis','Telmisartan','comprime','80mg','Antihypertenseur - ARA2','BOEHRINGER'],
    ['Kenzen','Olmesartan','comprime','20mg','Antihypertenseur - ARA2','DAIICHI'],
    ['Kenzen','Olmesartan','comprime','40mg','Antihypertenseur - ARA2','DAIICHI'],
    ['Atenolol','Atenolol','comprime','50mg','Antihypertenseur - Betabloquant','SAIDAL'],
    ['Atenolol','Atenolol','comprime','100mg','Antihypertenseur - Betabloquant','SAIDAL'],
    ['Lopressor','Metoprolol','comprime','100mg','Antihypertenseur - Betabloquant','NOVARTIS'],
    ['Cardensiel','Bisoprolol','comprime','2.5mg','Antihypertenseur - Betabloquant','MERCK'],
    ['Cardensiel','Bisoprolol','comprime','5mg','Antihypertenseur - Betabloquant','MERCK'],
    ['Cardensiel','Bisoprolol','comprime','10mg','Antihypertenseur - Betabloquant','MERCK'],
    ['Lasix','Furosemide','comprime','40mg','Diuretique de l anse','SANOFI'],
    ['Lasilix','Furosemide','injectable','20mg/2ml','Diuretique de l anse','SANOFI'],
    ['Aldactone','Spironolactone','comprime','25mg','Diuretique epargneur de K','PFIZER'],
    ['Aldactone','Spironolactone','comprime','50mg','Diuretique epargneur de K','PFIZER'],
    ['Moduretic','Amiloride + Hydrochlorothiazide','comprime','5mg/50mg','Diuretique combine','MSD'],
    ['Hydrochlorothiazide','Hydrochlorothiazide','comprime','25mg','Diuretique thiazidique','SAIDAL'],
    ['Lercan','Lercanidipine','comprime','10mg','Antihypertenseur - ICA','PIERRE FABRE'],
    ['Lercan','Lercanidipine','comprime','20mg','Antihypertenseur - ICA','PIERRE FABRE'],
    ['Diltiazem','Diltiazem','comprime LP','300mg','Antihypertenseur - ICA','SAIDAL'],
    ['Adalate','Nifedipine','gelule','10mg','Antihypertenseur - ICA - Urgence','BAYER'],
    // ANTIDIABETIQUES
    ['Glucophage','Metformine','comprime','500mg','Antidiabetique oral - Biguanide','MERCK'],
    ['Glucophage','Metformine','comprime','850mg','Antidiabetique oral - Biguanide','MERCK'],
    ['Glucophage','Metformine','comprime','1000mg','Antidiabetique oral - Biguanide','MERCK'],
    ['Metformine SAIDAL','Metformine','comprime','500mg','Antidiabetique oral - Biguanide','SAIDAL'],
    ['Daonil','Glibenclamide','comprime','5mg','Antidiabetique oral - Sulfamide','SANOFI'],
    ['Diamicron','Gliclazide','comprime','80mg','Antidiabetique oral - Sulfamide','SERVIER'],
    ['Diamicron MR','Gliclazide','comprime MR','30mg','Antidiabetique oral - Sulfamide','SERVIER'],
    ['Diamicron MR','Gliclazide','comprime MR','60mg','Antidiabetique oral - Sulfamide','SERVIER'],
    ['Glipizide','Glipizide','comprime','5mg','Antidiabetique oral - Sulfamide','SAIDAL'],
    ['Januvia','Sitagliptine','comprime','100mg','Antidiabetique oral - Gliptine','MSD'],
    ['Onglyza','Saxagliptine','comprime','5mg','Antidiabetique oral - Gliptine','ASTRAZENECA'],
    ['Trajenta','Linagliptine','comprime','5mg','Antidiabetique oral - Gliptine','BOEHRINGER'],
    ['Jardiance','Empagliflozine','comprime','10mg','Antidiabetique oral - iSGLT2','BOEHRINGER'],
    ['Jardiance','Empagliflozine','comprime','25mg','Antidiabetique oral - iSGLT2','BOEHRINGER'],
    ['Forxiga','Dapagliflozine','comprime','10mg','Antidiabetique oral - iSGLT2','ASTRAZENECA'],
    ['Pioglitazone','Pioglitazone','comprime','15mg','Antidiabetique oral - Thiazolidinedione','SAIDAL'],
    ['Pioglitazone','Pioglitazone','comprime','30mg','Antidiabetique oral - Thiazolidinedione','SAIDAL'],
    ['Actrapid','Insuline humaine rapide','injectable','100UI/ml','Antidiabetique - Insuline','NOVO NORDISK'],
    ['Insulatard','Insuline humaine NPH','injectable','100UI/ml','Antidiabetique - Insuline','NOVO NORDISK'],
    ['Mixtard 30','Insuline humaine biphasique','injectable','100UI/ml','Antidiabetique - Insuline','NOVO NORDISK'],
    ['Humuline N','Insuline humaine NPH','injectable','100UI/ml','Antidiabetique - Insuline','LILLY'],
    ['Humuline R','Insuline humaine rapide','injectable','100UI/ml','Antidiabetique - Insuline','LILLY'],
    ['Lantus','Insuline glargine','injectable','100UI/ml','Antidiabetique - Insuline analogique','SANOFI'],
    ['Levemir','Insuline detemir','injectable','100UI/ml','Antidiabetique - Insuline analogique','NOVO NORDISK'],
    ['Novorapid','Insuline aspart','injectable','100UI/ml','Antidiabetique - Insuline rapide','NOVO NORDISK'],
    ['Apidra','Insuline glulisine','injectable','100UI/ml','Antidiabetique - Insuline rapide','SANOFI'],
    ['Victoza','Liraglutide','solution injectable','6mg/ml','Antidiabetique - GLP1','NOVO NORDISK'],
    // GASTROENTEROLOGIE
    ['Inexium','Esomeprazole','comprime','20mg','IPP','ASTRAZENECA'],
    ['Inexium','Esomeprazole','comprime','40mg','IPP','ASTRAZENECA'],
    ['Mopral','Omeprazole','gelule','20mg','IPP','ASTRAZENECA'],
    ['Omeprazole Biogaran','Omeprazole','gelule','20mg','IPP','BIOGARAN'],
    ['Lanzor','Lansoprazole','gelule','30mg','IPP','TAKEDA'],
    ['Pantoprazole','Pantoprazole','comprime','40mg','IPP','SAIDAL'],
    ['Inipomp','Pantoprazole','comprime','40mg','IPP','NYCOMED'],
    ['Pariet','Rabeprazole','comprime','20mg','IPP','JANSSEN'],
    ['Zantac','Ranitidine','comprime','150mg','Anti-H2','GSK'],
    ['Phosphalugel','Phosphate d aluminium','sachet','11g','Antiacide - Alginate','EISAI'],
    ['Maalox','Aluminium + Magnesium','sachet','1g','Antiacide','SANOFI'],
    ['Gaviscon','Alginate de sodium','sachet','500mg','Antiacide - Alginate','RECKITT'],
    ['Motilium','Domperidone','comprime','10mg','Prokinetique','JANSSEN'],
    ['Primperan','Metoclopramide','comprime','10mg','Prokinetique','SANOFI'],
    ['Spasfon','Phloroglucinol','comprime','80mg','Antispasmodique','CEPHALON'],
    ['Debridat','Trimebutine','comprime','100mg','Procinetique','IPSEN'],
    ['Smecta','Diosmectite','sachet','3g','Antidiarrheique - Adsorbant','IPSEN'],
    ['Imodium','Loperamide','gelule','2mg','Antidiarrheique','JANSSEN'],
    ['Enterol','Saccharomyces boulardii','gelule','250mg','Antidiarrheique - Probiotique','BIOCODEX'],
    ['Duphalac','Lactulose','sirop','667mg/ml','Laxatif osmotique','SOLVAY'],
    ['Movicol','Macrogol','sachet','13.8g','Laxatif osmotique','IPSEN'],
    ['Bisacodyl','Bisacodyl','comprime','5mg','Laxatif stimulant','SAIDAL'],
    ['Colchicine','Colchicine','comprime','1mg','Anti-inflammatoire - Goutte','SAIDAL'],
    ['Ursofalk','Acide ursodeoxycholique','gelule','250mg','Hepatoprotecteur','DR FALK'],
    // RESPIRATOIRE
    ['Ventoline','Salbutamol','aerosol','100mcg/dose','Bronchodilatateur - Beta2','GSK'],
    ['Bricanyl','Terbutaline','comprime','5mg','Bronchodilatateur - Beta2','ASTRAZENECA'],
    ['Foradil','Formoterol','gelule inhalation','12mcg','Bronchodilatateur - LABA','NOVARTIS'],
    ['Serevent','Salmeterol','aerosol','25mcg/dose','Bronchodilatateur - LABA','GSK'],
    ['Spiriva','Tiotropium','gelule inhalation','18mcg','Bronchodilatateur - Anticholinergique','BOEHRINGER'],
    ['Atrovent','Ipratropium','aerosol','20mcg/dose','Bronchodilatateur - Anticholinergique','BOEHRINGER'],
    ['Seretide','Salmeterol + Fluticasone','aerosol','25/250mcg','Bronchodilatateur + Corticoide inhale','GSK'],
    ['Symbicort','Formoterol + Budesonide','aerosol','6/200mcg','Bronchodilatateur + Corticoide inhale','ASTRAZENECA'],
    ['Becotide','Beclometasone','aerosol','250mcg/dose','Corticoide inhale','GSK'],
    ['Flixotide','Fluticasone','aerosol','250mcg/dose','Corticoide inhale','GSK'],
    ['Pulmicort','Budesonide','aerosol','200mcg/dose','Corticoide inhale','ASTRAZENECA'],
    ['Theophylline','Theophylline','comprime LP','300mg','Bronchodilatateur - Xanthine','SAIDAL'],
    ['Toplexil','Oxomemazine','sirop','0.33mg/ml','Antitussif','SANOFI'],
    ['Bronchokod','Carbocisteine','sirop','5%','Mucolytique','SANOFI'],
    ['Bronchokod','Carbocisteine','gelule','375mg','Mucolytique','SANOFI'],
    ['Mucomyst','Acetylcysteine','sachet','200mg','Mucolytique','ZAMBON'],
    ['Mucomyst','Acetylcysteine','sachet','600mg','Mucolytique','ZAMBON'],
    ['Exomuc','Acetylcysteine','sachet effervescent','200mg','Mucolytique','ZAMBON'],
    ['Bisolvon','Bromhexine','sirop','4mg/5ml','Mucolytique','BOEHRINGER'],
    ['Nasonex','Mometasone','spray nasal','50mcg/dose','Corticoide nasal','MSD'],
    ['Avamys','Fluticasone furoate','spray nasal','27.5mcg/dose','Corticoide nasal','GSK'],
    ['Rhinocort','Budesonide','spray nasal','64mcg/dose','Corticoide nasal','ASTRAZENECA'],
    // ANTIHISTAMINIQUES
    ['Aerius','Desloratadine','comprime','5mg','Antihistaminique H1','MSD'],
    ['Aerius','Desloratadine','sirop','0.5mg/ml','Antihistaminique H1','MSD'],
    ['Zyrtec','Cetirizine','comprime','10mg','Antihistaminique H1','UCB'],
    ['Zyrtec','Cetirizine','sirop','1mg/ml','Antihistaminique H1','UCB'],
    ['Clarityne','Loratadine','comprime','10mg','Antihistaminique H1','MSD'],
    ['Polaramine','Dexchlorpheniramine','comprime','2mg','Antihistaminique H1','MSD'],
    ['Phenergan','Promethazine','comprime','25mg','Antihistaminique H1 - Sedatif','SANOFI'],
    ['Xyzall','Levocetirizine','comprime','5mg','Antihistaminique H1','UCB'],
    ['Telfast','Fexofenadine','comprime','180mg','Antihistaminique H1','SANOFI'],
    // CORTICOIDES
    ['Solupred','Prednisolone','comprime orodispersible','20mg','Corticoide','SERVIER'],
    ['Celestene','Betamethasone','comprime','0.5mg','Corticoide','MSD'],
    ['Medrol','Methylprednisolone','comprime','16mg','Corticoide','PFIZER'],
    ['Medrol','Methylprednisolone','comprime','32mg','Corticoide','PFIZER'],
    ['Prednisone SAIDAL','Prednisone','comprime','5mg','Corticoide','SAIDAL'],
    ['Hydrocortisone','Hydrocortisone','poudre injectable','100mg','Corticoide','SAIDAL'],
    ['Kenacort-Retard','Triamcinolone','injectable','40mg/ml','Corticoide retard','BMS'],
    ['Depo-Medrol','Methylprednisolone','injectable','40mg/ml','Corticoide retard','PFIZER'],
    ['Dexamethasone','Dexamethasone','injectable','4mg/ml','Corticoide','SAIDAL'],
    ['Dexamethasone','Dexamethasone','comprime','0.5mg','Corticoide','SAIDAL'],
    ['Betnesol','Betamethasone','injectable','4mg/ml','Corticoide','GSK'],
    ['Cortancyl','Prednisone','comprime','5mg','Corticoide - Rhumatologie','SANOFI'],
    // CARDIO - Hypolipemiants
    ['Tahor','Atorvastatine','comprime','10mg','Hypolipemiant - Statine','PFIZER'],
    ['Tahor','Atorvastatine','comprime','20mg','Hypolipemiant - Statine','PFIZER'],
    ['Tahor','Atorvastatine','comprime','40mg','Hypolipemiant - Statine','PFIZER'],
    ['Tahor','Atorvastatine','comprime','80mg','Hypolipemiant - Statine','PFIZER'],
    ['Crestor','Rosuvastatine','comprime','10mg','Hypolipemiant - Statine','ASTRAZENECA'],
    ['Crestor','Rosuvastatine','comprime','20mg','Hypolipemiant - Statine','ASTRAZENECA'],
    ['Crestor','Rosuvastatine','comprime','40mg','Hypolipemiant - Statine','ASTRAZENECA'],
    ['Zocor','Simvastatine','comprime','20mg','Hypolipemiant - Statine','MSD'],
    ['Zocor','Simvastatine','comprime','40mg','Hypolipemiant - Statine','MSD'],
    ['Lipur','Fenofibrate','gelule','200mg','Hypolipemiant - Fibrate','SOLVAY'],
    ['Lipanthyl','Fenofibrate','gelule','160mg','Hypolipemiant - Fibrate','ABBOTT'],
    ['Ezetrol','Ezetimibe','comprime','10mg','Hypolipemiant - Inhibiteur absorption cholesterol','MSD'],
    // CARDIO - Antiagregeants et Anticoagulants
    ['Aspegic','Acide acetylsalicylique','sachet','100mg','Antiagregant plaquettaire','SANOFI'],
    ['Kardegic','Acide acetylsalicylique','sachet','75mg','Antiagregant plaquettaire','SANOFI'],
    ['Aspegic','Acide acetylsalicylique','sachet','500mg','Antalgique / Antiagregant','SANOFI'],
    ['Plavix','Clopidogrel','comprime','75mg','Antiagregant plaquettaire','SANOFI'],
    ['Brilique','Ticagrelor','comprime','90mg','Antiagregant plaquettaire','ASTRAZENECA'],
    ['Xarelto','Rivaroxaban','comprime','20mg','Anticoagulant - AOD','BAYER'],
    ['Xarelto','Rivaroxaban','comprime','15mg','Anticoagulant - AOD','BAYER'],
    ['Eliquis','Apixaban','comprime','5mg','Anticoagulant - AOD','BMS/PFIZER'],
    ['Eliquis','Apixaban','comprime','2.5mg','Anticoagulant - AOD','BMS/PFIZER'],
    ['Previscan','Fluindione','comprime','20mg','Anticoagulant - AVK','INNOTHERAP'],
    ['Sintrom','Acenocoumarol','comprime','4mg','Anticoagulant - AVK','NOVARTIS'],
    ['Lovenox','Enoxaparine','injectable','40mg/0.4ml','Anticoagulant - HBPM','SANOFI'],
    ['Lovenox','Enoxaparine','injectable','60mg/0.6ml','Anticoagulant - HBPM','SANOFI'],
    ['Fraxiparine','Nadroparine','injectable','0.3ml','Anticoagulant - HBPM','GSK'],
    // CARDIO - Autres
    ['Digoxine','Digoxine','comprime','0.25mg','Cardiotonique','SAIDAL'],
    ['Cordarone','Amiodarone','comprime','200mg','Antiarythmique','SANOFI'],
    ['Cordarone','Amiodarone','injectable','150mg/3ml','Antiarythmique','SANOFI'],
    ['Flecaine','Flecainide','comprime','100mg','Antiarythmique','ABBOTT'],
    ['Trinitrine','Nitroglycering','spray','0.3mg/dose','Vasodilatateur coronaire','SAIDAL'],
    ['Risordan','Isosorbide dinitrate','comprime sublingual','5mg','Vasodilatateur coronaire','SANOFI'],
    ['Procoralan','Ivabradine','comprime','5mg','Bradycardisant','SERVIER'],
    ['Procoralan','Ivabradine','comprime','7.5mg','Bradycardisant','SERVIER'],
    // NEUROLOGIE - Anxiolytiques
    ['Lexomil','Bromazepam','comprime','6mg','Anxiolytique - Benzodiazepine','ROCHE'],
    ['Temesta','Lorazepam','comprime','2.5mg','Anxiolytique - Benzodiazepine','WYETH'],
    ['Xanax','Alprazolam','comprime','0.25mg','Anxiolytique - Benzodiazepine','PFIZER'],
    ['Xanax','Alprazolam','comprime','0.5mg','Anxiolytique - Benzodiazepine','PFIZER'],
    ['Valium','Diazepam','comprime','5mg','Anxiolytique - Benzodiazepine','ROCHE'],
    ['Valium','Diazepam','injectable','10mg/2ml','Anxiolytique - Benzodiazepine','ROCHE'],
    ['Urbanyl','Clobazam','comprime','10mg','Anxiolytique/Antiepileptique','SANOFI'],
    ['Imovane','Zopiclone','comprime','7.5mg','Hypnotique','SANOFI'],
    ['Stilnox','Zolpidem','comprime','10mg','Hypnotique','SANOFI'],
    ['Atarax','Hydroxyzine','comprime','25mg','Anxiolytique - Antihistaminique','UCB'],
    ['Buspar','Buspirone','comprime','10mg','Anxiolytique - Azapirone','BMS'],
    // NEUROLOGIE - Antidepresseurs
    ['Prozac','Fluoxetine','gelule','20mg','Antidepresseur - ISRS','LILLY'],
    ['Deroxat','Paroxetine','comprime','20mg','Antidepresseur - ISRS','GSK'],
    ['Zoloft','Sertraline','comprime','50mg','Antidepresseur - ISRS','PFIZER'],
    ['Seroplex','Escitalopram','comprime','10mg','Antidepresseur - ISRS','LUNDBECK'],
    ['Seropram','Citalopram','comprime','20mg','Antidepresseur - ISRS','LUNDBECK'],
    ['Effexor LP','Venlafaxine','gelule LP','75mg','Antidepresseur - IRSNa','WYETH'],
    ['Effexor LP','Venlafaxine','gelule LP','150mg','Antidepresseur - IRSNa','WYETH'],
    ['Cymbalta','Duloxetine','gelule','60mg','Antidepresseur - IRSNa','LILLY'],
    ['Laroxyl','Amitriptyline','comprime','25mg','Antidepresseur - Tricyclique','ROCHE'],
    ['Norset','Mirtazapine','comprime','30mg','Antidepresseur - NaSSA','ORGANON'],
    ['Stablon','Tianeptine','comprime','12.5mg','Antidepresseur - Atypique','SERVIER'],
    // NEUROLOGIE - Antiepileptiques
    ['Depakine','Valproate de sodium','comprime','200mg','Antiepileptique','SANOFI'],
    ['Depakine Chrono','Valproate de sodium','comprime LP','500mg','Antiepileptique','SANOFI'],
    ['Tegretol','Carbamazepine','comprime','200mg','Antiepileptique','NOVARTIS'],
    ['Tegretol LP','Carbamazepine','comprime LP','400mg','Antiepileptique','NOVARTIS'],
    ['Di-Hydan','Phenytoine','comprime','100mg','Antiepileptique','SANOFI'],
    ['Rivotril','Clonazepam','comprime','2mg','Antiepileptique - Benzodiazepine','ROCHE'],
    ['Lamictal','Lamotrigine','comprime','100mg','Antiepileptique','GSK'],
    ['Keppra','Levetiracetam','comprime','500mg','Antiepileptique','UCB'],
    ['Keppra','Levetiracetam','comprime','1000mg','Antiepileptique','UCB'],
    ['Lyrica','Pregabaline','gelule','75mg','Antiepileptique / Douleur neuropathique','PFIZER'],
    ['Lyrica','Pregabaline','gelule','150mg','Antiepileptique / Douleur neuropathique','PFIZER'],
    ['Neurontin','Gabapentine','gelule','300mg','Antiepileptique / Douleur neuropathique','PFIZER'],
    ['Topamax','Topiramate','comprime','100mg','Antiepileptique','JANSSEN'],
    ['Trileptal','Oxcarbazepine','comprime','300mg','Antiepileptique','NOVARTIS'],
    // NEUROLOGIE - Antipsychotiques
    ['Largactil','Chlorpromazine','comprime','100mg','Antipsychotique - Phenothiazine','SANOFI'],
    ['Haldol','Haloperidol','comprime','5mg','Antipsychotique - Butyrophenone','JANSSEN'],
    ['Risperdal','Risperidone','comprime','2mg','Antipsychotique - Atypique','JANSSEN'],
    ['Zyprexa','Olanzapine','comprime','10mg','Antipsychotique - Atypique','LILLY'],
    ['Leponex','Clozapine','comprime','100mg','Antipsychotique - Atypique','NOVARTIS'],
    ['Tercian','Cyamemazine','comprime','100mg','Antipsychotique - Phenothiazine','SANOFI'],
    ['Solian','Amisulpride','comprime','400mg','Antipsychotique - Benzamide','SANOFI'],
    // NEUROLOGIE - Autres
    ['Sinemet','Levodopa + Carbidopa','comprime','100mg/25mg','Antiparkinsonien','MSD'],
    ['Imigrane','Sumatriptan','comprime','50mg','Antimigraine - Triptan','GSK'],
    ['Betaserc','Betahistine','comprime','16mg','Antivertigineux','SOLVAY'],
    ['Betaserc','Betahistine','comprime','24mg','Antivertigineux','SOLVAY'],
    ['Tanganil','Acetyl-DL-leucine','comprime','500mg','Antivertigineux','PIERRE FABRE'],
    ['Nootropyl','Piracetam','gelule','800mg','Nootrope','UCB'],
    ['Aricept','Donepezil','comprime','10mg','Traitement Alzheimer','EISAI/PFIZER'],
    // ANTIVIRAUX
    ['Zovirax','Aciclovir','comprime','200mg','Antiviral - Herpes','GSK'],
    ['Zovirax','Aciclovir','comprime','400mg','Antiviral - Herpes','GSK'],
    ['Zovirax','Aciclovir','creme','5%','Antiviral - Herpes - Topique','GSK'],
    ['Famvir','Famciclovir','comprime','500mg','Antiviral - Herpes','NOVARTIS'],
    ['Valtrex','Valaciclovir','comprime','500mg','Antiviral - Herpes','GSK'],
    ['Tamiflu','Oseltamivir','gelule','75mg','Antiviral - Grippe','ROCHE'],
    ['Sovaldi','Sofosbuvir','comprime','400mg','Antiviral - Hepatite C','GILEAD'],
    ['Epivir','Lamivudine','comprime','150mg','Antiviral - Hepatite B','GSK'],
    ['Tenofovir','Tenofovir','comprime','300mg','Antiviral - Hepatite B','SAIDAL'],
    // ANTIFONGIQUES
    ['Diflucan','Fluconazole','gelule','150mg','Antifongique - Triazole','PFIZER'],
    ['Diflucan','Fluconazole','gelule','50mg','Antifongique - Triazole','PFIZER'],
    ['Sporanox','Itraconazole','gelule','100mg','Antifongique - Triazole','JANSSEN'],
    ['Nizoral','Ketoconazole','comprime','200mg','Antifongique - Imidazole','JANSSEN'],
    ['Nizoral','Ketoconazole','shampoing','2%','Antifongique - Topique','JANSSEN'],
    ['Lamisil','Terbinafine','comprime','250mg','Antifongique - Allylamine','NOVARTIS'],
    ['Lamisil','Terbinafine','creme','1%','Antifongique - Topique','NOVARTIS'],
    ['Econazole','Econazole','creme','1%','Antifongique - Topique','SAIDAL'],
    ['Mycostatine','Nystatin','suspension','100000UI/ml','Antifongique - Oral','SAIDAL'],
    ['Ciclopirox','Ciclopirox','vernis','8%','Antifongique - Ongles','SAIDAL'],
    // ANTIPARASITAIRES
    ['Zentel','Albendazole','comprime','400mg','Antiparasitaire - Antihelminthique','GSK'],
    ['Stromectol','Ivermectine','comprime','3mg','Antiparasitaire - Antihelminthique','MSD'],
    ['Biltricide','Praziquantel','comprime','600mg','Antiparasitaire - Antihelminthique','BAYER'],
    ['Malarone','Atovaquone + Proguanil','comprime','250mg/100mg','Antiparasitaire - Antipaludeen','GSK'],
    ['Nivaquine','Chloroquine','comprime','100mg','Antiparasitaire - Antipaludeen','SANOFI'],
    ['Quinine','Quinine','comprime','250mg','Antiparasitaire - Antipaludeen','SAIDAL'],
    // OPHTALMOLOGIE
    ['Tobradex','Tobramycine + Dexamethasone','collyre','0.3%/0.1%','Ophtalmologie - Antibiotique + Corticoide','ALCON'],
    ['Ciflox','Ciprofloxacine','collyre','0.3%','Ophtalmologie - Antibiotique','ALCON'],
    ['Tobrex','Tobramycine','collyre','0.3%','Ophtalmologie - Antibiotique','ALCON'],
    ['Timoptol','Timolol','collyre','0.5%','Ophtalmologie - Glaucome','MSD'],
    ['Lumigan','Bimatoprost','collyre','0.01%','Ophtalmologie - Glaucome','ALLERGAN'],
    ['Xalatan','Latanoprost','collyre','0.005%','Ophtalmologie - Glaucome','PFIZER'],
    ['Atropine','Atropine','collyre','1%','Ophtalmologie - Mydriatique','SAIDAL'],
    ['Larmes artificielles','Sodium hyaluronate','collyre','0.1%','Ophtalmologie - Lubrifiant','SAIDAL'],
    // DERMATOLOGIE
    ['Diprosone','Betamethasone','creme','0.05%','Dermatologie - Corticoide fort','SCHERING'],
    ['Triderm','Betamethasone + Gentamicine + Clotrimazole','creme','combinaison','Dermatologie - Corticoide + ATB + Antifongique','SCHERING'],
    ['Betnovate','Betamethasone','creme','0.1%','Dermatologie - Corticoide fort','GSK'],
    ['Locoid','Hydrocortisone butyrate','creme','0.1%','Dermatologie - Corticoide modere','ASTELLAS'],
    ['Dalacine T','Clindamycine','gel','1%','Dermatologie - Antibiotique topique','PFIZER'],
    ['Eryacne','Erythromycine','gel','4%','Dermatologie - Antibiotique topique','GALDERMA'],
    ['Roaccutane','Isotretinoine','gelule','20mg','Dermatologie - Retinomimetique oral','ROCHE'],
    ['Roaccutane','Isotretinoine','gelule','10mg','Dermatologie - Retinomimetique oral','ROCHE'],
    // GYNECOLOGIE
    ['Duphaston','Dydrogesterone','comprime','10mg','Gynecologie - Progesteron','SOLVAY'],
    ['Utrogestan','Progesterone','gelule','100mg','Gynecologie - Progesterone','BESINS'],
    ['Utrogestan','Progesterone','gelule','200mg','Gynecologie - Progesterone','BESINS'],
    ['Provera','Medroxyprogesterone','comprime','10mg','Gynecologie - Progesteron','PFIZER'],
    ['Norlevo','Levonorgestrel','comprime','1.5mg','Gynecologie - Contraception urgence','HRA PHARMA'],
    ['Minidril','Levonorgestrel + Ethinylestradiol','comprime','0.15mg/0.03mg','Gynecologie - Contraceptif oestroprogestatif','PFIZER'],
    ['Norgeston','Levonorgestrel','comprime','0.03mg','Gynecologie - Contraceptif microprogestatif','BAYER'],
    ['Tergynan','Nystatin + Ternidazole + Neomycine + Prednisolone','comprime vaginal','combinaison','Gynecologie - Antiinfectieux vaginal','SAIDAL'],
    // UROLOGIE
    ['Xatral','Alfuzosine','comprime LP','10mg','Urologie - Alpha-bloquant','SANOFI'],
    ['Tamsulosine','Tamsulosine','gelule LP','0.4mg','Urologie - Alpha-bloquant','SAIDAL'],
    ['Proscar','Finasteride','comprime','5mg','Urologie - Inhibiteur 5-alpha reductase','MSD'],
    ['Avodart','Dutasteride','gelule','0.5mg','Urologie - Inhibiteur 5-alpha reductase','GSK'],
    ['Solifenacine','Solifenacine','comprime','5mg','Urologie - Anticholinergique','ASTELLAS'],
    // THYROIDE
    ['Levothyrox','Levothyroxine','comprime','50mcg','Thyroide - Hormone thyroidienne','MERCK'],
    ['Levothyrox','Levothyroxine','comprime','75mcg','Thyroide - Hormone thyroidienne','MERCK'],
    ['Levothyrox','Levothyroxine','comprime','100mcg','Thyroide - Hormone thyroidienne','MERCK'],
    ['Thyrofix','Levothyroxine','comprime','75mcg','Thyroide - Hormone thyroidienne','SAIDAL'],
    ['Neomercazole','Carbimazole','comprime','5mg','Thyroide - Antithyroidien','ROCHE'],
    ['Propylthiouracile','Propylthiouracile','comprime','50mg','Thyroide - Antithyroidien','SAIDAL'],
    // VITAMINES ET COMPLEMENTS
    ['Vitamine C','Acide ascorbique','comprime','500mg','Vitamine C','SAIDAL'],
    ['Vitamine C','Acide ascorbique','comprime effervescent','1000mg','Vitamine C','SAIDAL'],
    ['Vitamin D3','Cholecalciferol','comprime','1000UI','Vitamine D3','SAIDAL'],
    ['Uvedose','Cholecalciferol','ampoule buvable','100000UI','Vitamine D3','SAIDAL'],
    ['Zymad','Cholecalciferol','ampoule buvable','200000UI','Vitamine D3','SAIDAL'],
    ['Folacine','Acide folique','comprime','5mg','Vitamine B9','SAIDAL'],
    ['Tardyferon B9','Fer + Acide folique','comprime','80mg/0.35mg','Fer + Vitamine B9','PIERRE FABRE'],
    ['Tardyferon','Sulfate ferreux','comprime','80mg','Fer - Anemie carentielle','PIERRE FABRE'],
    ['Timoferan','Fer','comprime','50mg','Fer - Anemie carentielle','SAIDAL'],
    ['Ferrostrane','Fumarate ferreux','sirop','34mg/5ml','Fer - Anemie carentielle','SAIDAL'],
    ['Vitamine B12','Cyanocobalamine','injectable','1mg/ml','Vitamine B12','SAIDAL'],
    ['Neurobion','B1 + B6 + B12','comprime','100mg/200mg/200mcg','Vitamines B complexe','MERCK'],
    ['Magne B6','Magnesium + Vitamine B6','comprime','48mg/5mg','Magnesium + Vitamine B6','SANOFI'],
    ['Calcium SAIDAL','Calcium carbonate','sachet','1g','Calcium','SAIDAL'],
    ['Cacit D3','Calcium + Vitamine D3','sachet','1g/880UI','Calcium + Vitamine D3','PROCTER'],
    ['Calperos','Calcium + Vitamine D3','comprime','1g/400UI','Calcium + Vitamine D3','SAIDAL'],
    ['Zinc','Sulfate de zinc','comprime','45mg','Oligo-element - Zinc','SAIDAL'],
    // RHUMATOLOGIE
    ['Plaquenil','Hydroxychloroquine','comprime','200mg','Rhumatologie - Antipaludeen de synthese','SANOFI'],
    ['Methotrexate','Methotrexate','comprime','2.5mg','Rhumatologie - DMARD - Immunosuppresseur','SAIDAL'],
    ['Methotrexate','Methotrexate','injectable','50mg/2ml','Rhumatologie - DMARD - Immunosuppresseur','SAIDAL'],
    ['Arava','Leflunomide','comprime','20mg','Rhumatologie - DMARD','SANOFI'],
    ['Allopurinol','Allopurinol','comprime','100mg','Rhumatologie - Hyperuricemiant - Goutte','SAIDAL'],
    ['Allopurinol','Allopurinol','comprime','300mg','Rhumatologie - Hyperuricemiant - Goutte','SAIDAL'],
    ['Zyloric','Allopurinol','comprime','300mg','Rhumatologie - Goutte','GSK'],
    ['Colchimax','Colchicine','comprime','0.5mg','Rhumatologie - Crise de goutte','SAIDAL'],
    // OSTEOPOROSE
    ['Fosamax','Alendronate','comprime','70mg','Osteoporose - Biphosphonate','MSD'],
    ['Actonel','Risedronate','comprime','35mg','Osteoporose - Biphosphonate','PROCTER'],
    ['Bonviva','Ibandronate','comprime','150mg','Osteoporose - Biphosphonate','ROCHE'],
    ['Calcitonine','Calcitonine de saumon','spray nasal','200UI','Osteoporose - Calcitonine','NOVARTIS'],
    // ANTISEPTIQUES ET SOLUTIONS
    ['Betadine','Povidone iodee','solution','10%','Antiseptique - Dermique','MEDA'],
    ['Betadine','Povidone iodee','gel','10%','Antiseptique - Dermique','MEDA'],
    ['Chlorhexidine','Chlorhexidine','solution','0.5%','Antiseptique - Dermique','SAIDAL'],
    ['Eau oxygenee','Peroxyde d hydrogene','solution','3%','Antiseptique - Dermique','SAIDAL'],
    // ANESTHESIQUES ET URGENCES
    ['Xylocaine','Lidocaine','injectable','2%','Anesthesique local','ASTRAZENECA'],
    ['Marcaine','Bupivacaine','injectable','0.5%','Anesthesique local','ASTRAZENECA'],
    ['Morphine','Morphine','injectable','10mg/ml','Antalgique opioide majeur','SAIDAL'],
    ['Naloxone','Naloxone','injectable','0.4mg/ml','Antidote opioide','SAIDAL'],
    ['Atropine','Atropine','injectable','1mg/ml','Anticholinergique - Urgence','SAIDAL'],
    // PERFUSIONS
    ['NaCl 0.9%','Chlorure de sodium','perfusion','9mg/ml','Solute de remplissage','SAIDAL'],
    ['Glucose 5%','Glucose','perfusion','5%','Solute de remplissage','SAIDAL'],
    ['Glucose 10%','Glucose','perfusion','10%','Solute de remplissage','SAIDAL'],
    ['Ringer Lactate','Ringer + Lactate','perfusion','1000ml','Solute de remplissage','SAIDAL'],
    ['Bicarbonate de sodium','Bicarbonate de sodium','injectable','42mg/ml','Correcteur acidobase','SAIDAL'],
    ['Chlorure de potassium','Chlorure de potassium','ampoule','0.5g/5ml','Electrolyte - Kaliemie','SAIDAL'],
    ['Tranexamide','Acide tranexamique','injectable','500mg/5ml','Antifibrinolytique - Hemorragie','SAIDAL'],
  ];
  store.db.run('BEGIN TRANSACTION');
  try {
    const stmt = store.db.prepare('INSERT OR IGNORE INTO medicaments (nom_commercial,dci,forme,dosage,classe,fabricant) VALUES (?, ?, ?, ?, ?, ?)');
    rows.forEach((row) => { stmt.bind(row); stmt.step(); stmt.reset(); });
    stmt.free();
    store.db.run('COMMIT');
  } catch (e) {
    store.db.run('ROLLBACK');
    throw e;
  }
  store.save();
}

function patientPayload(data) {
  return {
    nom: required(data.nom, 'Nom'), prenom: required(data.prenom, 'Prenom'), date_naissance: nullable(data.date_naissance),
    sexe: nullable(data.sexe), telephone: nullable(data.telephone), telephone2: nullable(data.telephone2), email: nullable(data.email),
    adresse: nullable(data.adresse), ville: nullable(data.ville), wilaya: nullable(data.wilaya), numero_securite: nullable(data.numero_securite),
    mutuelle: nullable(data.mutuelle), groupe_sanguin: nullable(data.groupe_sanguin),
    taille: nullable(data.taille), poids: nullable(data.poids),
    allergies: nullable(data.allergies),
    antecedents: nullable(data.antecedents), antecedents_familiaux: nullable(data.antecedents_familiaux),
    traitement_en_cours: nullable(data.traitement_en_cours), notes: nullable(data.notes), photo_path: nullable(data.photo_path)
  };
}

module.exports = { initDatabase };
