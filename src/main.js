/**
 * Grow Board - Electron main process.
 *
 * Owns the window, the tray, the notification schedule and the only database
 * connection. The renderer never touches SQL; it asks for data over IPC.
 */
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const M = require('./metrics');
const G = require('./goals');
const C = require('./coach');
const store = require('./store');
const updater = require('./updater');
const creds = require('./credentials');

const isDev = process.argv.includes('--dev');
let win = null;
let tray = null;
let config = null;
let schedulerTimer = null;
let lastError = null;

/* ------------------------------------------------------------------- config */

function configPath() {
  // Packaged builds ship config.json beside the executable so the shop can edit it.
  const packaged = path.join(process.resourcesPath || '', 'config.json');
  if (!isDev && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'config.json');
}

function loadConfig() {
  const p = configPath();
  const base = JSON.parse(fs.readFileSync(p, 'utf8'));
  // User overrides saved from the Settings page win over the file.
  const over = store.get('configOverride', {});
  config = deepMerge(base, over);
  config.__path = p;

  // The password never ships in config.json or the installer (release assets are
  // public). It lives per-machine in the local store. If an older config.json
  // still carries one, migrate it into the store once and stop reading it.
  const stored = creds.open(store.get('sqlPassword', ''));
  if (!stored && base.sql && base.sql.password) {
    store.set('sqlPassword', creds.seal(base.sql.password));
    config.sql.password = base.sql.password;
  } else {
    config.sql.password = stored || '';
  }
  config.__hasPassword = !!config.sql.password;
  return config;
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a[k] || {}, v) : v;
  }
  return out;
}

/* -------------------------------------------------------------------- icons */

/** Tray/app icon drawn inline so the app has no binary asset dependency. */
function makeIcon(size = 16) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="7" fill="#1baf7a"/>
    <path d="M7 22 L13 15 L18 19 L25 9" fill="none" stroke="#ffffff" stroke-width="3"
          stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="25" cy="9" r="2.6" fill="#ffffff"/>
  </svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

/* ------------------------------------------------------------------- window */

