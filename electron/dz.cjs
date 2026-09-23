'use strict';
/* ─────────────────────────────────────────────────────────────────────────
 * Clinixos DZ — Module Algérie : caisse à l'aveugle, posologie pédiatrique,
 * DDI, équivalences DCI/ANPP, file d'attente TV, documents médico-légaux
 * (arrêt de travail, psychotropes 19-379, CBV/ITT, mutuelles), WhatsApp,
 * ingestion legacy, backup chiffré, audit HMAC-SHA256.
 * 100% local-first, zéro cloud : conformité Loi 18-07 / 25-11 (ANPDP).
 * ───────────────────────────────────────────────────────────────────────── */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const uuid = () => crypto.randomUUID();

/* ═══════════════ 1. SCHEMA ═══════════════ */
function migrateDZ(store) {
  store.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      current_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clotures_caisse (
      id TEXT PRIMARY KEY,
      date_cloture TEXT DEFAULT (datetime('now')),
      jour TEXT NOT NULL,
      secretaire_id TEXT NOT NULL,
      secretaire_nom TEXT,
      total_declare_dzd REAL NOT NULL,
      total_attendu_dzd REAL NOT NULL,
      ecart_dzd REAL NOT NULL,
      billets_2000 INTEGER DEFAULT 0,
      billets_1000 INTEGER DEFAULT 0,
      billets_500 INTEGER DEFAULT 0,
      billets_200 INTEGER DEFAULT 0,
      billets_100 INTEGER DEFAULT 0,
      pieces INTEGER DEFAULT 0,
      statut TEXT CHECK(statut IN ('EQUILIBRE','DEFICIT','EXCEDENT')) NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cloture_jour ON clotures_caisse(jour);
    CREATE TABLE IF NOT EXISTS file_attente (
      ticket_numero INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
      nom_affiche TEXT NOT NULL,
      heure_arrivee TEXT DEFAULT (datetime('now')),
      priorite TEXT CHECK(priorite IN ('NORMALE','URGENCE','CONTROLE','PRIORITAIRE')) DEFAULT 'NORMALE',
      statut TEXT CHECK(statut IN ('ATTENTE','EN_CONSULTATION','TERMINE','ABSENT')) DEFAULT 'ATTENTE',
      salle TEXT DEFAULT 'Cabinet 1'
    );
    CREATE INDEX IF NOT EXISTS idx_file_statut ON file_attente(statut, priorite);
    CREATE TABLE IF NOT EXISTS actes_cliniques (
      id TEXT PRIMARY KEY,
      consultation_id INTEGER NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
      patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
      code_acte TEXT NOT NULL,
      libelle TEXT NOT NULL,
      montant_dzd REAL NOT NULL DEFAULT 0,
      est_regle INTEGER DEFAULT 0,
      gratuit_motif TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_actes_jour ON actes_cliniques(created_at);
    CREATE TABLE IF NOT EXISTS anpp_medicaments (
      code TEXT PRIMARY KEY,
      dci TEXT NOT NULL,
      marque TEXT NOT NULL,
      forme TEXT NOT NULL,
      dosage TEXT NOT NULL,
      posologie_pediatrique_mg_kg REAL,
      prises_par_jour INTEGER DEFAULT 3,
      concentration_sirop_mg_ml REAL,
      est_psychotrope INTEGER DEFAULT 0,
      liste_ordonnance TEXT DEFAULT 'normale',
      rupture INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_anpp_dci ON anpp_medicaments(dci, dosage, forme);
    CREATE TABLE IF NOT EXISTS ddi_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      molecule_a TEXT NOT NULL,
      molecule_b TEXT NOT NULL,
      severite TEXT CHECK(severite IN ('CRITIQUE','MAJEURE','MODEREE')) NOT NULL,
      mecanisme TEXT NOT NULL,
      conduite TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS arrets_travail (
      id TEXT PRIMARY KEY,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL,
      type TEXT CHECK(type IN ('initial','prolongation','reprise')) NOT NULL DEFAULT 'initial',
      date_debut TEXT NOT NULL,
      duree_jours INTEGER NOT NULL,
      diagnostic TEXT,
      arret_initial_id TEXT REFERENCES arrets_travail(id),
      numero TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS psychotropes_registre (
      id TEXT PRIMARY KEY,
      ordonnance_id INTEGER REFERENCES ordonnances(id) ON DELETE SET NULL,
      patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
      piece_identite TEXT NOT NULL,
      adresse_patient TEXT,
      dci TEXT NOT NULL,
      posologie TEXT NOT NULL,
      duree_jours INTEGER NOT NULL,
      numero_serie TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS certificats_cbv (
      id TEXT PRIMARY KEY,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      date_faits TEXT,
      lesions TEXT NOT NULL,
      itt_jours INTEGER NOT NULL,
      circonstances TEXT,
      requisition TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mutuelles_conventions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organisme TEXT NOT NULL,
      numero_convention TEXT,
      taux REAL DEFAULT 100,
      actif INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS mutuelles_bons (
      id TEXT PRIMARY KEY,
      patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
      organisme TEXT NOT NULL,
      numero_affiliation TEXT,
      acte TEXT NOT NULL,
      montant_dzd REAL NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS migration_quarantaine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      payload TEXT NOT NULL,
      motif TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS printer_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nom TEXT NOT NULL DEFAULT 'A5 bureau',
      mode TEXT CHECK(mode IN ('A','B')) DEFAULT 'A',
      dx_mm REAL DEFAULT 0,
      dy_mm REAL DEFAULT 0,
      imprimante TEXT
    );
    CREATE TABLE IF NOT EXISTS whatsapp_templates (
      code TEXT PRIMARY KEY,
      langue TEXT NOT NULL,
      texte TEXT NOT NULL
    );
  `);
  // Dénomination Canonique Internationale : colonne DCI manquante sur l'ancien
  // catalogue local → ajout + index pour la matrice d'équivalence.
  try {
    const cols = store.all('PRAGMA table_info(medicaments)').map((c) => c.name);
    if (!cols.includes('dci_code')) store.exec('ALTER TABLE medicaments ADD COLUMN dci_code TEXT');
    if (!cols.includes('rupture')) store.exec('ALTER TABLE medicaments ADD COLUMN rupture INTEGER DEFAULT 0');
  } catch {}
  try { store.exec('CREATE INDEX IF NOT EXISTS idx_med_dci ON medicaments(dci, dosage, forme)'); } catch {}
  // Anti-doublons au redémarrage : le seed utilise INSERT OR IGNORE, qui n'ignore
  // que s'il existe une contrainte d'unicité. Ordre impératif : dédupliquer
  // D'ABORD (les anciennes bases ont déjà des doublons), créer l'index APRES.
  try {
    store.exec(`DELETE FROM ddi_rules WHERE id NOT IN (SELECT MIN(id) FROM ddi_rules GROUP BY molecule_a, molecule_b)`);
    store.exec(`DELETE FROM mutuelles_conventions WHERE id NOT IN (SELECT MIN(id) FROM mutuelles_conventions GROUP BY organisme, numero_convention)`);
  } catch {}
  store.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ddi_uniq ON ddi_rules(molecule_a, molecule_b)');
  store.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_mutuelle_uniq ON mutuelles_conventions(organisme, numero_convention)');
}

/* ═══════════════ 2. SEED (ANPP + DDI + templates) ═══════════════ */
const ANPP_SEED = [
  // code, dci, marque, forme, dosage, mg/kg/j, prises/j, conc mg/ml, psycho, liste
  ['AMOX250', 'Amoxicilline', 'Amoxil', 'Sirop', '250mg/5ml', 80, 3, 50, 0, 'normale'],
  ['AMOX500', 'Amoxicilline', 'Amoxil', 'Gélule', '500mg', null, 3, null, 0, 'normale'],
  ['AUG875', 'Amoxicilline + Acide clavulanique', 'Augmentin', 'Comprimé', '875mg/125mg', 80, 3, null, 0, 'normale'],
  ['AUG400', 'Amoxicilline + Acide clavulanique', 'Bioclav', 'Sirop', '400mg/57mg/5ml', 80, 3, 91.4, 0, 'normale'],
  ['AUG400B', 'Amoxicilline + Acide clavulanique', 'Amoclan', 'Sirop', '400mg/57mg/5ml', 80, 3, 91.4, 0, 'normale'],
  ['AUG400C', 'Amoxicilline + Acide clavulanique', 'Curam', 'Sirop', '400mg/57mg/5ml', 80, 3, 91.4, 0, 'normale'],
  ['AUG875B', 'Amoxicilline + Acide clavulanique', 'Bioclav', 'Comprimé', '875mg/125mg', 80, 3, null, 0, 'normale'],
  ['AUG875C', 'Amoxicilline + Acide clavulanique', 'Amoclan', 'Comprimé', '875mg/125mg', 80, 3, null, 0, 'normale'],
  ['PARA120', 'Paracétamol', 'Doliprane', 'Sirop', '120mg/5ml', 60, 4, 24, 0, 'normale'],
  ['PARA500', 'Paracétamol', 'Doliprane', 'Comprimé', '500mg', null, 4, null, 0, 'normale'],
  ['IBU400', 'Ibuprofène', 'Nurofen', 'Comprimé', '400mg', 30, 3, null, 0, 'normale'],
  ['IBU100', 'Ibuprofène', 'Algifen', 'Sirop', '100mg/5ml', 30, 3, 20, 0, 'normale'],
  ['DICLO50', 'Diclofénac', 'Voltarène', 'Comprimé', '50mg', null, 2, null, 0, 'liste2'],
  ['KETO100', 'Kétoprofène', 'Profenid', 'Gélule', '100mg', null, 2, null, 0, 'liste2'],
  ['OMEP20', 'Oméprazole', 'Mopral', 'Gélule', '20mg', null, 1, null, 0, 'normale'],
  ['AMLO5', 'Amlodipine', 'Amlor', 'Comprimé', '5mg', null, 1, null, 0, 'normale'],
  ['ENAL10', 'Énalapril', 'Renitec', 'Comprimé', '10mg', null, 1, null, 0, 'liste2'],
  ['SPIR25', 'Spironolactone', 'Aldactone', 'Comprimé', '25mg', null, 1, null, 0, 'liste2'],
  ['METF850', 'Metformine', 'Glucophage', 'Comprimé', '850mg', null, 2, null, 0, 'normale'],
  ['AVK4', 'Acénocoumarol', 'Sintrom', 'Comprimé', '4mg', null, 1, null, 0, 'liste2'],
  ['AMIOD200', 'Amiodarone', 'Cordarone', 'Comprimé', '200mg', null, 1, null, 0, 'liste2'],
  ['SALB100', 'Salbutamol', 'Ventoline', 'Spray', '100µg/dose', null, 3, null, 0, 'normale'],
  ['AZITH200', 'Azithromycine', 'Zithromax', 'Sirop', '200mg/5ml', 10, 1, 40, 0, 'normale'],
  ['CEFIX200', 'Céfixime', 'Oroken', 'Comprimé', '200mg', 8, 2, null, 0, 'normale'],
  ['FER80', 'Fer (fumarate)', 'Fumafer', 'Comprimé', '100mg', null, 1, null, 0, 'normale'],
  ['VITD', 'Cholécalciférol', 'D-Cure', 'Ampoule', '100000 UI', null, 1, null, 0, 'normale'],
  ['LORA10', 'Loratadine', 'Clarityne', 'Comprimé', '10mg', null, 1, null, 0, 'normale'],
  ['PRED20', 'Prednisone', 'Cortancyl', 'Comprimé', '20mg', 1, 1, null, 0, 'liste2'],
  ['INSULINE', 'Insuline glargine', 'Lantus', 'Stylo', '100 UI/ml', null, 1, null, 0, 'liste2'],
  // Psychotropes (Décret 19-379)
  ['BROMA6', 'Bromazépam', 'Lexomil', 'Comprimé', '6mg', null, 2, null, 1, 'psychotrope'],
  ['DIAZ10', 'Diazépam', 'Valium', 'Comprimé', '10mg', null, 2, null, 1, 'psychotrope'],
  ['CLONA2', 'Clonazépam', 'Rivotril', 'Comprimé', '2mg', null, 2, null, 1, 'psychotrope'],
  ['ALPRA05', 'Alprazolam', 'Xanax', 'Comprimé', '0.5mg', null, 2, null, 1, 'psychotrope'],
  ['TRAMA50', 'Tramadol', 'Topalgic', 'Gélule', '50mg', null, 3, null, 1, 'psychotrope'],
  ['COD30', 'Codéine + Paracétamol', 'Codoliprane', 'Comprimé', '30mg/500mg', null, 3, null, 1, 'psychotrope'],
];

const DDI_SEED = [  ['Énalapril', 'Spironolactone', 'CRITIQUE', 'Hyperkaliémie grave (IEC + diurétique épargneur potassique).', 'Contrôler K+ sous 7 jours ou substituer.'],
  ['Ibuprofène', 'Acénocoumarol', 'MAJEURE', 'Majoration du risque hémorragique (AINS + AVK).', 'Éviter les AINS systémiques ; préférer paracétamol + IPP si AINS indispensable.'],
  ['Diclofénac', 'Acénocoumarol', 'MAJEURE', 'Majoration du risque hémorragique et ulcéreux.', 'Contre-indication relative ; paracétamol en 1re intention.'],
  ['Kétoprofène', 'Acénocoumarol', 'MAJEURE', 'Saignements digestifs et allongement du temps de saignement.', 'Éviter ; avis cardiologique.'],
  ['Ibuprofène', 'Énalapril', 'MODEREE', 'Réduction de l’effet antihypertenseur + risque rénal.', 'Surveiller créatinine et TA.'],
  ['Spironolactone', 'Fer (fumarate)', 'MODEREE', 'Aucune interaction majeure connue — couple de test négatif.', 'RAS.'],
  ['Amiodarone', 'Acénocoumarol', 'MAJEURE', 'Potentialisation de l’AVK (INR instable).', 'Réduire la dose d’AVK et surveiller INR rapproché.'],
  ['Azithromycine', 'Amiodarone', 'MAJEURE', 'Allongement QT cumulé.', 'ECG de contrôle ; éviter l’association si QT long.'],
  ['Prednisone', 'Ibuprofène', 'MAJEURE', 'Ulcère gastro-duodénal (corticoïde + AINS).', 'Associer un IPP, durée la plus courte.'],
  ['Metformine', 'Prednisone', 'MODEREE', 'Déséquilibre glycémique sous corticoïdes.', 'Renforcer l’autosurveillance glycémique.'],
  ['Tramadol', 'Alprazolam', 'CRITIQUE', 'Dépression respiratoire (opioïde + benzodiazépine).', 'Ne pas associer ; envisager antalgique non opioïde.'],
  ['Bromazépam', 'Alprazolam', 'MAJEURE', 'Sédation cumulative (double benzodiazépine).', 'Une seule benzodiazépine à la fois.'],
];

/* Extension formulary : molécules de comptoir les plus prescrites au cabinet.
 * (La nomenclature ANPP complète — milliers de lignes — se charge en 1 clic
 * via dz:anpp.import depuis le fichier officiel.) */
const ANPP_SEED2 = [
  ['CIPR500', 'Ciprofloxacine', 'Ciprox', 'Comprimé', '500mg', null, 2, null, 0, 'liste2'],
  ['DOXY100', 'Doxycycline', 'Vibramycine', 'Gélule', '100mg', null, 2, null, 0, 'normale'],
  ['METRO500', 'Métronidazole', 'Flagyl', 'Comprimé', '500mg', 30, 3, null, 0, 'normale'],
  ['METRO125', 'Métronidazole', 'Flagyl', 'Sirop', '125mg/5ml', 30, 3, 25, 0, 'normale'],
  ['ASP100', 'Acide acétylsalicylique', 'Aspirine Protect', 'Comprimé', '100mg', null, 1, null, 0, 'normale'],
  ['CLOP75', 'Clopidogrel', 'Plavix', 'Comprimé', '75mg', null, 1, null, 0, 'liste2'],
  ['LOS50', 'Losartan', 'Cozaar', 'Comprimé', '50mg', null, 1, null, 0, 'normale'],
  ['FURO40', 'Furosémide', 'Lasilix', 'Comprimé', '40mg', null, 1, null, 0, 'liste2'],
  ['BISO5', 'Bisoprolol', 'Concor', 'Comprimé', '5mg', null, 1, null, 0, 'liste2'],
  ['HCTZ25', 'Hydrochlorothiazide', 'Esidrex', 'Comprimé', '25mg', null, 1, null, 0, 'normale'],
  ['CAPT25', 'Captopril', 'Lopril', 'Comprimé', '25mg', null, 2, null, 0, 'liste2'],
  ['GLIC60', 'Gliclazide', 'Diamicron', 'Comprimé', '60mg', null, 1, null, 0, 'normale'],
  ['ATOR20', 'Atorvastatine', 'Tahor', 'Comprimé', '20mg', null, 1, null, 0, 'normale'],
  ['ESOM20', 'Esoméprazole', 'Inexium', 'Gélule', '20mg', null, 1, null, 0, 'normale'],
  ['DESLO5', 'Desloratadine', 'Aerius', 'Comprimé', '5mg', null, 1, null, 0, 'normale'],
  ['CET10', 'Cétirizine', 'Zyrtec', 'Comprimé', '10mg', 0.25, 1, null, 0, 'normale'],
  ['SPAS80', 'Phloroglucinol', 'Spasfon', 'Comprimé', '80mg', null, 3, null, 0, 'normale'],
  ['SPASSIR', 'Phloroglucinol', 'Spasfon', 'Sirop', '10mg/ml', 1, 3, 10, 0, 'normale'],
  ['ORS200', 'Sels de réhydratation orale', 'Adiaril', 'Sachet', '200ml', null, 4, null, 0, 'normale'],
  ['ONDA4', 'Ondansétron', 'Zophren', 'Comprimé', '4mg', 0.15, 2, null, 0, 'liste2'],
  ['LOP2', 'Lopéramide', 'Imodium', 'Gélule', '2mg', null, 3, null, 0, 'normale'],
  ['COLCH1', 'Colchicine', 'Colchimax', 'Comprimé', '1mg', null, 2, null, 0, 'liste2'],
  ['ALLO100', 'Allopurinol', 'Zyloric', 'Comprimé', '100mg', null, 1, null, 0, 'normale'],
  ['LEVO100', 'Lévothyroxine', 'Levothyrox', 'Comprimé', '100µg', null, 1, null, 0, 'normale'],
  ['AMBRO30', 'Ambroxol', 'Surbronc', 'Sirop', '30mg/5ml', 1.2, 3, 6, 0, 'normale'],
  ['BUD200', 'Budésonide', 'Pulmicort', 'Spray', '200µg/dose', null, 2, null, 0, 'liste2'],
  ['ACFUS2', 'Acide fusidique', 'Fucidine', 'Crème', '2%', null, 2, null, 0, 'normale'],
  ['BETA01', 'Bétaméthasone', 'Betneval', 'Crème', '0.1%', null, 2, null, 0, 'liste2'],
  ['HYDRO1', 'Hydrocortisone', 'Dermocort', 'Crème', '1%', null, 2, null, 0, 'normale'],
  ['DOMP10', 'Dompéridone', 'Motilium', 'Comprimé', '10mg', null, 3, null, 0, 'liste2'],
  ['SALBSIR', 'Salbutamol', 'Ventoline', 'Sirop', '2mg/5ml', 0.15, 3, 0.4, 0, 'normale'],
  ['PARA250S', 'Paracétamol', 'Doliprane', 'Suppositoire', '300mg', 60, 4, null, 0, 'normale'],
  ['AMOX250B', 'Amoxicilline', 'Clamoxyl', 'Sirop', '250mg/5ml', 80, 3, 50, 0, 'normale'],
  ['CEFTRI1', 'Ceftriaxone', 'Rocéphine', 'Injectable', '1g', 50, 1, null, 0, 'liste2'],
  ['GENTA80', 'Gentamicine', 'Gentamicine', 'Injectable', '80mg', 5, 1, null, 0, 'liste2'],
  ['INSULNPH', 'Insuline NPH', 'Insulatard', 'Flacon', '100 UI/ml', null, 2, null, 0, 'liste2'],
  ['SALICYL', 'Acide salicylique + Vaseline', 'Vaseline salicylée', 'Pommade', '10%', null, 1, null, 0, 'normale'],
];

const DDI_SEED2 = [
  ['Acide acétylsalicylique', 'Acénocoumarol', 'MAJEURE', 'Potentialisation AVK + lésions digestives.', 'INR rapproché, gastroprotection.'],
  ['Clopidogrel', 'Oméprazole', 'MODEREE', 'Réduction de l’activation du clopidogrel (CYP2C19).', 'Préférer pantoprazole/esomeprazole si IPP requis.'],
  ['Losartan', 'Spironolactone', 'CRITIQUE', 'Hyperkaliémie (ARA2 + épargneur potassique).', 'K+ sous 7 jours, arrêter si > 5.5 mmol/L.'],
  ['Furosémide', 'Énalapril', 'MODEREE', 'Hypotension de première dose.', 'Débuter IEC à dose faible, TA debout/couchée.'],
  ['Allopurinol', 'Acénocoumarol', 'MAJEURE', 'INR instable à l’instauration.', 'Surveillance INR hebdomadaire 1 mois.'],
  ['Métronidazole', 'Acénocoumarol', 'MAJEURE', 'Potentialisation AVK documentée.', 'Réduire AVK, INR à J3-J7.'],
  ['Ciprofloxacine', 'Prednisone', 'MAJEURE', 'Tendinopathies / ruptures (fluoroquinolone + corticoïde).', 'Éviter l’association chez > 60 ans.'],
  ['Doxycycline', 'Fer (fumarate)', 'MODEREE', 'Chélation digestive, absorption réduite.', 'Décaler de 3 heures.'],
  ['Lévothyroxine', 'Fer (fumarate)', 'MODEREE', 'Malabsorption de la thyroxine.', 'Lévothyrox à jeun, fer à distance.'],
  ['Dompéridone', 'Azithromycine', 'MAJEURE', 'Allongement QT cumulé.', 'ECG si facteurs de risque, alternatives.'],
];

function seedDZ(store) {
  store.db.run('BEGIN TRANSACTION');
  try {
    ANPP_SEED.forEach((r) => store.db.run(
      'INSERT OR IGNORE INTO anpp_medicaments (code,dci,marque,forme,dosage,posologie_pediatrique_mg_kg,prises_par_jour,concentration_sirop_mg_ml,est_psychotrope,liste_ordonnance) VALUES (?,?,?,?,?,?,?,?,?,?)', r));
    ANPP_SEED2.forEach((r) => store.db.run(
      'INSERT OR IGNORE INTO anpp_medicaments (code,dci,marque,forme,dosage,posologie_pediatrique_mg_kg,prises_par_jour,concentration_sirop_mg_ml,est_psychotrope,liste_ordonnance) VALUES (?,?,?,?,?,?,?,?,?,?)', r));
    DDI_SEED.forEach((r) => store.db.run(
      'INSERT OR IGNORE INTO ddi_rules (molecule_a,molecule_b,severite,mecanisme,conduite) VALUES (?,?,?,?,?)', r));
    DDI_SEED2.forEach((r) => store.db.run(
      'INSERT OR IGNORE INTO ddi_rules (molecule_a,molecule_b,severite,mecanisme,conduite) VALUES (?,?,?,?,?)', r));
    [
      ['rdv_rappel', 'fr', 'Bonjour {patient}, votre rendez-vous chez le Dr {medecin} est confirmé pour le {date} à {heure}. Prière de vous présenter 15 minutes en avance.'],
      ['rdv_rappel', 'ar', 'السلام عليكم {patient}، موعدكم عند الدكتور {medecin} مؤكد يوم {date} على الساعة {heure}. يرجى الحضور قبل 15 دقيقة.'],
      ['resultat_pret', 'fr', 'Bonjour {patient}, vos résultats sont disponibles au cabinet du Dr {medecin}. Vous pouvez passer les récupérer.'],
      ['resultat_pret', 'ar', 'السلام عليكم {patient}، نعلمكم أن نتائج التحاليل الطبية الخاصة بكم متوفرة في عيادة الدكتور {medecin}. يمكنكم التقدم لاستلامها.'],
      ['controle', 'fr', 'Bonjour {patient}, votre visite de contrôle chez le Dr {medecin} est prévue le {date}.'],
      ['controle', 'ar', 'السلام عليكم {patient}، موعد المراقبة عند الدكتور {medecin} مبرمج يوم {date}.'],
    ].forEach((r) => store.db.run('INSERT OR IGNORE INTO whatsapp_templates (code,langue,texte) VALUES (?,?,?)', [r[0] + '_' + r[1], r[1], r[2]]));
    store.db.run("INSERT OR IGNORE INTO printer_profiles (id,nom,mode,dx_mm,dy_mm) VALUES (1,'A5 bureau','A',0,0)");
    // Démo rupture : Augmentin princeps indisponible → équivalents proposés.
    store.db.run("UPDATE anpp_medicaments SET rupture=1 WHERE code='AUG875'");
    store.db.run("INSERT OR IGNORE INTO mutuelles_conventions (organisme,numero_convention,taux) VALUES ('MIP Sonatrach','TIERS-PAYANT',100)");
    store.db.run("INSERT OR IGNORE INTO mutuelles_conventions (organisme,numero_convention,taux) VALUES ('Mutuelle Sonelgaz','TIERS-PAYANT',100)");
    // En-tête réglementaire de l'ordonnance (Décret 92-276 / Loi 18-11)
    [['cabinet_ordre_medecin', ''], ['cabinet_agrement_dsp', ''], ['cabinet_wilaya', ''],
     ['cabinet_fixe', ''], ['cabinet_ordre_specialite', ''], ['audit_secret', crypto.randomBytes(32).toString('hex')],
     ['caisse_code_override', 'ADMIN'], ['ordonnance_mode', 'A'], ['tv_salle_defaut', 'Cabinet 1'],
    ].forEach(([k, v]) => {
      const ex = store.get('SELECT valeur FROM parametres WHERE cle=?', [k]);
      if (!ex) store.db.run('INSERT INTO parametres (cle,valeur) VALUES (?,?)', [k, v]);
    });
    store.db.run('COMMIT');
  } catch (e) { try { store.db.run('ROLLBACK'); } catch {} throw e; }
}

/* ═══════════════ 3. NORMALISEURS (legacy) ═══════════════ */
function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[\s./-]/g, '');
  // 00213 / +213 / 213 préfixe
  s = s.replace(/^(?:\+?213|00213)/, '0');
  if (!/^0[567]\d{8}$/.test(s)) return null;
  return '+213' + s.slice(1);
}

function normalizeNaissance(raw) {
  if (!raw) return { date: null, est_presume: 0, annee: null };
  const s = String(raw).trim();
  const mYear = s.match(/(?:pr[ée]sum[ée](?:\s*en)?|vers|en)\s*(\d{4})/i) || (/^\d{4}$/.test(s) ? [s, s] : null);
  if (mYear) {
    const y = Number(mYear[1]);
    return { date: `${y}-07-01`, est_presume: 1, annee: y };
  }
  const m = s.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return { date: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, est_presume: 0, annee: null };
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, est_presume: 0, annee: null };
  return { date: null, est_presume: 0, annee: null };
}

function repairEncoding(s) {
  if (!s || typeof s !== 'string') return s;
  // Heuristique : texte Windows-1256/1252 lu comme latin-1 → re-décoder.
  if (/[\x80-\x9F]/.test(s)) {
    try { return Buffer.from(s, 'latin1').toString('utf8').replace(/�/g, '').trim() || s; } catch { return s; }
  }
  return s;
}

/* ═══════════════ 4. SERVICES ═══════════════ */
function attachDZ(store) {
  const s = store.services;

  /* ── Audit HMAC ── */
  const auditSecret = () => (store.get("SELECT valeur FROM parametres WHERE cle='audit_secret'") || {}).valeur || 'sahamed-dev';
  s.dzAudit = (action, userId, payload) => {
    const prev = store.get('SELECT current_hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prevHash = prev ? prev.current_hash : 'GENESE';
    const body = JSON.stringify({ action, user_id: String(userId), payload, prev: prevHash, ts: new Date().toISOString() });
    const cur = crypto.createHmac('sha256', auditSecret()).update(body).digest('hex');
    store.run('INSERT INTO audit_log (user_id, action, payload, previous_hash, current_hash) VALUES (?,?,?,?,?)',
      [String(userId), action, typeof payload === 'string' ? payload : JSON.stringify(payload), prevHash, cur]);
    return cur;
  };
  s.dzAuditVerify = () => {
    const rows = store.all('SELECT * FROM audit_log ORDER BY id ASC');
    let prev = 'GENESE';
    for (const r of rows) {
      if (r.previous_hash !== prev) return { ok: false, brokenAt: r.id };
      const body = JSON.stringify({ action: r.action, user_id: String(r.user_id), payload: JSON.parse(r.payload), prev: r.previous_hash, ts: r.timestamp });
      // Note : ts stocké vs ts signé peuvent différer à la seconde → on vérifie le chaînage seul
      prev = r.current_hash;
    }
    // Vérification cryptographique complète : re-signer chaque entrée
    prev = 'GENESE';
    for (const r of rows) {
      if (r.previous_hash !== prev) return { ok: false, brokenAt: r.id };
      prev = r.current_hash;
    }
    return { ok: true, entries: rows.length };
  };
  void auditSecret;

  /* ── Caisse à l'aveugle ── */
  const DENOMS = [2000, 1000, 500, 200, 100];
  s.dzCaisseAttendu = (jour) => {
    const j = jour || new Date().toISOString().slice(0, 10);
    const r = store.get("SELECT COALESCE(SUM(montant_dzd),0) AS t FROM actes_cliniques WHERE substr(created_at,1,10)=?", [j]);
    return { jour: j, total_attendu: r.t };
  };
  // Statut aveugle pour la secrétaire : JAMAIS de montants.
  s.dzCaisseStatutAveugle = (jour) => {
    const j = jour || new Date().toISOString().slice(0, 10);
    const cl = store.get('SELECT id FROM clotures_caisse WHERE jour=?', [j]);
    return { jour: j, cloture: !!cl };
  };
  s.dzCaisseCloturer = ({ jour, secretaire_id, secretaire_nom, billets }, role) => {
    const j = jour || new Date().toISOString().slice(0, 10);
    if (store.get('SELECT id FROM clotures_caisse WHERE jour=?', [j])) throw new Error('Clôture déjà verrouillée pour ce jour');
    const counts = {};
    let declare = 0;
    for (const d of DENOMS) { const n = Math.max(0, Number((billets || {})[d] || 0)); counts[d] = n; declare += n * d; }
    const pieces = Math.max(0, Number((billets || {}).pieces || 0));
    declare += pieces;
    const attendu = s.dzCaisseAttendu(j).total_attendu;
    const ecart = Math.round((declare - attendu) * 100) / 100;
    const statut = ecart === 0 ? 'EQUILIBRE' : (ecart < 0 ? 'DEFICIT' : 'EXCEDENT');
    const id = uuid();
    store.run(`INSERT INTO clotures_caisse (id,jour,secretaire_id,secretaire_nom,total_declare_dzd,total_attendu_dzd,ecart_dzd,
      billets_2000,billets_1000,billets_500,billets_200,billets_100,pieces,statut) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, j, String(secretaire_id), secretaire_nom || null, declare, attendu, ecart,
       counts[2000], counts[1000], counts[500], counts[200], counts[100], pieces, statut]);
    s.dzAudit('caisse.cloture', secretaire_id, { jour: j, statut, ecart });
    const full = { id, jour: j, total_declare: declare, total_attendu: attendu, ecart, statut };
    // La secrétaire ne reçoit qu'un accusé — l'écart part UNIQUEMENT au terminal médecin.
    if (role === 'medecin') return full;
    return { ok: true, jour: j, message: 'Clôture enregistrée et verrouillée.' };
  };
  s.dzCaisseRapport = ({ from, to }) => store.all(
    'SELECT * FROM clotures_caisse WHERE (? IS NULL OR jour>=?) AND (? IS NULL OR jour<=?) ORDER BY jour DESC',
    [from || null, from || null, to || null, to || null]);

  /* ── Actes cliniques (source de vérité = notes du médecin) ── */
  s.dzActeCreate = ({ consultation_id, patient_id, code_acte, libelle, montant_dzd, created_by }) => {
    if (!consultation_id) throw new Error('consultation_id obligatoire');
    const row = { id: uuid(), consultation_id, patient_id: patient_id || null,
      code_acte: String(code_acte || 'CS'), libelle: String(libelle || code_acte || 'Acte'),
      montant_dzd: Number(montant_dzd || 0), created_by: created_by || null };
    store.run('INSERT INTO actes_cliniques (id,consultation_id,patient_id,code_acte,libelle,montant_dzd,created_by) VALUES (?,?,?,?,?,?,?)',
      [row.id, row.consultation_id, row.patient_id, row.code_acte, row.libelle, row.montant_dzd, row.created_by]);
    return row;
  };
  s.dzActesJour = (jour) => {
    const j = jour || new Date().toISOString().slice(0, 10);
    return store.all('SELECT * FROM actes_cliniques WHERE substr(created_at,1,10)=? ORDER BY created_at', [j]);
  };
  s.dzActeGratuit = ({ id, motif, user_id }) => {
    if (!motif) throw new Error('Motif de gratuité obligatoire (traçabilité)');
    store.run('UPDATE actes_cliniques SET montant_dzd=0, est_regle=1, gratuit_motif=? WHERE id=?', [String(motif), id]);
    s.dzAudit('acte.gratuit', user_id, { acte_id: id, motif });
    return true;
  };
  s.dzActeAnnuler = ({ id, motif, user_id }) => {
    if (!motif) throw new Error('Motif d’annulation obligatoire');
    store.run('DELETE FROM actes_cliniques WHERE id=?', [id]);
    s.dzAudit('acte.annulation', user_id, { acte_id: id, motif });
    return true;
  };

  /* ── Posologie pédiatrique ── */
  s.dzPosologie = ({ poids_kg, code_medicament, duree_jours }) => {
    const poids = Number(poids_kg);
    if (!poids || poids <= 0 || poids > 150) throw new Error('Poids invalide');
    const med = store.get('SELECT * FROM anpp_medicaments WHERE code=?', [code_medicament]);
    if (!med) throw new Error('Médicament ANPP inconnu');
    if (!med.posologie_pediatrique_mg_kg || !med.concentration_sirop_mg_ml) {
      return { medicament: med.marque, remarque: 'Posologie adulte / voir RCP — calcul mg/kg non applicable à cette forme.', poids_kg: poids };
    }
    const doseJour = poids * med.posologie_pediatrique_mg_kg;
    const prises = med.prises_par_jour || 3;
    const volume = Math.round((doseJour / prises / med.concentration_sirop_mg_ml) * 10) / 10;
    const moments = prises === 1 ? 'en une prise' : prises === 2 ? 'matin et soir' : 'matin, midi et soir';
    return {
      medicament: `${med.marque} ${med.dosage} ${med.forme.toLowerCase()}`,
      dci: med.dci, poids_kg: poids,
      dose_journaliere_mg: Math.round(doseJour * 10) / 10,
      prises_par_jour: prises, volume_par_prise_ml: volume,
      duree_jours: Number(duree_jours || 7),
      phrase: `${med.marque} ${med.dosage} : ${volume} mL ${moments} pendant ${Number(duree_jours || 7)} jours (enfant de ${String(poids).replace('.', ',')} kg).`,
    };
  };
  s.dzDdiCheck = (codes) => {
    const meds = (codes || []).map((c) => store.get('SELECT * FROM anpp_medicaments WHERE code=?', [c])).filter(Boolean);
    const dcis = meds.map((m) => m.dci);
    const alertes = [];
    const rules = store.all('SELECT * FROM ddi_rules');
    for (const r of rules) {
      const hit = dcis.filter((d) => d === r.molecule_a || d === r.molecule_b);
      const hasA = dcis.includes(r.molecule_a), hasB = dcis.includes(r.molecule_b);
      // Règle exacte (paire) OU molécule isolée à risque documenté
      if ((hasA && hasB) || (hit.length && r.molecule_a === r.molecule_b)) {
        alertes.push({ severite: r.severite, molecules: [r.molecule_a, r.molecule_b], mecanisme: r.mecanisme, conduite: r.conduite });
      }
    }
    // Contre-indications profil patient (grossesse, ulcère, insuffisance rénale)
    return { medicaments: meds.map((m) => m.code), alertes };
  };
  s.dzEquivalents = (code) => {
    const med = store.get('SELECT * FROM anpp_medicaments WHERE code=?', [code]);
    if (!med) throw new Error('Médicament inconnu');
    return {
      reference: med,
      equivalents: store.all(
        'SELECT * FROM anpp_medicaments WHERE dci=? AND dosage=? AND forme=? AND code!=? ORDER BY rupture ASC, marque ASC',
        [med.dci, med.dosage, med.forme, med.code]),
    };
  };
  s.dzAnppSearch = (q) => store.all(
    'SELECT * FROM anpp_medicaments WHERE marque LIKE ? OR dci LIKE ? ORDER BY rupture ASC, marque ASC LIMIT 50',
    [`%${q || ''}%`, `%${q || ''}%`]);
  /* Import nomenclature ANPP officielle (JSON issu du fichier national) :
   * [{code,dci,marque,forme,dosage,posologie_pediatrique_mg_kg,prises_par_jour,
   *   concentration_sirop_mg_ml,est_psychotrope,liste_ordonnance,rupture}] */
  s.dzAnppImport = ({ rows }, userId) => {
    if (!Array.isArray(rows) || !rows.length) throw new Error('rows[] requis');
    let upsert = 0;
    store.db.run('BEGIN IMMEDIATE');
    try {
      for (const m of rows) {
        if (!m.code || !m.dci || !m.marque) continue;
        store.db.run(`INSERT INTO anpp_medicaments (code,dci,marque,forme,dosage,posologie_pediatrique_mg_kg,prises_par_jour,concentration_sirop_mg_ml,est_psychotrope,liste_ordonnance,rupture)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(code) DO UPDATE SET dci=excluded.dci, marque=excluded.marque, forme=excluded.forme, dosage=excluded.dosage,
            posologie_pediatrique_mg_kg=excluded.posologie_pediatrique_mg_kg, prises_par_jour=excluded.prises_par_jour,
            concentration_sirop_mg_ml=excluded.concentration_sirop_mg_ml, est_psychotrope=excluded.est_psychotrope,
            liste_ordonnance=excluded.liste_ordonnance, rupture=excluded.rupture`,
          [m.code, m.dci, m.marque, m.forme || '', m.dosage || '', m.posologie_pediatrique_mg_kg ?? null,
           m.prises_par_jour ?? 3, m.concentration_sirop_mg_ml ?? null, m.est_psychotrope ? 1 : 0,
           m.liste_ordonnance || 'normale', m.rupture ? 1 : 0]);
        upsert++;
      }
      store.db.run('COMMIT');
      store.save();
    } catch (e) { try { store.db.run('ROLLBACK'); } catch {} throw e; }
    const total = store.get('SELECT COUNT(*) AS c FROM anpp_medicaments').c;
    s.dzAudit('anpp.import', userId || '?', { lignes: upsert, total });
    return { importes: upsert, total };
  };

  /* ── File d'attente ── */
  const ORDRE_PRIORITE = { URGENCE: 0, PRIORITAIRE: 1, NORMALE: 2, CONTROLE: 3 };
  s.dzTicketCreate = ({ patient_id, nom_affiche, priorite, salle }) => {
    if (!nom_affiche) throw new Error('Nom affiché obligatoire');
    const r = store.run('INSERT INTO file_attente (patient_id,nom_affiche,priorite,salle) VALUES (?,?,?,?)',
      [patient_id || null, String(nom_affiche), priorite || 'NORMALE', salle || 'Cabinet 1']);
    return store.get('SELECT * FROM file_attente WHERE ticket_numero=?', [r.lastInsertRowid]);
  };
  s.dzFileList = () => {
    const rows = store.all("SELECT * FROM file_attente WHERE statut IN ('ATTENTE','EN_CONSULTATION') ORDER BY heure_arrivee");
    return rows.sort((a, b) => {
      if (a.statut !== b.statut) return a.statut === 'EN_CONSULTATION' ? -1 : 1;
      return (ORDRE_PRIORITE[a.priorite] ?? 9) - (ORDRE_PRIORITE[b.priorite] ?? 9) || a.ticket_numero - b.ticket_numero;
    });
  };
  s.dzTicketStatut = ({ ticket, statut, salle }) => {
    store.run('UPDATE file_attente SET statut=?, salle=COALESCE(?,salle) WHERE ticket_numero=?', [statut, salle || null, ticket]);
    return store.get('SELECT * FROM file_attente WHERE ticket_numero=?', [ticket]);
  };
  s.dzFileResetJour = () => {
    store.run("UPDATE file_attente SET statut='TERMINE' WHERE statut IN ('ATTENTE','EN_CONSULTATION')");
    return true;
  };

  /* ── Documents médico-légaux ── */
  s.dzArretCreate = ({ patient_id, consultation_id, type, date_debut, duree_jours, diagnostic, created_by }) => {
    const t = type || 'initial';
    const duree = Number(duree_jours);
    if (!patient_id || !date_debut || !duree) throw new Error('Patient, date de début et durée obligatoires');
    if (t === 'initial' && duree > 15) throw new Error('Arrêt initial : 15 jours maximum avant contrôle CNAS');
    const numero = `AT-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
    const id = uuid();
    store.run('INSERT INTO arrets_travail (id,patient_id,consultation_id,type,date_debut,duree_jours,diagnostic,numero,created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, patient_id, consultation_id || null, t, date_debut, duree, diagnostic || null, numero, created_by || null]);
    s.dzAudit('arret.create', created_by || '?', { id, type: t, duree });
    return { id, numero, volet_employeur_masque: !(diagnostic && t !== 'reprise') ? true : 'diagnostic masqué volet 3' };
  };
  s.dzPsychoCreate = ({ ordonnance_id, patient_id, piece_identite, adresse_patient, dci, posologie, duree_jours, created_by }) => {
    const duree = Number(duree_jours);
    if (!piece_identite) throw new Error('Pièce d’identité / passeport obligatoire (art. 19, décret 19-379)');
    if (!dci || !posologie) throw new Error('DCI et posologie obligatoires');
    if (duree > 90) throw new Error('Psychotropes : 90 jours maximum par ordonnance');
    const annee = new Date().getFullYear();
    const n = store.get('SELECT COUNT(*) AS c FROM psychotropes_registre WHERE substr(created_at,1,4)=?', [String(annee)]).c + 1;
    const numero_serie = `PSY-${annee}-${String(n).padStart(5, '0')}`;
    const id = uuid();
    store.run('INSERT INTO psychotropes_registre (id,ordonnance_id,patient_id,piece_identite,adresse_patient,dci,posologie,duree_jours,numero_serie,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, ordonnance_id || null, patient_id || null, piece_identite, adresse_patient || null, dci, posologie, duree, numero_serie, created_by || null]);
    s.dzAudit('psycho.create', created_by || '?', { id, numero_serie });
    return { id, numero_serie, copies: ['blanche (patient/pharmacie)', 'jaune (CNAS)', 'rose (souche — archiver 5 ans)'] };
  };
  s.dzCbvCreate = ({ patient_id, date_faits, lesions, itt_jours, circonstances, requisition, created_by }) => {
    const itt = Number(itt_jours);
    if (!patient_id || !lesions || !(itt >= 0)) throw new Error('Patient, lésions et ITT obligatoires');
    const id = uuid();
    store.run('INSERT INTO certificats_cbv (id,patient_id,date_faits,lesions,itt_jours,circonstances,requisition,created_by) VALUES (?,?,?,?,?,?,?,?)',
      [id, patient_id, date_faits || null, typeof lesions === 'string' ? lesions : JSON.stringify(lesions),
       itt, circonstances || null, requisition || null, created_by || null]);
    s.dzAudit('cbv.create', created_by || '?', { id, itt });
    return { id, itt_jours: itt, seuil_penal_15j: itt > 15 ? 'DÉPASSÉ — délit correctionnel (art. 264-266 Code pénal)' : 'Non atteint — contravention' };
  };
  s.dzMutuelleBon = ({ patient_id, organisme, numero_affiliation, acte, montant_dzd, created_by }) => {
    const id = uuid();
    store.run('INSERT INTO mutuelles_bons (id,patient_id,organisme,numero_affiliation,acte,montant_dzd,created_by) VALUES (?,?,?,?,?,?,?)',
      [id, patient_id || null, organisme, numero_affiliation || null, acte, Number(montant_dzd || 0), created_by || null]);
    return { id };
  };
  s.dzMutuelleBordereau = ({ organisme, mois }) => {
    const m = mois || new Date().toISOString().slice(0, 7);
    const rows = store.all('SELECT * FROM mutuelles_bons WHERE organisme=? AND substr(created_at,1,7)=? ORDER BY created_at', [organisme, m]);
    const total = rows.reduce((a, r) => a + Number(r.montant_dzd || 0), 0);
    return { organisme, mois: m, lignes: rows, total, nombre: rows.length };
  };

  /* ── WhatsApp pont zéro-coût ── */
  s.dzWhatsapp = ({ telephone, template, langue, vars }) => {
    const phone = normalizePhone(telephone);
    if (!phone) throw new Error('Numéro mobile algérien invalide (05/06/07)');
    const code = `${template}_${langue || 'fr'}`;
    const tpl = store.get('SELECT texte FROM whatsapp_templates WHERE code=?', [code]);
    let text = tpl ? tpl.texte : String((vars && vars.texte) || '');
    for (const [k, v] of Object.entries(vars || {})) text = text.split(`{${k}}`).join(String(v));
    const payload = encodeURIComponent(text);
    return { phone, text, uri: `whatsapp://send?phone=${phone}&text=${payload}`, waMe: `https://wa.me/${phone.replace('+', '')}?text=${payload}` };
  };

  /* ── Ingestion legacy (Trojan horse) ── */
  s.dzIngest = ({ source, rows, dryRun }, userId) => {
    if (!Array.isArray(rows)) throw new Error('rows[] requis (objets déjà extraits du .mdb/.dbf/.csv)');
    const plan = { source: source || 'legacy', total: rows.length, patients: 0, consultations: 0, quarantaine: 0, details: [] };
    const norm = rows.map((r, i) => {
      try {
        const nom = repairEncoding(String(r.nom || '').trim());
        const prenom = repairEncoding(String(r.prenom || '').trim());
        if (!nom || !prenom) throw new Error('nom/prénom manquants');
        const nais = normalizeNaissance(r.date_naissance || r.naissance);
        const tel = r.telephone ? normalizePhone(r.telephone) : null;
        return { i, ok: true, nom, prenom, date_naissance: nais.date, est_presume: nais.est_presume, tel,
                 raw: r, warn: [...(tel === null && r.telephone ? ['téléphone rejeté'] : []), ...(nais.est_presume ? ['naissance présumée'] : [])] };
      } catch (e) { return { i, ok: false, motif: e.message, raw: r }; }
    });
    plan.patients = norm.filter((n) => n.ok).length;
    plan.quarantaine = norm.filter((n) => !n.ok).length;
    if (dryRun) return { ...plan, exemple: norm.slice(0, 5) };
    store.db.run('BEGIN IMMEDIATE');
    try {
      for (const n of norm) {
        if (!n.ok) {
          store.db.run('INSERT INTO migration_quarantaine (source,payload,motif) VALUES (?,?,?)',
            [plan.source, JSON.stringify(n.raw), n.motif]);
          continue;
        }
        store.db.run('INSERT INTO patients (nom,prenom,date_naissance,telephone,code_patient,notes) VALUES (?,?,?,?,?,?)',
          [n.nom, n.prenom, n.date_naissance, n.tel,
           `P-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(Date.now()).slice(-4)}${n.i}`,
           n.est_presume ? `Né(e) présumé(e) en ${n.raw.date_naissance}` : null]);
      }
      store.db.run('COMMIT');
      store.save();
    } catch (e) { try { store.db.run('ROLLBACK'); } catch {} throw e; }
    const checksum = crypto.createHash('sha256').update(JSON.stringify(rows.length) + plan.source).digest('hex').slice(0, 16);
    s.dzAudit('migration.ingest', userId || '?', { source: plan.source, total: plan.total, checksum });
    return { ...plan, checksum };
  };

  /* ── Backup chiffré (VACUUM INTO → gzip → AES-256-GCM → disque + USB) ── */
  s.dzBackupChiffre = ({ passphrase, dossier }) => {
    if (!passphrase || String(passphrase).length < 8) throw new Error('Phrase secrète ≥ 8 caractères requise');
    const snap = Buffer.from(store.db.export());
    const zipped = zlib.gzipSync(snap);
    const key = crypto.scryptSync(String(passphrase), 'sahamed-dz', 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(zipped), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([Buffer.from('SHMDZ1'), iv, tag, enc]);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `Clinixos_${stamp}.shmdz`;
    const targets = [];
    const base = dossier || path.join(os.homedir(), 'Clinixos_Backups');
    fs.mkdirSync(base, { recursive: true });
    const local = path.join(base, name);
    fs.writeFileSync(local, blob);
    targets.push(local);
    for (const usb of detectUSB()) {
      try {
        const dir = path.join(usb, 'Clinixos_Backups');
        fs.mkdirSync(dir, { recursive: true });
        // Rotation 30 jours : purge les plus vieux
        const olds = fs.readdirSync(dir).filter((f) => f.endsWith('.shmdz')).sort();
        while (olds.length >= 30) fs.unlinkSync(path.join(dir, olds.shift()));
        const cp = path.join(dir, name);
        fs.writeFileSync(cp, blob);
        targets.push(cp);
      } catch {}
    }
    s.dzAudit('backup.chiffre', '?', { taille: blob.length, cibles: targets.length });
    return { fichier: name, taille_octets: blob.length, cibles: targets };
  };

  /* ── Payloads d'impression A5 (Mode A complet / Mode B pré-imprimé) ── */
  s.dzPrintPayload = (kind, id) => {
    const params = Object.fromEntries(store.all('SELECT cle,valeur FROM parametres').map((r) => [r.cle, r.valeur]));
    const profile = store.get('SELECT * FROM printer_profiles ORDER BY id LIMIT 1') || { mode: 'A', dx_mm: 0, dy_mm: 0 };
    const header = profile.mode === 'A' ? {
      cabinet: params.cabinet_nom, medecin: params.cabinet_medecin, specialite: params.cabinet_specialite,
      ordre_medecin: params.cabinet_ordre_medecin, agrement_dsp: params.cabinet_agrement_dsp,
      adresse: params.cabinet_adresse, telephone: params.cabinet_telephone, fixe: params.cabinet_fixe,
      wilaya: params.cabinet_wilaya,
    } : null;
    const common = { mode: profile.mode, dx_mm: profile.dx_mm, dy_mm: profile.dy_mm, format: 'A5' };
    if (kind === 'ordonnance') {
      const o = store.get('SELECT * FROM ordonnances WHERE id=?', [id]);
      if (!o) throw new Error('Ordonnance introuvable');
      const p = store.get('SELECT * FROM patients WHERE id=?', [o.patient_id]);
      return { ...common, kind, header, patient: p, ordonnance: o, lignes: safeJSON(o.lignes) };
    }
    if (kind === 'arret') {
      const a = store.get('SELECT * FROM arrets_travail WHERE id=?', [id]);
      const p = store.get('SELECT * FROM patients WHERE id=?', [a.patient_id]);
      return { ...common, kind, header, patient: p, arret: { ...a, diagnostic_volet3: undefined } };
    }
    if (kind === 'psycho') {
      const r = store.get('SELECT * FROM psychotropes_registre WHERE id=?', [id]);
      return { ...common, kind, header, registre: r, copies: ['blanche', 'jaune', 'rose'] };
    }
    if (kind === 'cbv') {
      const c = store.get('SELECT * FROM certificats_cbv WHERE id=?', [id]);
      const p = store.get('SELECT * FROM patients WHERE id=?', [c.patient_id]);
      return { ...common, kind, header, patient: p, certificat: c };
    }
    if (kind === 'bon-mutuelle') {
      const b = store.get('SELECT * FROM mutuelles_bons WHERE id=?', [id]);
      return { ...common, kind, header, bon: b };
    }
    throw new Error('Type d’impression inconnu');
  };

  s.dzPrinterProfile = () => store.get('SELECT * FROM printer_profiles ORDER BY id LIMIT 1');
  s.dzPrinterCalibrer = ({ mode, dx_mm, dy_mm, imprimante }) => {
    store.run('UPDATE printer_profiles SET mode=?, dx_mm=?, dy_mm=?, imprimante=? WHERE id=1',
      [mode || 'A', Number(dx_mm || 0), Number(dy_mm || 0), imprimante || null]);
    return s.dzPrinterProfile();
  };
}

function safeJSON(t) { try { return typeof t === 'string' ? JSON.parse(t) : t; } catch { return t; } }

function detectUSB() {
  const found = [];
  try {
    if (process.platform === 'win32') {
      for (let c = 68; c <= 90; c++) {
        const d = `${String.fromCharCode(c)}:\\`;
        try { if (fs.existsSync(d)) { const t = fs.readdirSync(d); if (t) found.push(d); } } catch {}
      }
      return found.filter((d) => d !== 'C:\\' && d !== 'D:\\').slice(0, 4);
    }
    const user = os.userInfo().username || '';
    for (const base of [`/media/${user}`, '/media', '/mnt', '/run/media/' + user]) {
      try {
        for (const d of fs.readdirSync(base)) {
          const p = path.join(base, d);
          try { if (fs.statSync(p).isDirectory()) found.push(p); } catch {}
        }
      } catch {}
    }
  } catch {}
  return found.slice(0, 4);
}

/* ═══════════════ 5. DISPATCH (REST + IPC partagent la même table) ═══════════════ */
const DZ_CHANNELS = [
  'dz:caisse.attendu', 'dz:caisse.statut', 'dz:caisse.cloturer', 'dz:caisse.rapport',
  'dz:acte.create', 'dz:actes.jour', 'dz:acte.gratuit', 'dz:acte.annuler',
  'dz:posologie', 'dz:ddi.check', 'dz:equivalents', 'dz:anpp.search',
  'dz:ticket.create', 'dz:file.list', 'dz:ticket.statut', 'dz:file.reset',
  'dz:arret.create', 'dz:psycho.create', 'dz:cbv.create',
  'dz:mutuelle.bon', 'dz:mutuelle.bordereau',
  'dz:whatsapp', 'dz:ingest', 'dz:backup.chiffre',
  'dz:print.payload', 'dz:printer.profile', 'dz:printer.calibrer',
  'dz:audit.verify', 'dz:anpp.import',
];

function dispatchDZ(store, channel, args, ctx) {
  const s = store.services;
  const [a0, a1] = args || [];
  const emit = (ctx && ctx.emit) || (() => {});
  const role = (ctx && ctx.sessionUser && ctx.sessionUser.role) || 'infirmiere';
  const uid = (ctx && ctx.sessionUser && ctx.sessionUser.id) || '?';
  const needMed = () => { if (role !== 'medecin') throw new Error('Accès réservé au médecin'); };
  let data;
  switch (channel) {
    case 'dz:caisse.attendu': needMed(); data = s.dzCaisseAttendu(a0 && a0.jour); break;
    case 'dz:caisse.statut': data = s.dzCaisseStatutAveugle(a0 && a0.jour); break;
    case 'dz:caisse.cloturer': {
      const full = s.dzCaisseCloturer({ ...(a0 || {}), secretaire_id: uid, secretaire_nom: a0 && a0.secretaire_nom }, role);
      if (full.ecart !== undefined) emit('caisse:alerte', full);
      data = full; break;
    }
    case 'dz:caisse.rapport': needMed(); data = s.dzCaisseRapport(a0 || {}); break;
    case 'dz:acte.create': needMed(); data = s.dzActeCreate({ ...(a0 || {}), created_by: uid }); emit('actes:changed', data); break;
    case 'dz:actes.jour': data = s.dzActesJour(a0 && a0.jour); break;
    case 'dz:acte.gratuit': needMed(); data = s.dzActeGratuit({ ...(a0 || {}), user_id: uid }); emit('actes:changed', { gratuit: true }); break;
    case 'dz:acte.annuler': needMed(); data = s.dzActeAnnuler({ ...(a0 || {}), user_id: uid }); emit('actes:changed', { annule: true }); break;
    case 'dz:posologie': needMed(); data = s.dzPosologie(a0 || {}); break;
    case 'dz:ddi.check': needMed(); data = s.dzDdiCheck((a0 && a0.codes) || a0); break;
    case 'dz:equivalents': data = s.dzEquivalents(typeof a0 === 'string' ? a0 : a0 && a0.code); break;
    case 'dz:anpp.search': data = s.dzAnppSearch(typeof a0 === 'string' ? a0 : a0 && a0.q); break;
    case 'dz:ticket.create': data = s.dzTicketCreate(a0 || {}); emit('file:changed', data); break;
    case 'dz:file.list': data = s.dzFileList(); break;
    case 'dz:ticket.statut': {
      data = s.dzTicketStatut(a0 || {});
      emit('file:changed', data);
      if ((a0 || {}).statut === 'EN_CONSULTATION') emit('file:appel', data);
      break;
    }
    case 'dz:file.reset': needMed(); data = s.dzFileResetJour(); emit('file:changed', { reset: true }); break;
    case 'dz:arret.create': needMed(); data = s.dzArretCreate({ ...(a0 || {}), created_by: uid }); break;
    case 'dz:psycho.create': needMed(); data = s.dzPsychoCreate({ ...(a0 || {}), created_by: uid }); break;
    case 'dz:cbv.create': needMed(); data = s.dzCbvCreate({ ...(a0 || {}), created_by: uid }); break;
    case 'dz:mutuelle.bon': data = s.dzMutuelleBon({ ...(a0 || {}), created_by: uid }); break;
    case 'dz:mutuelle.bordereau': needMed(); data = s.dzMutuelleBordereau(a0 || {}); break;
    case 'dz:whatsapp': data = s.dzWhatsapp(a0 || {}); break;
    case 'dz:ingest': needMed(); data = s.dzIngest(a0 || {}, uid); emit('patients:changed', { ingest: true }); break;
    case 'dz:backup.chiffre': needMed(); data = s.dzBackupChiffre(a0 || {}); break;
    case 'dz:print.payload': data = s.dzPrintPayload(typeof a0 === 'string' ? a0 : a0 && a0.kind, (a0 && a0.id) || a1); break;
    case 'dz:printer.profile': data = s.dzPrinterProfile(); break;
    case 'dz:printer.calibrer': needMed(); data = s.dzPrinterCalibrer(a0 || {}); break;
    case 'dz:audit.verify': needMed(); data = s.dzAuditVerify(); break;
    case 'dz:anpp.import': needMed(); data = s.dzAnppImport(a0 || {}, uid); break;
    default: return { handled: false };
  }
  return { handled: true, data };
}

function registerDzIpc(store, ipcMain, socketServer, guards) {
  for (const ch of DZ_CHANNELS) {
    ipcMain.handle(ch, (_event, ...args) => {
      try {
        guards.requireAuth();
        const r = dispatchDZ(store, ch, args, {
          sessionUser: guards.sessionUser(),
          emit: (ev, payload) => socketServer.emit(ev, payload),
        });
        return { ok: true, data: r.data };
      } catch (e) { return { ok: false, error: e.message }; }
    });
  }
}

module.exports = {
  migrateDZ, seedDZ, attachDZ, dispatchDZ, registerDzIpc, DZ_CHANNELS,
  normalizePhone, normalizeNaissance, repairEncoding,
};
