/**
 * Grow Board - auto update.
 *
 * Checks GitHub Releases on startup (and every few hours), downloads a newer
 * version quietly, then ASKS before installing - the shop decides when the app
 * restarts, so an update can never interrupt billing.
 *
 * If no update channel is configured the module stays silent: no errors, no
 * banners, the app simply never offers an update.
 */
'use strict';

const { autoUpdater } = require('electron-updater');
const { dialog, app } = require('electron');

let win = null;
let cfg = null;
let state = {
  configured: false,
  checking: false,
  available: null,     // { version, notes, releaseDate }
  downloaded: null,    // { version, notes }
  progress: null,      // { percent, transferred, total }
  error: null,
  lastCheck: null,
  currentVersion: null
};

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function pushState() { send('update:state', getState()); }

function getState() {
  return { ...state, currentVersion: app.getVersion() };
}

/** Turn GitHub's markdown release notes into a few readable lines. */
function cleanNotes(notes) {
  if (!notes) return [];
  const text = Array.isArray(notes)
    ? notes.map(n => (typeof n === 'string' ? n : n.note || '')).join('\n')
    : String(notes);
  return text
    .replace(/<[^>]+>/g, ' ')
    .split(/\r?\n/)
    .map(l => l.replace(/^[\s*\-#>]+/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

function init(browserWindow, appConfig) {
  win = browserWindow;
  cfg = appConfig;
  state.currentVersion = app.getVersion();

  const u = (cfg && cfg.update) || {};
  // A channel is configured only when a repo has actually been filled in.
  state.configured = !!(u.enabled && u.owner && u.repo);
  if (!state.configured) { pushState(); return; }

  autoUpdater.autoDownload = u.autoDownload !== false;   // download quietly
  autoUpdater.autoInstallOnAppQuit = false;              // never install unasked
  autoUpdater.allowPrerelease = !!u.allowPrerelease;
  autoUpdater.logger = null;

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: u.owner,
    repo: u.repo,
    private: false,
    releaseType: u.allowPrerelease ? 'prerelease' : 'release'
  });

  autoUpdater.on('checking-for-update', () => {
    state.checking = true; state.error = null; pushState();
  });
  autoUpdater.on('update-not-available', () => {
    state.checking = false; state.lastCheck = new Date().toISOString(); pushState();
  });
  autoUpdater.on('update-available', (info) => {
    state.checking = false;
    state.lastCheck = new Date().toISOString();
    state.available = {
      version: info.version,
      notes: cleanNotes(info.releaseNotes),
      releaseDate: info.releaseDate || null
    };
    pushState();
  });
  autoUpdater.on('download-progress', (p) => {
    state.progress = {
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total
    };
    pushState();
  });
  autoUpdater.on('update-downloaded', (info) => {
    state.progress = null;
    state.downloaded = {
      version: info.version,
      notes: cleanNotes(info.releaseNotes)
    };
    pushState();
    promptInstall();
  });
  autoUpdater.on('error', (e) => {
    state.checking = false;
    // A missing release or no network is normal, not something to alarm about.
    const msg = String(e && e.message ? e.message : e);
    state.error = /404|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|net::/i.test(msg)
      ? null : msg.slice(0, 200);
    pushState();
  });

  // First check shortly after launch, then on a slow timer.
  setTimeout(() => check(), 8000);
  const hours = Number(u.checkEveryHours || 6);
  setInterval(() => check(), Math.max(1, hours) * 3600 * 1000);
}

async function check(manual = false) {
  if (!state.configured) {
    if (manual) { state.error = 'No update channel is configured yet.'; pushState(); }
    return getState();
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    if (manual) { state.error = String(e.message || e).slice(0, 200); pushState(); }
  }
  return getState();
}

/** Ask, then install. The shop chooses the moment - never a surprise restart. */
async function promptInstall() {
  if (!state.downloaded) return;
  const d = state.downloaded;
  const body = d.notes.length
    ? d.notes.map(n => '• ' + n).join('\n')
    : 'No release notes were provided.';

  const res = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Grow Board update',
    message: `Grow Board ${d.version} is ready to install.`,
    detail: `You are on ${app.getVersion()}.\n\nWhat's new:\n${body}\n\nInstalling takes a few seconds and restarts Grow Board. It does not affect your POS.`,
    buttons: ['Install and restart', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });

  if (res.response === 0) installNow();
}

function installNow() {
  if (!state.downloaded) return false;
  app.isQuitting = true;
  // isSilent = false so the user sees the installer; isForceRunAfter = true so
  // the app comes straight back up.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
}

/** Manual download, for when autoDownload is off. */
async function download() {
  if (!state.configured || !state.available) return getState();
  try { await autoUpdater.downloadUpdate(); }
  catch (e) { state.error = String(e.message || e).slice(0, 200); pushState(); }
  return getState();
}

module.exports = { init, check, download, installNow, promptInstall, getState };