function createWindow(show = true) {
  win = new BrowserWindow({
    width: 1460, height: 940, minWidth: 1080, minHeight: 680,
    show,
    backgroundColor: '#14161a',
    title: 'Grow Board',
    icon: makeIcon(32),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // Renderer problems are invisible otherwise - surface them on the console so
  // a support call can be diagnosed from the log rather than by guesswork.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['debug', 'info', 'warn', 'error'][level] || level;
    console.log(`[renderer:${tag}] ${message}  (${String(sourceId).split('/').pop()}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[renderer] failed to load ${url}: ${desc} (${code})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[renderer] process gone: ${details.reason}`);
  });

  // Closing hides to tray; quitting is explicit from the tray menu.
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow(page) {
  if (!win) createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (page) win.webContents.send('navigate', page);
}

/* --------------------------------------------------------------------- tray */

async function buildTrayMenu() {
  let headline = 'Loading...';
  try {
    const b = await C.briefing(config);
    headline = `Today ${fmtMoney(b.today.revenue)} of ${fmtMoney(b.goal.goal)} goal`;
  } catch (e) {
    headline = 'Not connected to the POS database';
  }
  const menu = Menu.buildFromTemplate([
    { label: headline, enabled: false },
    { type: 'separator' },
    { label: 'Open dashboard', click: () => showWindow('today') },
    { label: "Today's focus", click: () => showWindow('actions') },
    { label: 'Stock to clear', click: () => showWindow('stock') },
    { type: 'separator' },
    { label: 'Send me the briefing now', click: () => pushBriefing(true) },
    { label: 'Refresh data', click: () => { db.clearCache(); if (win) win.webContents.send('refresh'); } },
    { type: 'separator' },
    { label: 'Check for updates', click: async () => { await updater.check(true); showWindow('settings'); } },
    { label: 'Settings', click: () => showWindow('settings') },
    { label: 'Quit Grow Board', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  if (tray) { tray.setContextMenu(menu); tray.setToolTip('Grow Board - ' + headline); }
}

function createTray() {
  tray = new Tray(makeIcon(16));
  tray.setToolTip('Grow Board');
  tray.on('click', () => showWindow());
  buildTrayMenu();
  setInterval(buildTrayMenu, 5 * 60 * 1000);
}

/* ------------------------------------------------------- notification engine */

const fmtMoney = v => '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN');

function notify(title, body, page) {
  if (!Notification.isSupported()) return;
  const nn = new Notification({ title, body, icon: makeIcon(64), silent: false });
  nn.on('click', () => showWindow(page || 'today'));
  nn.show();
  store.pushHistory({ at: new Date().toISOString(), title, body, page: page || 'today' });
}

/** Has this slot already fired today? Keeps restarts from re-notifying. */
function alreadyFired(slot) {
  const today = M.iso(new Date());
  return store.get('fired', {})[`${today}|${slot}`] === true;
}
function markFired(slot) {
  const today = M.iso(new Date());
  const fired = store.get('fired', {});
  fired[`${today}|${slot}`] = true;
  // Keep only the last few days.
  const keep = {};
  for (const k of Object.keys(fired)) {
    if ((Date.now() - new Date(k.split('|')[0]).getTime()) < 5 * 86400000) keep[k] = fired[k];
  }
  store.set('fired', keep);
}

function hhmmNow() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function dueNow(target) {
  if (!target) return false;
  const [th, tm] = target.split(':').map(Number);
  const d = new Date();
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const tgtMin = th * 60 + tm;
  // Fire within a 10-minute window so a sleeping machine still catches it.
  return nowMin >= tgtMin && nowMin < tgtMin + 10;
}

async function pushBriefing(force = false) {
  try {
    const b = await C.briefing(config);
    const g = b.goal, t = b.today;
    notify(
      `Today's goal ${fmtMoney(g.goal)}`,
      `${g.explain[0]}\n${b.topActions.length ? 'Focus: ' + b.topActions[0].title : ''}`,
      'today'
    );
    return b;
  } catch (e) {
    if (force) notify('Grow Board', 'Could not reach the POS database. Check that SQL Server is running.', 'settings');
  }
}

async function runSchedule() {
  if (!config.notifications || !config.notifications.enabled) return;
  const N = config.notifications;
  try {
    /* morning: the goal for the day */
    if (dueNow(N.morningGoal) && !alreadyFired('morning')) {
      const b = await C.briefing(config);
      notify(
        `Today's goal: ${fmtMoney(b.goal.goal)}`,
        `${b.goal.explain[0]} ${b.topActions[0] ? '\n\nFocus today: ' + b.topActions[0].title : ''}`,
        'today');
      markFired('morning');
    }
    /* midday: pace check */
    if (dueNow(N.middayCheck) && !alreadyFired('midday')) {
      const b = await C.briefing(config);
      const pctOf = b.goal.goal ? Math.round((b.today.revenue / b.goal.goal) * 100) : 0;
      notify(
        `${fmtMoney(b.today.revenue)} so far - ${pctOf}% of goal`,
        `${b.verdict.line}`, 'today');
      markFired('midday');
    }
    /* evening: the peak-hours push */
    if (dueNow(N.eveningPush) && !alreadyFired('evening')) {
      const b = await C.briefing(config);
      const need = Math.max(0, b.goal.goal - b.today.revenue);
      notify(
        need > 0 ? `${fmtMoney(need)} to go` : 'Goal already beaten',
        need > 0
          ? `Evening is your strongest stretch. ${b.verdict.line}`
          : `${fmtMoney(b.today.revenue)} banked against a ${fmtMoney(b.goal.goal)} goal.`,
        'today');
      markFired('evening');
    }
    /* closing: the result and tomorrow's lead action */
    if (dueNow(N.closingResult) && !alreadyFired('closing')) {
      const b = await C.briefing(config);
      const hit = b.today.revenue >= b.goal.goal;
      const diff = Math.abs(b.today.revenue - b.goal.goal);
      notify(
        hit ? `Goal beaten - ${fmtMoney(b.today.revenue)}` : `Closed at ${fmtMoney(b.today.revenue)}`,
        (hit ? `${fmtMoney(diff)} over goal. ` : `${fmtMoney(diff)} short of ${fmtMoney(b.goal.goal)}. `) +
        `${b.today.bills} bills, average ${fmtMoney(b.today.abv)}.` +
        (b.topActions[0] ? `\n\nTomorrow: ${b.topActions[0].title}` : ''),
        'today');
      markFired('closing');
    }
    /* weekly review */
    if (new Date().getDay() === Number(N.weeklyReviewDay ?? 1)
        && dueNow(N.weeklyReviewTime) && !alreadyFired('weekly')) {
      const b = await C.briefing(config);
      const series = await M.dailySeries(M.iso(M.daysAgo(14)), M.iso(M.daysAgo(1)));
      const last7 = series.slice(-7).reduce((a, d) => a + d.revenue, 0);
      const prev7 = series.slice(-14, -7).reduce((a, d) => a + d.revenue, 0);
      const delta = prev7 ? ((last7 - prev7) / prev7) * 100 : 0;
      notify(
        `Last week: ${fmtMoney(last7)} (${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%)`,
        `${b.allActions.length} things worth acting on.` +
        (b.topActions[0] ? ` Biggest: ${b.topActions[0].title}.` : ''),
        'actions');
      markFired('weekly');
    }
  } catch (e) {
    lastError = e.message;
  }
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  runSchedule();
  schedulerTimer = setInterval(runSchedule, 60 * 1000);
}

/* ---------------------------------------------------------------------- IPC */

function ok(data) { return { ok: true, data }; }
function err(e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
const handle = (name, fn) => ipcMain.handle(name, async (_e, ...a) => {
  try { return ok(await fn(...a)); } catch (e) { lastError = e.message; return err(e); }
});

function registerIpc() {
  handle('app:config', () => ({ ...config, sql: { ...config.sql, password: '********' } }));
  handle('app:health', async () => {
    const h = await db.health();
    return { ...h, lastError };
  });
  handle('app:version', () => ({ version: app.getVersion(), electron: process.versions.electron }));

  handle('data:briefing', () => C.briefing(config));
  handle('data:actions', () => C.buildActions(config));
  handle('data:goal', (d) => G.dailyGoal(config, d ? new Date(d) : new Date()));
  handle('data:goalHistory', (days) => G.goalHistory(config, days || 14));
  handle('data:today', () => M.today());
  handle('data:series', (from, to) => M.dailySeries(from, to));
  handle('data:cogs', (from, to) => M.dailyCogs(from, to));
  handle('data:hourlyProfile', (wd) => M.hourlyProfile(wd === undefined ? null : wd));
  handle('data:weekday', () => M.weekdayProfile());
  handle('data:monthly', () => M.monthlyAllYears());
  handle('data:categories', (d) => M.categoryPerformance(d || 90));
  handle('data:topItems', (d, l) => M.topItems(d || 90, l || 40));
  handle('data:stockAgeing', () => M.stockAgeing());
  handle('data:deadStock', (d, l) => M.deadStock(d || 365, l || 60));
  handle('data:fastMovers', (d, l) => M.fastMovers(d || 60, l || 40));
  handle('data:stockSummary', () => M.stockSummary());
  handle('data:payables', () => M.payables());
  handle('data:receivables', () => M.receivables());
  handle('data:suppliers', (d) => M.supplierScorecard(d || 365));
  handle('data:expenses', (d) => M.expenses(d || 90));
  handle('data:expenseCoverage', (d) => M.expenseCoverage(d || 30));
  handle('data:health', () => M.dataHealth());
  handle('data:customerCapture', (d) => M.customerCapture(d || 30));
  handle('data:discounts', (d) => M.discountLeakage(d || 90));

  handle('app:refresh', () => { db.clearCache(); return true; });
  handle('app:notifyTest', () => {
    notify('Grow Board', 'Notifications are working. You will get the daily goal, a midday check, an evening push and the closing result.', 'today');
    return true;
  });
  handle('app:notifications', () => store.get('history', []).slice(-60).reverse());
  handle('app:saveSettings', (patch) => {
    const over = deepMerge(store.get('configOverride', {}), patch || {});
    store.set('configOverride', over);
    loadConfig();
    applyAutoStart();
    startScheduler();
    return true;
  });
  handle('app:openExternal', (url) => { if (/^https?:/i.test(url)) shell.openExternal(url); return true; });

  handle('update:state', () => updater.getState());
  handle('update:check', () => updater.check(true));
  handle('update:download', () => updater.download());
  handle('update:install', () => updater.installNow());

  handle('app:setPassword', async (pw) => {
    store.set('sqlPassword', creds.seal(pw || ''));
    loadConfig();
    await db.close();
    await db.connect(config);       // throws if the password is wrong
    db.clearCache();
    return await db.health();
  });
  handle('app:hasPassword', () => ({ hasPassword: !!(config.sql && config.sql.password) }));
}

/* ---------------------------------------------------------------- selftest */

/**
 * `npm run selftest` - renders every page in turn and reports any renderer
 * error. Runs headless-ish (window stays hidden) so it is safe to run while
 * the shop is trading: it never touches the desktop and never writes anything.
 */
async function runSelfTest() {
  const pages = ['today', 'actions', 'growth', 'profit', 'stock',
                 'suppliers', 'customers', 'health', 'settings'];
  const errors = [];
  const report = [];
  const say = (line) => { console.log(line); report.push(line.trim()); };
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });

  console.log('\nGrow Board self-test\n');
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 2500));

  let failed = 0;
  for (const p of pages) {
    const before = errors.length;
    win.webContents.send('navigate', p);
    await new Promise(r => setTimeout(r, 2600));
    const html = await win.webContents.executeJavaScript(
      `(document.getElementById('page-${p}')||{}).innerHTML || ''`).catch(() => '');
    const broke = errors.length > before;
    const empty = html.length < 200;
    const notice = /notice bad|Could not load this page/.test(html);
    const bad = broke || empty || notice;
    if (bad) failed++;
    say(`  ${bad ? '[FAIL]' : '[ok]  '} ${p.padEnd(11)} ${String(html.length).padStart(7)} chars` +
                (broke ? `  error: ${errors[before]}` : '') +
                (empty && !broke ? '  rendered nothing' : '') +
                (notice && !broke && !empty ? '  rendered an error notice' : ''));
  }
  console.log(`\n  ${pages.length - failed}/${pages.length} pages rendered.` +
              (errors.length ? `\n  console errors:\n    ${errors.slice(0, 8).join('\n    ')}` : ''));
  console.log('');

  // A packaged Windows GUI build has no reliable stdout, and app.exit() can
  // discard whatever is still buffered. Write the report to a file as well, and
  // flush before exiting so `npm run selftest` output is never silently lost.
  const reportPath = path.join(app.getPath('userData'), 'selftest-report.txt');
  try {
    fs.writeFileSync(reportPath,
      `Grow Board self-test  ${new Date().toISOString()}\n` +
      `version ${app.getVersion()}\n\n` + report.join('\n') +
      `\n\n${pages.length - failed}/${pages.length} pages rendered.\n` +
      (errors.length ? `\nconsole errors:\n  ${errors.join('\n  ')}\n` : ''), 'utf8');
    console.log(`  report written to ${reportPath}\n`);
  } catch { /* the console output above is enough */ }

  app.isQuitting = true;
  const done = () => app.exit(failed ? 1 : 0);
  if (!process.stdout.write('')) process.stdout.once('drain', done); else setTimeout(done, 120);
}

