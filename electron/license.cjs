'use strict';
/* Clinixos — Licence perpétuelle hors-ligne (asymétrique Ed25519).
 * 1. L'app calcule une empreinte machine stable (MAC + hostname + OS).
 * 2. Elle affiche un code d'activation (16 caractères) → transmis par SMS/WhatsApp.
 * 3. Le vendeur signe avec la clé PRIVÉE (jamais dans ce dépôt) via tools/license-sign.js.
 * 4. Le médecin saisit la clé → vérifiée ici avec la clé PUBLIQUE embarquée.
 * Zéro internet requis. Essai 30 jours, puis rappel sans blocage brutal. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Clé publique vendeur (la privée reste hors dépôt, hors ligne).
const VENDOR_PUB_B64 = 'MCowBQYDK2VwAyEAArwZ1J90Zbyv4MARq7WRpQFz6MiBmF0aTpTBov5oCXc=';
const TRIAL_DAYS = 30;

let dir = null;
const licPath = () => path.join(dir, 'license.json');

function fingerprint() {
  const macs = [];
  for (const rows of Object.values(os.networkInterfaces() || {})) {
    for (const n of rows || []) {
      if (!n.internal && n.mac && n.mac !== '00:00:00:00:00:00') macs.push(n.mac);
    }
  }
  macs.sort();
  const raw = `${os.platform()}|${os.hostname()}|${macs[0] || 'nomac'}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16).toUpperCase();
}

function activationCode() {
  const fp = fingerprint().replace(/[^A-Z0-9]/g, '');
  return `${fp.slice(0, 4)}-${fp.slice(4, 8)}-${fp.slice(8, 12)}-${fp.slice(12, 16)}`;
}

function read() {
  try { return JSON.parse(fs.readFileSync(licPath(), 'utf8')); } catch { return {}; }
}
function write(doc) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(licPath(), JSON.stringify(doc));
}

function init(userDataPath) {
  dir = userDataPath;
  const doc = read();
  if (!doc.firstSeen) { doc.firstSeen = new Date().toISOString(); write(doc); }
}

function status() {
  const doc = read();
  if (doc.bound && doc.key) {
    return { mode: 'bound', ref: 'SAHA-PERMANENT', machine: activationCode(), licensedAt: doc.licensedAt || null };
  }
  const first = new Date(doc.firstSeen || Date.now());
  const daysLeft = Math.max(0, TRIAL_DAYS - Math.floor((Date.now() - first.getTime()) / 86400000));
  return { mode: daysLeft > 0 ? 'trial' : 'trial-expired', ref: 'ESSAI', daysLeft, machine: activationCode() };
}

// Clé d'activation : base32( signature_ed25519( fingerprint ) ), groupée par 4.
function bind(key) {
  const clean = String(key || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (clean.length < 32) throw new Error('Clé incomplète');
  const sig = Buffer.from(base32Decode(clean));
  const pub = crypto.createPublicKey({ key: Buffer.from(VENDOR_PUB_B64, 'base64'), format: 'der', type: 'spki' });
  const ok = crypto.verify(null, Buffer.from(fingerprint()), pub, sig);
  if (!ok) throw new Error('Clé invalide pour ce poste');
  const doc = read();
  doc.bound = true; doc.key = clean; doc.licensedAt = new Date().toISOString();
  write(doc);
  return status();
}

function base32Decode(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s) {
    const v = alpha.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

module.exports = { init, status, bind, fingerprint, activationCode };
