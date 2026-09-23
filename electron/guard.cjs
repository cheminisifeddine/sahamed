'use strict';
/**
 * Clinixos — garde produit : licence perpétuelle hors-ligne (Ed25519).
 * Délègue à license.cjs ; conservée comme façade pour ne rien casser.
 */
const license = require('./license.cjs');
function init(userDataPath) { license.init(userDataPath); }
function status() {
  try { return license.status(); } catch { return { mode: 'trial', daysLeft: 30 }; }
}
function bind(token) {
  return license.bind(token);
}
module.exports = { init, status, bind };
