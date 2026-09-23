'use strict';
/* OUTIL VENDEUR — ne jamais distribuer avec l'installateur.
 * Signe un code machine avec la clé PRIVÉE (stockée hors dépôt).
 * Usage : node tools/license-sign.js XXXX-XXXX-XXXX-XXXX
 * La clé privée vit dans ~/.config/SahaMed-vendor.key (chmod 600) ou $SAHAMED_VENDOR_KEY (base64). */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const code = (process.argv[2] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
if (code.length !== 16) { console.error('Usage: node tools/license-sign.js XXXX-XXXX-XXXX-XXXX'); process.exit(1); }
let privB64 = process.env.SAHAMED_VENDOR_KEY || '';
if (!privB64) {
  const p = path.join(os.homedir(), '.config', 'SahaMed-vendor.key');
  if (!fs.existsSync(p)) { console.error('Clé privée introuvable (~/.config/SahaMed-vendor.key)'); process.exit(1); }
  privB64 = fs.readFileSync(p, 'utf8').trim();
}
const priv = crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' });
const sig = crypto.sign(null, Buffer.from(code), priv);
const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let bits = '';
for (const b of sig) bits += b.toString(2).padStart(8, '0');
let out = '';
for (let i = 0; i < bits.length; i += 5) out += alpha[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
console.log(out.replace(/(.{4})/g, '$1-').replace(/-$/, ''));