/* --------------------------------------------------------------- auto start */

function applyAutoStart() {
  if (process.platform !== 'win32') return;
  const want = !!(config.app && config.app.autoStart);
  try {
    app.setLoginItemSettings({
      openAtLogin: want,
      openAsHidden: true,
      args: ['--tray']
    });
  } catch { /* not fatal */ }
}

/* --------------------------------------------------------------------- boot */

// The self-test must never be blocked by an already-running copy: if it were,
// it would quit with exit code 0 and look like a pass. It opts out of the lock.
const isSelfTest = process.argv.includes('--selftest');
const single = isSelfTest || app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    app.setAppUserModelId('in.dlt.growboard');
    store.init(app.getPath('userData'));
    loadConfig();
    registerIpc();

    try { await db.connect(config); } catch (e) { lastError = e.message; }

    if (isSelfTest) { createWindow(false); return runSelfTest(); }

    const startHidden = process.argv.includes('--tray') || (config.app && config.app.startMinimised);
    createWindow(!startHidden);
    createTray();
    applyAutoStart();
    startScheduler();
    updater.init(win, config);
  });

  app.on('window-all-closed', () => { /* stay alive in the tray */ });
  app.on('activate', () => { if (!win) createWindow(true); });
  app.on('before-quit', () => { app.isQuitting = true; });
  app.on('will-quit', async () => { try { await db.close(); } catch { /* ignore */ } });
}
