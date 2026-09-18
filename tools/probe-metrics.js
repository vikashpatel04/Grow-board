/* Runs every metric against the live database and prints a compact report.
   Use this after changing any SQL: `npm run probe` */
'use strict';
const path = require('path');
const fs = require('fs');
const db = require('../src/db');
const M = require('../src/metrics');

const cfg = require('./load-config').load();
const money = v => '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN');

async function run(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - t0;
    const size = Array.isArray(r) ? `${r.length} rows` : 'object';
    console.log(`  [ok]   ${name.padEnd(24)} ${String(ms).padStart(5)}ms  ${size}`);
    return r;
  } catch (e) {
    console.log(`  [FAIL] ${name.padEnd(24)} ${e.message.split('\n')[0].slice(0, 140)}`);
    return null;
  }
}

(async () => {
  await db.connect(cfg);
  const h = await db.health();
  console.log(`\nConnected: ${h.server}  year db: ${h.yearDb}  server time: ${h.serverTime.toISOString()}\n`);

  console.log('Metrics:');
  const today = await run('today', () => M.today());
  await run('hourlyProfile', () => M.hourlyProfile());
  const series = await run('dailySeries(60d)', () => M.dailySeries(M.iso(M.daysAgo(60)), M.iso(new Date())));
  await run('dailyCogs(60d)', () => M.dailyCogs(M.iso(M.daysAgo(60)), M.iso(new Date())));
  await run('weekdayProfile', () => M.weekdayProfile());
  await run('monthlyAllYears', () => M.monthlyAllYears());
  const cat = await run('categoryPerformance', () => M.categoryPerformance(90));
  await run('topItems', () => M.topItems(90, 20));
  const age = await run('stockAgeing', () => M.stockAgeing());
  const dead = await run('deadStock', () => M.deadStock(365, 30));
  const fast = await run('fastMovers', () => M.fastMovers(60, 20));
  const stock = await run('stockSummary', () => M.stockSummary());
  const pay = await run('payables', () => M.payables());
  await run('receivables', () => M.receivables());
  const sup = await run('supplierScorecard', () => M.supplierScorecard(365));
  const exp = await run('expenses', () => M.expenses(90));
  const cov = await run('expenseCoverage', () => M.expenseCoverage(30));
  const health = await run('dataHealth', () => M.dataHealth());
  const cust = await run('customerCapture', () => M.customerCapture(30));
  await run('discountLeakage', () => M.discountLeakage(90));

  console.log('\nSanity values:');
  if (today) console.log(`  today            revenue ${money(today.revenue)}  bills ${today.bills}  margin ${today.marginPct.toFixed(1)}%`);
  if (series && series.length) {
    const tot = series.reduce((a, b) => a + b.revenue, 0);
    console.log(`  last 60 days     revenue ${money(tot)}  over ${series.length} trading days`);
  }
  if (stock) console.log(`  stock            ${stock.items} items  cost ${money(stock.costValue)}  retail ${money(stock.retailValue)}`);
  if (age) age.forEach(a => console.log(`    ${a.band.padEnd(18)} ${String(a.tags).padStart(5)} tags  ${money(a.costValue).padStart(12)}`));
  if (dead && dead.length) console.log(`  dead stock       ${dead.length} items listed, top: ${dead[0].name} ${money(dead[0].costValue)} idle ${dead[0].idleDays}d`);
  if (fast && fast.length) console.log(`  fast movers      ${fast.length} low-cover items, top: ${fast[0].name} cover ${fast[0].coverDays}d`);
  if (pay) console.log(`  payables         ${pay.length} suppliers  total ${money(pay.reduce((a, b) => a + b.balance, 0))}`);
  if (sup && sup.length) console.log(`  suppliers scored ${sup.length}, top: ${sup[0].name} bought ${money(sup[0].purchaseValue)} margin ${sup[0].marginPct.toFixed(1)}%`);
  if (exp) console.log(`  expenses(90d)    ${exp.length} heads  total ${money(exp.reduce((a, b) => a + b.amount, 0))}`);
  if (cov) console.log(`  expense coverage ${cov.daysWithExpense}/${cov.tradingDays} trading days have an entry`);
  if (cust) console.log(`  customer capture ${cust.withCustomer}/${cust.bills} bills (${cust.pct.toFixed(1)}%)`);
  if (cat && cat.length) console.log(`  top category     ${cat[0].category} ${money(cat[0].revenue)} margin ${cat[0].marginPct.toFixed(1)}%`);
  if (health) console.log(`  health           ledger-bad-days ${health.ledgerUnbalancedDays}, cache-drift ${health.stockCacheDrift}, negative ${health.negativeStockItems}, dup bills ${health.duplicateBills}, purch-mismatch ${health.purchaseStockMismatches}`);

  await db.close();
  console.log('');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
