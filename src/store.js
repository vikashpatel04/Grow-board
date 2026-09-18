/**
 * Grow Board - local app state.
 *
 * Holds ONLY application preferences and notification history in a small JSON
 * file under the user's AppData folder. No business data is ever stored here -
 * every number in the app is read live from the POS database.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let file = null;
let data = {};

function init(userDataDir) {
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch { /* exists */ }
  file = path.join(userDataDir, 'grow-board-state.json');
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = { configOverride: {}, fired: {}, history: [] };
    flush();
  }
}

function flush() {
  if (!file) return;
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch { /* best effort */ }
}

function get(key, fallback) {
  return data[key] === undefined ? fallback : data[key];
}

function set(key, value) {
  data[key] = value;
  flush();
}

function pushHistory(entry) {
  const h = get('history', []);
  h.push(entry);
  set('history', h.slice(-200));
}

module.exports = { init, get, set, pushHistory };
