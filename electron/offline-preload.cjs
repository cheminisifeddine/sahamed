'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('offlineApi', {
  retry: () => ipcRenderer.invoke('client:retry'),
  reconfigure: () => ipcRenderer.invoke('client:reconfigure'),
  // Sortie de l'app côté poste secrétaire : window.close() est bloqué par
  // Chromium sur une fenêtre non ouverte par script, d'où un bouton « Quitter »
  // sans effet. On passe donc par le processus principal.
  quit: () => ipcRenderer.invoke('client:quit'),
});
