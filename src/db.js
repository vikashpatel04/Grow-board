/**
 * Grow Board - database layer.
 *
 * STRICTLY READ-ONLY. Every statement issued from this file is a SELECT.
 * There is no INSERT/UPDATE/DELETE anywhere in this application, by design.
 *
 * Connects to the POS SQL Server, resolves the live financial-year database
 * from DLTAdmindb.dbo.dbmaster, and caches query results briefly so the
 * dashboard can refresh often without loading the till.
 */
'use strict';

const sql = require('mssql');

let pool = null;
let cfg = null;
let yearDbCache = { name: null, at: 0, start: null, end: null };
const resultCache = new Map();

/** Guard: refuse anything that is not a read. Cheap insurance against a typo. */
const WRITE_RE = /\b(insert|update|delete|drop|alter|create|truncate|merge|exec|execute|grant|revoke|backup|restore)\b/i;
function assertReadOnly(text) {
  // Strip string literals and comments first so data like 'UPDATE PENDING' can't trip it.
  const stripped = String(text)
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (WRITE_RE.test(stripped)) {
    throw new Error('Grow Board is read-only; refused a statement that looked like a write.');
  }
}

function buildConfig(appConfig) {
  const s = appConfig.sql;
  const out = {
    server: s.server,
    database: s.adminDb,
    user: s.user,
    password: s.password,
    pool: { max: 6, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
      // SQL Server 2014 negotiates an old TLS version; Node 18+ refuses by default.
      cryptoCredentialsDetails: { minVersion: 'TLSv1' },
      readOnlyIntent: true
    },
    connectionTimeout: 10000,
    requestTimeout: 30000
  };
  if (s.port) out.port = Number(s.port);
  if (s.instanceName) out.options.instanceName = s.instanceName;
  return out;
}

async function connect(appConfig) {
  cfg = appConfig;
  if (pool && pool.connected) return pool;
  if (pool) { try { await pool.close(); } catch { /* ignore */ } }
  pool = await new sql.ConnectionPool(buildConfig(appConfig)).connect();
  return pool;
}

async function isConnected() {
  return !!(pool && pool.connected);
}

async function close() {
  if (pool) { try { await pool.close(); } catch { /* ignore */ } pool = null; }
}

/**
 * Resolve the live financial-year database from dbmaster.
 * Falls back to the newest DLTT* row if today sits outside every range
 * (which happens if the shop has not rolled over yet).
 */
async function yearDb(force = false) {
  const FIVE_MIN = 5 * 60 * 1000;
  if (!force && yearDbCache.name && Date.now() - yearDbCache.at < FIVE_MIN) return yearDbCache.name;
  const p = await connect(cfg);
  const q = `
    SELECT TOP 1 dbname, startdate, enddate
    FROM   ${cfg.sql.adminDb}.dbo.dbmaster
    WHERE  dbtype = 'T' AND GETDATE() >= startdate AND GETDATE() < DATEADD(day,1,enddate)
    ORDER  BY startdate DESC`;
  let r = await p.request().query(q);
  if (!r.recordset.length) {
    r = await p.request().query(`
      SELECT TOP 1 dbname, startdate, enddate
      FROM   ${cfg.sql.adminDb}.dbo.dbmaster
      WHERE  dbtype = 'T' ORDER BY startdate DESC`);
  }
  if (!r.recordset.length) throw new Error('No transaction database found in dbmaster.');
  const row = r.recordset[0];
  yearDbCache = { name: row.dbname, at: Date.now(), start: row.startdate, end: row.enddate };
  return row.dbname;
}

/** All financial years on the server, newest first. Used by trend pages. */
async function allYearDbs() {
  const p = await connect(cfg);
  const r = await p.request().query(`
    SELECT dbname, startdate, enddate FROM ${cfg.sql.adminDb}.dbo.dbmaster
    WHERE dbtype = 'T' ORDER BY startdate DESC`);
  return r.recordset.map(x => ({
    db: x.dbname,
    start: x.startdate,
    end: x.enddate,
    label: fyLabel(x.startdate)
  }));
}

function fyLabel(start) {
  const d = new Date(start);
  const a = d.getFullYear() % 100;
  return `${String(a).padStart(2, '0')}-${String((a + 1) % 100).padStart(2, '0')}`;
}

function yearRange() {
  return { start: yearDbCache.start, end: yearDbCache.end };
}

/**
 * Run a parameterised read. `params` is a plain object; values are bound,
 * never interpolated. Placeholders that must be identifiers (database names)
 * are substituted through the {{YEAR}} / {{ADMIN}} tokens instead.
 */
async function query(text, params = {}, opts = {}) {
  const p = await connect(cfg);
  const ydb = await yearDb();
  const sqlText = String(text)
    .replace(/\{\{YEAR\}\}/g, `[${ydb}].dbo`)
    .replace(/\{\{ADMIN\}\}/g, `[${cfg.sql.adminDb}].dbo`);
  assertReadOnly(sqlText);

  const key = opts.cacheKey || (sqlText + '|' + JSON.stringify(params));
  const ttl = opts.ttlMs === undefined ? 20000 : opts.ttlMs;
  if (ttl > 0) {
    const hit = resultCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.rows;
  }

  const req = p.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  const r = await req.query(sqlText);
  const rows = r.recordset || [];
  if (ttl > 0) resultCache.set(key, { at: Date.now(), rows });
  return rows;
}

/** Same, but against an explicit database (for multi-year trend queries). */
async function queryIn(dbName, text, params = {}, opts = {}) {
  const p = await connect(cfg);
  const sqlText = String(text)
    .replace(/\{\{YEAR\}\}/g, `[${dbName}].dbo`)
    .replace(/\{\{ADMIN\}\}/g, `[${cfg.sql.adminDb}].dbo`);
  assertReadOnly(sqlText);
  const key = opts.cacheKey || (dbName + '|' + sqlText + '|' + JSON.stringify(params));
  const ttl = opts.ttlMs === undefined ? 300000 : opts.ttlMs;
  if (ttl > 0) {
    const hit = resultCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.rows;
  }
  const req = p.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  const r = await req.query(sqlText);
  const rows = r.recordset || [];
  if (ttl > 0) resultCache.set(key, { at: Date.now(), rows });
  return rows;
}

function clearCache() { resultCache.clear(); }

async function health() {
  const p = await connect(cfg);
  const r = await p.request().query('SELECT GETDATE() AS now, @@SERVERNAME AS server');
  const ydb = await yearDb();
  return { ok: true, serverTime: r.recordset[0].now, server: r.recordset[0].server, yearDb: ydb };
}

module.exports = {
  connect, close, isConnected, query, queryIn, yearDb, allYearDbs,
  yearRange, clearCache, health, fyLabel
};
