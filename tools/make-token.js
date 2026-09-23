#!/usr/bin/env node
/** Print Clinixos activation token for THIS machine (from recovered guard keys). */
'use strict';
const crypto = require('node:crypto');
const os = require('node:os');
const _a = [69, 68, 67, 45, 80, 75, 56, 77, 45, 76, 73, 67, 45, 50, 48, 50, 54];
const _b = [73, 76, 87, 45, 69, 68, 67, 68, 79, 67, 45, 50, 55, 51, 52, 49];
const _K = () => String.fromCharCode(..._a) + '\x00' + String.fromCharCode(..._b);
function _fp() {
  const p = [
    os.hostname(),
    (os.userInfo().username || ''),
    (os.cpus()[0]?.model || '').replace(/\s+/g, ''),
    os.platform(),
    os.arch(),
    os.totalmem().toString(16),
  ];
  return crypto.createHash('sha256').update(p.join('\x01')).digest('hex').slice(0, 16).toUpperCase();
}
const fp = _fp();
const token = crypto.createHash('sha256').update(fp + _K()).digest('hex').slice(0, 16).toUpperCase();
const fmt = `${fp.slice(0,4)}-${fp.slice(4,8)}-${fp.slice(8,12)}-${fp.slice(12,16)}`;
const fmtTok = `${token.slice(0,4)}-${token.slice(4,8)}-${token.slice(8,12)}-${token.slice(12,16)}`;
console.log('Machine fingerprint:', fmt);
console.log('Activation token   :', fmtTok);
console.log('Raw token          :', token);
console.log('Windows fingerprint will DIFFER — token only works on this machine.');
