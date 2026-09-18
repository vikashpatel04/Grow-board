/**
 * Shared config loader for the command-line tools.
 *
 * Mirrors what the app does: read config.json, then take the SQL password from
 * the per-machine store under %APPDATA%\Grow Board. The password is never in
 * config.json, because release builds are published publicly.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const creds = require('../src/credentials');

function appDataDir() {
  const base = process.env.APPDATA ||
    path.join(process.env.USERPROFILE || process.env.HOME || '.', 'AppData', 'Roaming');
  return path.join(base, 'Grow Board');
}

function load() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const statePath = path.join(appDataDir(), 'grow-board-state.json');
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.sqlPassword) cfg.sql.password = creds.open(state.sqlPassword);
    // Settings saved from the app override config.json, same as in the app.
    if (state.configOverride) {
      for (const [k, v] of Object.entries(state.configOverride)) {
        cfg[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...(cfg[k] || {}), ...v } : v;
      }
    }
  } catch { /* no saved state yet */ }

  if (!cfg.sql.password) {
    console.error('\nNo database password saved on this machine.');
    console.error('Start Grow Board, open Settings, and enter the password once.\n');
    process.exit(2);
  }
  return cfg;
}

module.exports = { load, appDataDir };
