'use strict';
/**
 * SahaMed — garde produit locale (aucune DRM d'ancien éditeur).
 * Toujours active pour l'usage hors-ligne du cabinet.
 */
function init(/* userDataPath */) {}
function status() {
  return { mode: 'bound', ref: 'SAHA-LOCAL' };
}
function bind(/* token */) {
  return true;
}
module.exports = { init, status, bind };
