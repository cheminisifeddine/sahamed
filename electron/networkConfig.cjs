'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function configPath(userDataPath) {
  return path.join(userDataPath, 'network-mode.json');
}

function readConfig(userDataPath) {
  try {
    const data = JSON.parse(fs.readFileSync(configPath(userDataPath), 'utf8'));
    if (data && (data.mode === 'server' || data.mode === 'client')) return data;
  } catch {}
  return null;
}

function writeConfig(userDataPath, config) {
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(configPath(userDataPath), JSON.stringify(config, null, 2));
}

function clearConfig(userDataPath) {
  try { fs.unlinkSync(configPath(userDataPath)); } catch {}
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const rows of Object.values(interfaces)) {
    for (const item of rows || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}

module.exports = { readConfig, writeConfig, clearConfig, getLocalIP };
