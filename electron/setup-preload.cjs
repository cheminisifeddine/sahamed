'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupApi', {
  getLocalIP: () => ipcRenderer.invoke('setup:getLocalIP'),
  testConnection: (ip) => ipcRenderer.invoke('setup:testConnection', ip),
  chooseMain: () => ipcRenderer.invoke('setup:chooseMain'),
  chooseSecretary: (ip) => ipcRenderer.invoke('setup:chooseSecretary', ip),
});
