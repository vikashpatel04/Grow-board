/**
 * Grow Board - preload bridge.
 * The renderer gets a narrow, named API. No SQL, no Node, no ipcRenderer.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('gb', {
  config: () => call('app:config'),
  health: () => call('app:health'),
  version: () => call('app:version'),
  refresh: () => call('app:refresh'),
  saveSettings: (patch) => call('app:saveSettings', patch),
  notifyTest: () => call('app:notifyTest'),
  notifications: () => call('app:notifications'),
  openExternal: (url) => call('app:openExternal', url),

  briefing: () => call('data:briefing'),
  actions: () => call('data:actions'),
  goal: (d) => call('data:goal', d),
  goalHistory: (days) => call('data:goalHistory', days),
  today: () => call('data:today'),
  series: (from, to) => call('data:series', from, to),
  cogs: (from, to) => call('data:cogs', from, to),
  hourlyProfile: (wd) => call('data:hourlyProfile', wd),
  weekday: () => call('data:weekday'),
  monthly: () => call('data:monthly'),
  categories: (d) => call('data:categories', d),
  topItems: (d, l) => call('data:topItems', d, l),
  stockAgeing: () => call('data:stockAgeing'),
  deadStock: (d, l) => call('data:deadStock', d, l),
  fastMovers: (d, l) => call('data:fastMovers', d, l),
  stockSummary: () => call('data:stockSummary'),
  payables: () => call('data:payables'),
  receivables: () => call('data:receivables'),
  suppliers: (d) => call('data:suppliers', d),
  expenses: (d) => call('data:expenses', d),
  expenseCoverage: (d) => call('data:expenseCoverage', d),
  dataHealth: () => call('data:health'),
  customerCapture: (d) => call('data:customerCapture', d),
  discounts: (d) => call('data:discounts', d),

  updateState: () => call('update:state'),
  updateCheck: () => call('update:check'),
  updateDownload: () => call('update:download'),
  updateInstall: () => call('update:install'),
  setPassword: (pw) => call('app:setPassword', pw),
  hasPassword: () => call('app:hasPassword'),
  onUpdateState: (fn) => ipcRenderer.on('update:state', (_e, s) => fn(s)),

  onNavigate: (fn) => ipcRenderer.on('navigate', (_e, page) => fn(page)),
  onRefresh: (fn) => ipcRenderer.on('refresh', () => fn())
});
