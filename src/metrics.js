/**
 * Grow Board - metrics.
 *
 * Every figure here follows the rules established in D:\DATA\POS-Schema:
 *   - money comes from `saleshead` (the general ledger), never `SalesEntry`
 *   - soft deletes are filtered with ISNULL(Cancel,'') <> 'Y'
 *   - stock is never filtered by date (ItemTag spans all years)
 *   - purchases join to stock on BatchNo, never Tagno or ENTREFNO
 *   - time-of-day comes from sales.UpTime (100% populated)
 *   - any date range reads every financial-year database it touches
 *     (db.queryRange), so nothing goes blank on 1 April and "last 90 days"
 *     really is 90 days. Stock and payables stay on the live year: ItemTag and
 *     outstanding carry their history forward, so reading them twice would
 *     double count.
 *   - line-level sales value is TAXABLE + GST, net of returned lines. sales.AMOUNT
 *     is the price BEFORE discount and overstates takings by the discount given.
 *
 * Ledger shorthand used throughout:
 *   PAYMENTMODE 'S' = goods value   (SALE5P credit / SRTE5P debit) - only 2 accounts
 *   PAYMENTMODE 'T' = GST           (filter BILLTYPE to CS/CR to exclude purchase tax)
 *   PAYMENTMODE 'C' = cash, 'H' = bank/card, 'Q' = UPI, 'R' = customer credit
 *   PAYMENTMODE 'D' / 'I' = discount and its contra - NEVER counted as tender
 */
'use strict';

const db = require('./db');
const P = require('./periods');

/* ------------------------------------------------------------------ helpers */

const NET_GOODS = `SUM(CASE WHEN sh.PAYMENTMODE='S' AND sh.TRANTYPE='C' THEN sh.amount
                            WHEN sh.PAYMENTMODE='S' AND sh.TRANTYPE='D' THEN -sh.amount
                            ELSE 0 END)`;
const NET_GST = `SUM(CASE WHEN sh.PAYMENTMODE='T' AND sh.BILLTYPE IN ('CS','CR') AND sh.TRANTYPE='C' THEN sh.amount
                          WHEN sh.PAYMENTMODE='T' AND sh.BILLTYPE IN ('CS','CR') AND sh.TRANTYPE='D' THEN -sh.amount
                          ELSE 0 END)`;
const DISCOUNT = `SUM(CASE WHEN sh.PAYMENTMODE='D' AND sh.TRANTYPE='D' THEN sh.amount
                           WHEN sh.PAYMENTMODE='D' AND sh.TRANTYPE='C' THEN -sh.amount
                           ELSE 0 END)`;
const LIVE = `ISNULL(sh.Cancel,'') <> 'Y'`;

const n = v => (v === null || v === undefined ? 0 : Number(v));
const iso = d => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
function daysAgo(k) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - k); return d; }
/** Last `days` days up to today, as an inclusive [from, to] date range. */
const lastDays = days => ({ from: iso(daysAgo(days)), to: iso(new Date()) });
/** Keep the larger of two dates given as 'YYYY-MM-DD'. */
const maxIso = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

/* ------------------------------------------------------------ daily series */

/**
 * Core daily fact table. One row per trading day with the numbers every page
 * needs. This is the single source the rest of the app aggregates from.
 */
async function dailySeries(fromDate, toDate) {
  const rows = await db.queryRange(fromDate, toDate, `
    SELECT sh.BILLDATE AS d,
           CAST(${NET_GOODS} AS numeric(18,2)) AS goods,
           CAST(${NET_GST}   AS numeric(18,2)) AS gst,
           CAST(${DISCOUNT}  AS numeric(18,2)) AS discount,
           COUNT(DISTINCT CASE WHEN sh.PAYMENTMODE='S' AND sh.TRANTYPE='C' THEN sh.ENTREFNO END) AS bills,
           CAST(SUM(CASE WHEN sh.PAYMENTMODE='C' AND sh.BILLTYPE IN ('CS','CR') AND sh.TRANTYPE='D' THEN sh.amount
                         WHEN sh.PAYMENTMODE='C' AND sh.BILLTYPE IN ('CS','CR') AND sh.TRANTYPE='C' THEN -sh.amount
                         ELSE 0 END) AS numeric(18,2)) AS cash,
           CAST(SUM(CASE WHEN sh.PAYMENTMODE IN ('H','Q') AND sh.BILLTYPE IN ('CS','CR') AND sh.TRANTYPE='D' THEN sh.amount
                         WHEN sh.PAYMENTMODE IN ('H','Q') AND sh.BILLTYPE IN ('CS','CR') AND sh.TRANTYPE='C' THEN -sh.amount
                         ELSE 0 END) AS numeric(18,2)) AS digital,
           CAST(SUM(CASE WHEN sh.PAYMENTMODE='R' AND sh.BILLTYPE IN ('CS','CR') AND sh.TRANTYPE='D' THEN sh.amount
                         WHEN sh.PAYMENTMODE='R' AND sh.BILLTYPE IN ('CS','CR') AND sh.TRANTYPE='C' THEN -sh.amount
                         ELSE 0 END) AS numeric(18,2)) AS credit,
           CAST(SUM(CASE WHEN sh.PAYMENTMODE='S' AND sh.TRANTYPE='D' THEN sh.amount ELSE 0 END) AS numeric(18,2)) AS returns
    FROM {{YEAR}}.saleshead sh
    WHERE ${LIVE} AND sh.BILLDATE >= @from AND sh.BILLDATE <= @to
    GROUP BY sh.BILLDATE`, {}, { ttlMs: 30000 });

  return rows.sort((a, b) => a.d - b.d).map(r => ({
    date: iso(r.d),
    goods: n(r.goods), gst: n(r.gst),
    revenue: n(r.goods) + n(r.gst),
    discount: n(r.discount), bills: n(r.bills),
    cash: n(r.cash), digital: n(r.digital), credit: n(r.credit),
    returns: n(r.returns),
    abv: n(r.bills) ? (n(r.goods) + n(r.gst)) / n(r.bills) : 0
  }));
}

/** Cost of goods sold per day, from the cost stamped on each stock movement. */
async function dailyCogs(fromDate, toDate) {
  const rows = await db.queryRange(fromDate, toDate, `
    SELECT s.BILLDATE AS d,
           CAST(SUM(s.QTY * ISNULL(NULLIF(s.CostRate,0), s.PurRate)) AS numeric(18,2)) AS cogs,
           CAST(SUM(s.TAXABLE) AS numeric(18,2)) AS taxable,
           COUNT(*) AS units
    FROM {{YEAR}}.sales s
    WHERE ISNULL(s.Cancel,'') <> 'Y' AND s.BILLDATE >= @from AND s.BILLDATE <= @to
    GROUP BY s.BILLDATE`, {}, { ttlMs: 30000 });
  const back = await db.queryRange(fromDate, toDate, `
    SELECT e.BILLDATE AS d,
           CAST(SUM(e.QTY * ISNULL(NULLIF(e.CostRate,0), e.purrate)) AS numeric(18,2)) AS cogs,
           CAST(SUM(e.TAXABLE) AS numeric(18,2)) AS taxable,
           COUNT(*) AS units
    FROM {{YEAR}}.exchange e
    WHERE ISNULL(e.Cancel,'') <> 'Y' AND e.BILLDATE >= @from AND e.BILLDATE <= @to
    GROUP BY e.BILLDATE`, {}, { ttlMs: 30000 });

  const m = new Map();
  for (const r of rows) m.set(iso(r.d), { date: iso(r.d), cogs: n(r.cogs), taxable: n(r.taxable), units: n(r.units) });
  for (const r of back) {
    const k = iso(r.d); const e = m.get(k) || { date: k, cogs: 0, taxable: 0, units: 0 };
    e.cogs -= n(r.cogs); e.taxable -= n(r.taxable); e.units -= n(r.units);
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => a.date < b.date ? -1 : 1);
}

/* -------------------------------------------------------------------- today */

async function today() {
  const t = iso(new Date());
  const [series, cogs, hourly] = await Promise.all([
    dailySeries(t, t),
    dailyCogs(t, t),
    hourlyToday()
  ]);
  const d = series[0] || {
    date: t, goods: 0, gst: 0, revenue: 0, discount: 0, bills: 0,
    cash: 0, digital: 0, credit: 0, returns: 0, abv: 0
  };
  const c = cogs[0] || { cogs: 0, taxable: 0, units: 0 };
  return {
    ...d,
    cogs: c.cogs,
    units: c.units,
    grossProfit: c.taxable - c.cogs,
    marginPct: c.taxable ? ((c.taxable - c.cogs) / c.taxable) * 100 : 0,
    hourly
  };
}

/** Today's revenue by hour, from sales.UpTime (the only fully populated clock). */
async function hourlyToday() {
  const t = iso(new Date());
  const rows = await db.query(`
    SELECT DATEPART(hour, s.UpTime) AS hr,
           CAST(SUM(s.AMOUNT) AS numeric(18,2)) AS amt,
           COUNT(DISTINCT s.ENTREFNO) AS bills
    FROM {{YEAR}}.sales s
    WHERE ISNULL(s.Cancel,'') <> 'Y' AND s.BILLDATE = @t AND s.UpTime IS NOT NULL
    GROUP BY DATEPART(hour, s.UpTime) ORDER BY hr`, { t }, { ttlMs: 20000 });
  return rows.map(r => ({ hour: n(r.hr), amount: n(r.amt), bills: n(r.bills) }));
}

/**
 * The shop's typical hourly shape, used to pace the day and to staff it.
 * Rolling twelve months, so the shape survives the 1 April rollover.
 */
async function hourlyProfile(weekdayOnly = null) {
  const wd = weekdayOnly === null ? -1 : weekdayOnly;
  const { from, to } = lastDays(365);
  const rows = await db.queryRange(from, to, `
    SELECT DATEPART(hour, s.UpTime) AS hr,
           CAST(SUM(s.AMOUNT) AS numeric(18,2)) AS amt,
           COUNT(DISTINCT s.BILLDATE) AS days,
           COUNT(DISTINCT s.ENTREFNO) AS bills
    FROM {{YEAR}}.sales s
    WHERE ISNULL(s.Cancel,'') <> 'Y' AND s.UpTime IS NOT NULL
      AND s.BILLDATE >= @from AND s.BILLDATE <= @to
      AND (@wd = -1 OR (DATEDIFF(day, '19700104', s.BILLDATE) % 7) = @wd)
    GROUP BY DATEPART(hour, s.UpTime)`, { wd }, { ttlMs: 600000 });
  // A bill or a day belongs to one year database, so the per-year counts add up.
  const by = new Map();
  for (const r of rows) {
    const e = by.get(n(r.hr)) || { hour: n(r.hr), amt: 0, days: 0, bills: 0 };
    e.amt += n(r.amt); e.days += n(r.days); e.bills += n(r.bills);
    by.set(e.hour, e);
  }
  return [...by.values()].sort((a, b) => a.hour - b.hour).map(e => ({
    hour: e.hour,
    avgAmount: e.days ? e.amt / e.days : 0,
    bills: e.bills, days: e.days
  }));
}

/* -------------------------------------------------------------- performance */

/** Average takings per weekday over the last twelve months. */
async function weekdayProfile() {
  const { from, to } = lastDays(365);
  const rows = await db.queryRange(from, to, `
    SELECT (DATEDIFF(day, '19700104', sh.BILLDATE) % 7) AS wd,
           CAST(${NET_GOODS} + ${NET_GST} AS numeric(18,2)) AS revenue,
           COUNT(DISTINCT sh.BILLDATE) AS days
    FROM {{YEAR}}.saleshead sh
    WHERE ${LIVE} AND sh.BILLDATE >= @from AND sh.BILLDATE <= @to
    GROUP BY (DATEDIFF(day, '19700104', sh.BILLDATE) % 7)`, {}, { ttlMs: 600000 });
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const by = new Map();
  for (const r of rows) {
    const e = by.get(n(r.wd)) || { wd: n(r.wd), revenue: 0, days: 0 };
    e.revenue += n(r.revenue); e.days += n(r.days);
    by.set(e.wd, e);
  }
  return [...by.values()].sort((a, b) => a.wd - b.wd).map(e => ({
    weekday: e.wd, name: names[e.wd] || '?',
    avgRevenue: e.days ? e.revenue / e.days : 0,
    days: e.days
  }));
}

/** Month-by-month revenue across every financial year on the server. */
async function monthlyAllYears() {
  const years = await db.allYearDbs();
  const out = [];
  for (const y of years.slice(0, 5)) {
    try {
      const rows = await db.queryIn(y.db, `
        SELECT YEAR(sh.BILLDATE) AS y, MONTH(sh.BILLDATE) AS m,
               CAST(${NET_GOODS} + ${NET_GST} AS numeric(18,2)) AS revenue,
               COUNT(DISTINCT CASE WHEN sh.PAYMENTMODE='S' AND sh.TRANTYPE='C' THEN sh.ENTREFNO END) AS bills
        FROM {{YEAR}}.saleshead sh WHERE ${LIVE}
        GROUP BY YEAR(sh.BILLDATE), MONTH(sh.BILLDATE)`, {}, { ttlMs: 900000 });
      for (const r of rows) {
        out.push({ fy: y.label, year: n(r.y), month: n(r.m), revenue: n(r.revenue), bills: n(r.bills) });
      }
    } catch { /* an older year may not be reachable; skip it */ }
  }
  return out.sort((a, b) => a.year - b.year || a.month - b.month);
}

/* ---------------------------------------------------------------- explorer */

/*
 * One engine behind every "sorted" view of sales and profit: pick a period,
 * a way to slice it (by day, category, item, price band, supplier, size...),
 * optional filters, and it returns each slice with last year alongside.
 *
 * Built on sale lines (sales) net of returned lines (exchange), because only
 * lines carry item, cost and tag. Line value reconciles with the ledger to
 * round-off: FY26-27 to 15 Oct, ₹34,64,579 on lines against ₹34,62,974 in
 * saleshead.
 *
 * In the SQL fragments below `$.` stands for the table alias (s or e),
 * `$TAG` for its tag column and `$PUR` for its purchase-rate column - the two
 * tables spell them differently.
 */

const PRICE_BANDS = {
  1: 'Under ₹300', 2: '₹300 – 599', 3: '₹600 – 999', 4: '₹1,000 – 1,999', 5: '₹2,000 and above'
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const JOIN_ORDER = ['cat', 'pu', 'sup', 'size'];
const JOINS = {
  cat: `LEFT JOIN {{ADMIN}}.itemmast i ON i.ITEMID = $.ITEMID
        LEFT JOIN {{ADMIN}}.catmast  c ON c.CATID  = i.CATID`,
  // Supplier and size live on the tag's purchase receipt, in the same year
  // database as the sale (ItemTag carries open lots forward each year).
  pu: `OUTER APPLY (SELECT TOP 1 NULLIF(t.Supplier,'') AS Supplier, NULLIF(t.SizeEntryId,'') AS SizeEntryId
                    FROM {{YEAR}}.ItemTag t
                    WHERE t.Tagno = $TAG AND t.itemid = $.ITEMID AND t.billtype = 'PU'
                      AND ISNULL(t.cancel,'') <> 'Y') pu`,
  sup: `LEFT JOIN {{ADMIN}}.ACCMAST a ON a.accode = pu.Supplier`,
  size: `LEFT JOIN {{ADMIN}}.SizeEntry se ON se.SizeEntryid = pu.SizeEntryId`
};
const DAY_KEY = 'CONVERT(char(8), $.BILLDATE, 112)';

/** Ways to slice. `time` slices are fetched by day and bucketed in JS. */
const DIMS = {
  day:      { time: true, key: DAY_KEY },
  week:     { time: true, key: DAY_KEY },
  month:    { time: true, key: DAY_KEY },
  weekday:  { key: "CAST(DATEDIFF(day, '19700104', $.BILLDATE) % 7 AS varchar(2))" },
  hour:     { key: 'CAST(DATEPART(hour, $.UpTime) AS varchar(2))' },
  category: { key: "ISNULL(c.CATNAME,'(uncategorised)')", joins: ['cat'] },
  item:     { key: 'CAST($.ITEMID AS varchar(20))', label: 'i.ITEMNAME', sub: 'c.CATNAME', joins: ['cat'] },
  price:    { key: `CASE WHEN $.SELRATE < 300 THEN '1' WHEN $.SELRATE < 600 THEN '2'
                         WHEN $.SELRATE < 1000 THEN '3' WHEN $.SELRATE < 2000 THEN '4' ELSE '5' END` },
  supplier: { key: "ISNULL(pu.Supplier,'')", label: 'a.NAME', joins: ['pu', 'sup'] },
  size:     { key: "ISNULL(se.SizeEntryName,'')", joins: ['pu', 'size'] }
};
const FILTERABLE = ['category', 'item', 'price', 'supplier', 'size', 'weekday', 'hour'];

function exploreSql(by, filter, excludeCount) {
  const dims = [by, ...Object.keys(filter)];
  const needs = new Set(dims.flatMap(d => DIMS[d].joins || []));
  const part = (alias, table, sign, tag, pur, disc, bill) => {
    const sub = s => s.replace(/\$TAG/g, tag).replace(/\$PUR/g, pur).replace(/\$\./g, `${alias}.`);
    const joins = JOIN_ORDER.filter(j => needs.has(j)).map(j => sub(JOINS[j])).join('\n');
    const where = Object.keys(filter).map(d => `AND (${sub(DIMS[d].key)}) = @f_${d}`).join('\n');
    const skip = Array.from({ length: excludeCount }, (_, k) =>
      `AND NOT (${alias}.BILLDATE >= @x${k}a AND ${alias}.BILLDATE <= @x${k}b)`).join('\n');
    const d = DIMS[by];
    return `
      SELECT ${sub(d.key)} AS k,
             ${d.label ? sub(d.label) : 'CAST(NULL AS varchar(200))'} AS lbl,
             ${d.sub ? sub(d.sub) : 'CAST(NULL AS varchar(200))'} AS sub,
             ${sign} AS sgn, ${bill} AS bill,
             ${alias}.TAXABLE AS taxable,
             ISNULL(${alias}.CGSTVal,0) + ISNULL(${alias}.SGSTVal,0) + ISNULL(${alias}.IGSTVal,0) AS gst,
             ${alias}.QTY * ISNULL(NULLIF(${alias}.CostRate,0), ${pur}) AS cost,
             ${disc} AS disc
      FROM {{YEAR}}.${table} ${alias}
      ${joins}
      WHERE ISNULL(${alias}.Cancel,'') <> 'Y'
        AND ${alias}.BILLDATE >= @from AND ${alias}.BILLDATE <= @to
        ${where}
        ${skip}`;
  };
  return `
    WITH lines AS (
      ${part('s', 'sales', 1, 's.TagNo', 's.PurRate', 'ISNULL(s.disccash,0)', 's.ENTREFNO')}
      UNION ALL
      ${part('e', 'exchange', -1, 'e.tagno', 'e.purrate', '0', 'NULL')}
    )
    SELECT k, MAX(lbl) AS lbl, MAX(sub) AS sub,
           SUM(sgn) AS units,
           COUNT(DISTINCT bill) AS bills,
           CAST(SUM(sgn * taxable) AS numeric(18,2)) AS taxable,
           CAST(SUM(sgn * gst)     AS numeric(18,2)) AS gst,
           CAST(SUM(sgn * cost)    AS numeric(18,2)) AS cogs,
           CAST(SUM(disc)          AS numeric(18,2)) AS disc,
           SUM(CASE WHEN disc > 0 THEN 1 ELSE 0 END) AS disc_lines,
           -- Opening stock was migrated with no cost on thousands of lots; selling
           -- it shows 100% margin. Measured so a page can say so.
           CAST(SUM(CASE WHEN ISNULL(cost,0) = 0 THEN sgn * taxable ELSE 0 END) AS numeric(18,2)) AS zero_cost
    FROM lines GROUP BY k`;
}

const emptyAgg = () => ({ units: 0, bills: 0, taxable: 0, gst: 0, cogs: 0, disc: 0, discLines: 0, zeroCost: 0 });
function addAgg(a, r, scale = 1) {
  a.units += n(r.units) * scale; a.bills += n(r.bills) * scale;
  a.taxable += n(r.taxable) * scale; a.gst += n(r.gst) * scale;
  a.cogs += n(r.cogs) * scale; a.disc += n(r.disc) * scale; a.discLines += n(r.disc_lines ?? r.discLines) * scale;
  a.zeroCost += n(r.zero_cost ?? r.zeroCost) * scale;
  return a;
}
/** Derived figures every view shows. */
function finishAgg(a) {
  const revenue = a.taxable + a.gst;
  const gp = a.taxable - a.cogs;
  return {
    ...a, revenue, gp,
    margin: a.taxable ? (gp / a.taxable) * 100 : 0,
    discRate: revenue + a.disc ? (a.disc / (revenue + a.disc)) * 100 : 0,
    zeroCostPct: a.taxable > 0 ? (a.zeroCost / a.taxable) * 100 : 0,
    // Margin on lines that carry a real cost. Zero-cost lines earn 100% and
    // would otherwise pass for a pricing or buying change.
    costedMargin: a.taxable - a.zeroCost > 0 ? ((gp - a.zeroCost) / (a.taxable - a.zeroCost)) * 100 : 0
  };
}

/** Monday of the week a date falls in. */
function weekOf(date) {
  const d = P.parse(date);
  return P.addDays(date, -((d.getDay() + 6) % 7));
}
function timeBucket(by, date) {
  if (by === 'week') return weekOf(date);
  if (by === 'month') return date.slice(0, 7);
  return date;
}
function labelFor(by, key, row) {
  switch (by) {
    case 'day': { const d = P.parse(key); return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${P.fmt(key)}`; }
    case 'week': return `Week of ${P.fmt(key)}`;
    case 'month': return `${P.MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
    case 'weekday': return WEEKDAYS[Number(key)] || key;
    case 'hour': { const h = Number(key); return key === '' || isNaN(h) ? '(no time)' : h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 noon' : `${h - 12} pm`; }
    case 'price': return PRICE_BANDS[key] || key;
    case 'supplier': return key ? (row && row.lbl) || key : '(supplier not identified)';
    case 'size': return key || '(no size recorded)';
    case 'item': return (row && row.lbl) || `Item ${key}`;
    default: return key;
  }
}

/** One explore query over a window, merged across year databases. */
async function exploreWindow(by, filter, from, to, exclude) {
  const dim = DIMS[by];
  const params = {};
  for (const [d, v] of Object.entries(filter)) params[`f_${d}`] = String(v);
  exclude.forEach((x, k) => { params[`x${k}a`] = x.from.replace(/-/g, ''); params[`x${k}b`] = x.to.replace(/-/g, ''); });
  const rows = await db.queryRange(from, to, exploreSql(by, filter, exclude.length), params, { ttlMs: 60000 });
  const out = new Map();
  for (const r of rows) {
    let key = r.k === null || r.k === undefined ? '' : String(r.k).trim();
    if (dim.time) key = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
    const e = out.get(key) || { key, lbl: null, sub: null, agg: emptyAgg() };
    e.lbl = e.lbl || r.lbl; e.sub = e.sub || r.sub;
    addAgg(e.agg, r);
    out.set(key, e);
  }
  return out;
}

/** Re-key day rows into weeks or months; `shift` moves last year's days onto this year's calendar. */
function bucketTime(by, dayRows, shift) {
  const out = new Map();
  for (const [day, e] of dayRows) {
    const key = timeBucket(by, shift ? shift(day) : day);
    const b = out.get(key) || { key, agg: emptyAgg() };
    addAgg(b.agg, e.agg);
    out.set(key, b);
  }
  return out;
}

/**
 * Explore sales and gross profit.
 * @param {object} o  { from, to, by, filter, cmpFrom?, cmpTo?, excludeSeasons?, prevScale? }
 *   cmpFrom/cmpTo default to periods.compareWindow (festival-aware for short windows).
 *   excludeSeasons drops festival-season days from both windows; prevScale then
 *   scales last year to the same number of trading days.
 */
async function explore(o = {}, config = {}) {
  const by = DIMS[o.by] ? o.by : 'category';
  const filter = {};
  for (const [d, v] of Object.entries(o.filter || {})) {
    if (FILTERABLE.includes(d) && d !== by && v !== null && v !== undefined) filter[d] = String(v).slice(0, 100);
  }
  const t = P.today();
  const to = P.isIso(o.to) ? o.to : t;
  const from = P.isIso(o.from) && o.from <= to ? o.from : P.fyStart(to);
  const cmp = P.isIso(o.cmpFrom) && P.isIso(o.cmpTo) && o.cmpFrom <= o.cmpTo
    ? { from: o.cmpFrom, to: o.cmpTo, basis: o.cmpBasis || 'custom', label: P.fmtRange(o.cmpFrom, o.cmpTo) }
    : P.compareWindow(from, to, config);

  const exclude = o.excludeSeasons
    ? [...P.seasonsOverlapping(from, to, config), ...P.seasonsOverlapping(cmp.from, cmp.to, config)]
    : [];
  const [curRaw, prevRaw] = await Promise.all([
    exploreWindow(by, filter, from, to, exclude),
    exploreWindow(by, filter, cmp.from, cmp.to, exclude)
  ]);

  let cur = curRaw, prev = prevRaw;
  if (DIMS[by].time) {
    // Line last year up with this year: calendar comparisons move by a year,
    // festival ones by the festival's own shift. Weeks always move by 52
    // weeks so a Monday sits against a Monday.
    const offset = P.daysBetween(cmp.from, from);
    const shift = by === 'week' ? d => P.addDays(d, 364)
      : cmp.basis === 'calendar' ? d => P.addYears(d, 1)
      : d => P.addDays(d, offset);
    cur = bucketTime(by, curRaw, null);
    prev = bucketTime(by, prevRaw, shift);
  }

  const scale = Number(o.prevScale) > 0 ? Number(o.prevScale) : 1;
  const keys = new Set([...cur.keys(), ...prev.keys()]);
  const totals = { cur: emptyAgg(), prev: emptyAgg() };
  const rows = [];
  for (const key of keys) {
    const c = cur.get(key), p = prev.get(key);
    const ca = finishAgg(c ? c.agg : emptyAgg());
    const pa = finishAgg(p ? addAgg(emptyAgg(), p.agg, scale) : emptyAgg());
    addAgg(totals.cur, ca); addAgg(totals.prev, pa);
    // Gross profit change, split into "sold more or less" and "earned more or less per rupee".
    const m0 = pa.taxable ? pa.gp / pa.taxable : 0;
    const m1 = ca.taxable ? ca.gp / ca.taxable : 0;
    const volumeEffect = pa.taxable ? (ca.taxable - pa.taxable) * m0 : ca.gp;
    const marginEffect = pa.taxable ? ca.taxable * (m1 - m0) : 0;
    const meta = (c || p);
    rows.push({
      key, label: labelFor(by, key, meta), sub: meta.sub || null,
      cur: ca, prev: p ? pa : null,
      d: { revenue: ca.revenue - pa.revenue, gp: ca.gp - pa.gp, volumeEffect, marginEffect }
    });
  }
  const tc = finishAgg(totals.cur), tp = finishAgg(totals.prev);
  for (const r of rows) {
    r.gpShare = tc.gp ? (r.cur.gp / tc.gp) * 100 : 0;
    r.revShare = tc.revenue ? (r.cur.revenue / tc.revenue) * 100 : 0;
  }
  if (DIMS[by].time) rows.sort((a, b) => (a.key < b.key ? -1 : 1));
  else rows.sort((a, b) => b.cur.gp - a.cur.gp);

  const unknown = rows.find(r => r.key === '' && (by === 'supplier' || by === 'size'));
  return {
    by, filter, from, to, label: P.fmtRange(from, to),
    cmp: { ...cmp, label: cmp.label || P.fmtRange(cmp.from, cmp.to) },
    excludedSeasons: exclude.map(x => ({ name: x.name, from: x.from, to: x.to })),
    prevScale: scale,
    totals: { cur: tc, prev: tp },
    rows,
    identifiedPct: unknown && tc.taxable ? 100 - (unknown.cur.taxable / tc.taxable) * 100 : null
  };
}

/** Explore a plain "last N days" window - the shape the coach and older pages use. */
async function exploreLast(days, by) {
  const { from, to } = lastDays(days);
  return explore({ from, to, by, cmpFrom: P.addYears(from, -1), cmpTo: P.addYears(to, -1), cmpBasis: 'calendar' });
}

/* ------------------------------------------------------------- product mix */

async function categoryPerformance(days = 90) {
  const x = await exploreLast(days, 'category');
  return x.rows.filter(r => r.cur.taxable || r.cur.units).map(r => ({
    category: r.key, units: r.cur.units, bills: r.cur.bills,
    revenue: r.cur.revenue, taxable: r.cur.taxable, cogs: r.cur.cogs, discount: r.cur.disc,
    grossProfit: r.cur.gp, marginPct: r.cur.margin,
    zeroCostPct: r.cur.zeroCostPct
  })).sort((a, b) => b.revenue - a.revenue);
}

async function topItems(days = 90, limit = 40) {
  const x = await exploreLast(days, 'item');
  const top = x.rows.filter(r => r.cur.units > 0).sort((a, b) => b.cur.revenue - a.cur.revenue).slice(0, limit);
  const stock = await db.query(`SELECT itemid, CAST(Qty AS numeric(18,2)) AS q FROM {{ADMIN}}.itemStock`, {}, { ttlMs: 120000 });
  const onHand = new Map(stock.map(s => [String(s.itemid), n(s.q)]));
  return top.map(r => ({
    itemid: r.key, name: r.label || '(unknown)', category: r.sub || '-',
    units: r.cur.units, revenue: r.cur.revenue, taxable: r.cur.taxable, cogs: r.cur.cogs,
    grossProfit: r.cur.gp, marginPct: r.cur.margin,
    onHand: onHand.get(r.key) || 0
  }));
}

/* -------------------------------------------------------------------- stock */

/** Open tags bucketed by how long they have been sitting. The dead-stock view. */
async function stockAgeing() {
  const rows = await db.query(`
    WITH bal AS (
      SELECT t.itemid, t.Tagno,
             MIN(CASE WHEN t.Issrec='R' THEN t.Trandate END) AS recd,
             SUM(CASE WHEN t.Issrec='R' THEN t.qty ELSE -t.qty END) AS q,
             MAX(ISNULL(NULLIF(t.CostRate,0), t.Purrate)) AS cost
      FROM {{YEAR}}.ItemTag t
      WHERE ISNULL(t.cancel,'') <> 'Y'
      GROUP BY t.itemid, t.Tagno)
    SELECT band, COUNT(*) AS tags,
           CAST(SUM(q) AS numeric(18,2)) AS qty,
           CAST(SUM(q * ISNULL(cost,0)) AS numeric(18,2)) AS cost_value
    FROM (
      SELECT q, cost,
        CASE WHEN recd IS NULL THEN 'Opening (undated)'
             WHEN DATEDIFF(day, recd, GETDATE()) > 730 THEN 'Over 2 years'
             WHEN DATEDIFF(day, recd, GETDATE()) > 365 THEN '1 to 2 years'
             WHEN DATEDIFF(day, recd, GETDATE()) > 180 THEN '6 to 12 months'
             WHEN DATEDIFF(day, recd, GETDATE()) >  90 THEN '3 to 6 months'
             ELSE 'Under 3 months' END AS band
      FROM bal WHERE q > 0) x
    GROUP BY band`, {}, { ttlMs: 300000 });
  const order = ['Under 3 months', '3 to 6 months', '6 to 12 months', '1 to 2 years', 'Over 2 years', 'Opening (undated)'];
  const bands = rows
    .map(r => ({ band: r.band, tags: n(r.tags), qty: n(r.qty), costValue: n(r.cost_value) }))
    .sort((a, b) => order.indexOf(a.band) - order.indexOf(b.band));

  // Ageing is measured per lot (tag), which is the right basis for "what is
  // sitting". Net stock value nets oversold lots off, so the two totals differ.
  // Surface the gap rather than hiding it - it is a real data-quality signal.
  const oversold = await db.query(`
    WITH bal AS (
      SELECT t.itemid, t.Tagno,
             SUM(CASE WHEN t.Issrec='R' THEN t.qty ELSE -t.qty END) AS q,
             MAX(ISNULL(NULLIF(t.CostRate,0), t.Purrate)) AS cost
      FROM {{YEAR}}.ItemTag t WHERE ISNULL(t.cancel,'') <> 'Y'
      GROUP BY t.itemid, t.Tagno)
    SELECT COUNT(*) AS tags, CAST(SUM(q) AS numeric(18,2)) AS qty,
           CAST(SUM(q * ISNULL(cost,0)) AS numeric(18,2)) AS cost_value
    FROM bal WHERE q < 0`, {}, { ttlMs: 300000 });
  const o = oversold[0] || {};
  return {
    bands,
    positiveCostValue: bands.reduce((a, b) => a + b.costValue, 0),
    oversoldTags: n(o.tags),
    oversoldQty: n(o.qty),
    oversoldCostValue: n(o.cost_value)
  };
}

/** Specific items to clear: sitting long, still in stock, not selling. */
async function deadStock(minDays = 365, limit = 60) {
  const rows = await db.query(`
    WITH bal AS (
      SELECT t.itemid,
             SUM(CASE WHEN t.Issrec='R' THEN t.qty ELSE -t.qty END) AS q,
             MAX(CASE WHEN t.Issrec='R' THEN t.Trandate END) AS last_in,
             MAX(ISNULL(NULLIF(t.CostRate,0), t.Purrate)) AS cost
      FROM {{YEAR}}.ItemTag t WHERE ISNULL(t.cancel,'') <> 'Y'
      GROUP BY t.itemid),
    lastsale AS (
      SELECT itemid, MAX(Trandate) AS last_out
      FROM {{YEAR}}.ItemTag WHERE billtype='SA' AND ISNULL(cancel,'') <> 'Y'
      GROUP BY itemid)
    SELECT TOP (@lim)
           b.itemid, i.ITEMNAME AS name, c.CATNAME AS category,
           CAST(b.q AS numeric(18,2)) AS qty,
           CAST(b.q * ISNULL(b.cost,0) AS numeric(18,2)) AS cost_value,
           CAST(b.q * ISNULL(i.SELRATE,0) AS numeric(18,2)) AS retail_value,
           b.last_in, ls.last_out,
           DATEDIFF(day, ISNULL(ls.last_out, b.last_in), GETDATE()) AS idle_days,
           i.SELRATE AS selrate, ISNULL(b.cost,0) AS cost
    FROM bal b
    JOIN {{ADMIN}}.itemmast i ON i.ITEMID = b.itemid
    LEFT JOIN {{ADMIN}}.catmast c ON c.CATID = i.CATID
    LEFT JOIN lastsale ls ON ls.itemid = b.itemid
    WHERE b.q > 0
      AND DATEDIFF(day, ISNULL(ls.last_out, b.last_in), GETDATE()) >= @minDays
    ORDER BY (b.q * ISNULL(b.cost,0)) DESC`, { minDays, lim: limit }, { ttlMs: 300000 });
  return rows.map(r => ({
    itemid: r.itemid, name: r.name, category: r.category || '-',
    qty: n(r.qty), costValue: n(r.cost_value), retailValue: n(r.retail_value),
    idleDays: n(r.idle_days), lastOut: r.last_out ? iso(r.last_out) : null,
    selRate: n(r.selrate), cost: n(r.cost)
  }));
}

/** Fast movers with thin cover - the restock-now list. */
async function fastMovers(days = 60, limit = 40) {
  const { from, to } = lastDays(days);
  // What sold comes from every year the window touches; what is on hand
  // comes from the stock cache, which is never split by year.
  const soldRows = await db.queryRange(from, to, `
    SELECT s.ITEMID AS itemid, SUM(s.QTY) AS qty, CAST(SUM(s.AMOUNT) AS numeric(18,2)) AS revenue
    FROM {{YEAR}}.sales s
    WHERE ISNULL(s.Cancel,'') <> 'Y' AND s.BILLDATE >= @from AND s.BILLDATE <= @to
    GROUP BY s.ITEMID`, {}, { ttlMs: 300000 });
  const sold = new Map();
  for (const r of soldRows) {
    const k = String(r.itemid);
    const e = sold.get(k) || { qty: 0, revenue: 0 };
    e.qty += n(r.qty); e.revenue += n(r.revenue);
    sold.set(k, e);
  }
  const items = await db.query(`
    SELECT i.ITEMID AS itemid, i.ITEMNAME AS name, c.CATNAME AS category,
           CAST(ISNULL(st.Qty,0) AS numeric(18,2)) AS onhand,
           i.PURRATE AS purrate, i.SELRATE AS selrate
    FROM {{ADMIN}}.itemmast i
    LEFT JOIN {{ADMIN}}.catmast c ON c.CATID = i.CATID
    LEFT JOIN {{ADMIN}}.itemStock st ON st.itemid = i.ITEMID
    WHERE ISNULL(i.ACTIVE,'') = 'Y'`, {}, { ttlMs: 300000 });
  const rows = items
    .map(i => ({ ...i, s: sold.get(String(i.itemid)) }))
    .filter(i => i.s && i.s.qty > 0 && n(i.onhand) / (i.s.qty / days) < 21)
    .sort((a, b) => b.s.revenue - a.s.revenue)
    .slice(0, limit)
    .map(i => ({ ...i, sold_qty: i.s.qty, revenue: i.s.revenue, per_day: i.s.qty / days }));
  return rows.map(r => {
    const onHand = n(r.onhand);
    const perDay = n(r.per_day);
    // Negative on-hand means the item has been oversold - stock was never
    // entered. Cover is zero, not negative, and it is the more urgent case.
    const oversold = onHand < 0;
    return {
      itemid: r.itemid, name: r.name, category: r.category || '-',
      soldQty: n(r.sold_qty), revenue: n(r.revenue), onHand,
      perDay,
      coverDays: onHand <= 0 ? 0 : (perDay ? onHand / perDay : null),
      oversold,
      purRate: n(r.purrate), selRate: n(r.selrate)
    };
  });
}

async function stockSummary() {
  const rows = await db.query(`
    WITH bal AS (
      SELECT t.itemid,
             SUM(CASE WHEN t.Issrec='R' THEN t.qty ELSE -t.qty END) AS q,
             SUM(CASE WHEN t.Issrec='R' THEN  t.qty*ISNULL(NULLIF(t.CostRate,0),t.Purrate)
                                        ELSE -t.qty*ISNULL(NULLIF(t.CostRate,0),t.Purrate) END) AS val
      FROM {{YEAR}}.ItemTag t WHERE ISNULL(t.cancel,'') <> 'Y'
      GROUP BY t.itemid)
    SELECT COUNT(*) AS items,
           CAST(SUM(b.q) AS numeric(18,2)) AS qty,
           CAST(SUM(b.val) AS numeric(18,2)) AS cost_value,
           CAST(SUM(b.q * ISNULL(i.SELRATE,0)) AS numeric(18,2)) AS retail_value
    FROM bal b JOIN {{ADMIN}}.itemmast i ON i.ITEMID = b.itemid
    WHERE b.q > 0`, {}, { ttlMs: 300000 });
  const r = rows[0] || {};
  return { items: n(r.items), qty: n(r.qty), costValue: n(r.cost_value), retailValue: n(r.retail_value) };
}

/* ---------------------------------------------------------------- suppliers */

/** Payables by supplier with ageing. `outstanding` is cumulative - never date-filter it. */
async function payables() {
  const rows = await db.query(`
    SELECT o.ACCODE AS accode, a.NAME AS name, a.MOBILE AS mobile,
           CAST(SUM(CASE WHEN o.TRANTYPE='D' THEN o.AMOUNT ELSE -o.AMOUNT END) AS numeric(18,2)) AS balance,
           MAX(o.BILLDATE) AS last_movement,
           MIN(CASE WHEN o.TRANTYPE='D' THEN o.BILLDATE END) AS oldest_bill,
           COUNT(*) AS entries
    FROM {{YEAR}}.outstanding o
    LEFT JOIN {{ADMIN}}.ACCMAST a ON a.accode = o.ACCODE
    WHERE ISNULL(o.Cancel,'') <> 'Y' AND o.billtype = 'PU'
    GROUP BY o.ACCODE, a.NAME, a.MOBILE
    HAVING SUM(CASE WHEN o.TRANTYPE='D' THEN o.AMOUNT ELSE -o.AMOUNT END) > 0.01
    ORDER BY balance DESC`, {}, { ttlMs: 300000 });
  return rows.map(r => ({
    accode: r.accode, name: r.name || r.accode, mobile: r.mobile || '',
    balance: n(r.balance),
    lastMovement: r.last_movement ? iso(r.last_movement) : null,
    oldestBill: r.oldest_bill ? iso(r.oldest_bill) : null,
    daysSincePayment: r.last_movement
      ? Math.round((Date.now() - new Date(r.last_movement).getTime()) / 86400000) : null,
    entries: n(r.entries)
  }));
}

async function receivables() {
  const rows = await db.query(`
    SELECT o.ACCODE AS accode, a.NAME AS name, a.MOBILE AS mobile,
           CAST(SUM(CASE WHEN o.TRANTYPE='D' THEN o.AMOUNT ELSE -o.AMOUNT END) AS numeric(18,2)) AS balance,
           MAX(o.BILLDATE) AS last_movement
    FROM {{YEAR}}.outstanding o
    LEFT JOIN {{ADMIN}}.ACCMAST a ON a.accode = o.ACCODE
    WHERE ISNULL(o.Cancel,'') <> 'Y' AND o.billtype = 'CR'
    GROUP BY o.ACCODE, a.NAME, a.MOBILE
    HAVING SUM(CASE WHEN o.TRANTYPE='D' THEN o.AMOUNT ELSE -o.AMOUNT END) > 0.01
    ORDER BY balance DESC`, {}, { ttlMs: 300000 });
  return rows.map(r => ({
    accode: r.accode, name: r.name || r.accode, mobile: r.mobile || '',
    balance: n(r.balance),
    lastMovement: r.last_movement ? iso(r.last_movement) : null,
    daysSince: r.last_movement
      ? Math.round((Date.now() - new Date(r.last_movement).getTime()) / 86400000) : null
  }));
}

/**
 * Supplier scorecard: what we bought, what it earned, and how much is still
 * sitting. Supplier resolves through the tag's purchase row (~88% coverage).
 */
async function supplierScorecard(days = 365) {
  const { from, to } = lastDays(days);
  // Purchases and sales are each read from every year the window touches.
  // Sales resolve their supplier through the tag in the same year database.
  // A purchase whose challan date falls before 1 April but was entered after
  // it is missed - a handful of invoices at the rollover at most.
  const [boughtRows, soldRows] = await Promise.all([
    db.queryRange(from, to, `
      SELECT ip.Supplier AS accode,
             CAST(SUM(ip.Qty) AS numeric(18,2)) AS qty,
             CAST(SUM(ip.Amount) AS numeric(18,2)) AS amount,
             COUNT(DISTINCT ip.entrefno) AS invoices,
             MAX(ip.Dcdate) AS last_purchase
      FROM {{YEAR}}.itemPurch ip
      WHERE ISNULL(ip.cancel,'') <> 'Y' AND ip.Dcdate >= @from AND ip.Dcdate <= @to
        AND ISNULL(ip.Supplier,'') <> ''
      GROUP BY ip.Supplier`, {}, { ttlMs: 600000 }),
    db.queryRange(from, to, `
      SELECT pu.Supplier AS accode,
             CAST(SUM(s.TAXABLE + ISNULL(s.CGSTVal,0) + ISNULL(s.SGSTVal,0) + ISNULL(s.IGSTVal,0)) AS numeric(18,2)) AS revenue,
             CAST(SUM(s.TAXABLE) AS numeric(18,2)) AS taxable,
             CAST(SUM(s.QTY * ISNULL(NULLIF(s.CostRate,0), s.PurRate)) AS numeric(18,2)) AS cogs
      FROM {{YEAR}}.sales s
      CROSS APPLY (SELECT TOP 1 t.Supplier FROM {{YEAR}}.ItemTag t
                   WHERE t.Tagno = s.TagNo AND t.itemid = s.ITEMID
                     AND t.billtype = 'PU' AND ISNULL(t.Supplier,'') <> '') pu
      WHERE ISNULL(s.Cancel,'') <> 'Y' AND s.BILLDATE >= @from AND s.BILLDATE <= @to
      GROUP BY pu.Supplier`, {}, { ttlMs: 600000 })
  ]);
  const by = new Map();
  const slot = k => by.get(k) || { accode: k, qty: 0, amount: 0, invoices: 0, last: null, revenue: 0, taxable: 0, cogs: 0 };
  for (const r of boughtRows) {
    const e = slot(r.accode);
    e.qty += n(r.qty); e.amount += n(r.amount); e.invoices += n(r.invoices);
    e.last = maxIso(e.last, r.last_purchase ? iso(r.last_purchase) : null);
    by.set(r.accode, e);
  }
  for (const r of soldRows) {
    if (!by.has(r.accode)) continue;   // scorecard covers suppliers bought from in the window
    const e = by.get(r.accode);
    e.revenue += n(r.revenue); e.taxable += n(r.taxable); e.cogs += n(r.cogs);
  }
  const names = await db.query(`SELECT accode, NAME AS name FROM {{ADMIN}}.ACCMAST`, {}, { ttlMs: 600000 });
  const nameOf = new Map(names.map(a => [a.accode, a.name]));
  return [...by.values()].sort((a, b) => b.amount - a.amount).map(e => {
    const taxable = e.taxable, cogs = e.cogs, bought = e.amount;
    return {
      accode: e.accode, name: nameOf.get(e.accode) || e.accode,
      purchaseQty: e.qty, purchaseValue: bought, invoices: e.invoices,
      lastPurchase: e.last,
      revenue: e.revenue, taxable, cogs,
      grossProfit: taxable - cogs,
      marginPct: taxable ? ((taxable - cogs) / taxable) * 100 : 0,
      sellThroughPct: bought ? (cogs / bought) * 100 : 0
    };
  });
}

/* ----------------------------------------------------------------- expenses */

/**
 * Expense postings from the ledger - groups 13/20/26/27 in GROUPMAST.
 * Takes either a number of days back from today, or an explicit from/to.
 */
async function expenses(daysOrFrom = 90, toDate = null) {
  const { from, to } = typeof daysOrFrom === 'string'
    ? { from: daysOrFrom, to: toDate || iso(new Date()) }
    : lastDays(daysOrFrom);
  const rows = await db.queryRange(from, to, `
    SELECT sh.accode, a.NAME AS name, g.GROUPNAME AS grp,
           CAST(SUM(CASE WHEN sh.TRANTYPE='D' THEN sh.amount ELSE -sh.amount END) AS numeric(18,2)) AS amount,
           COUNT(*) AS entries, MAX(sh.BILLDATE) AS last_entry
    FROM {{YEAR}}.saleshead sh
    JOIN {{ADMIN}}.ACCMAST a ON a.accode = sh.accode
    LEFT JOIN {{ADMIN}}.GROUPMAST g ON g.GROUPID = a.GROUPID
    WHERE ${LIVE} AND sh.BILLDATE >= @from AND sh.BILLDATE <= @to
      AND a.GROUPID IN ('13','20','26','27')
    GROUP BY sh.accode, a.NAME, g.GROUPNAME`, {}, { ttlMs: 300000 });
  const by = new Map();
  for (const r of rows) {
    const e = by.get(r.accode) || { accode: r.accode, name: r.name, group: r.grp || '-', amount: 0, entries: 0, lastEntry: null };
    e.amount += n(r.amount); e.entries += n(r.entries);
    e.lastEntry = maxIso(e.lastEntry, r.last_entry ? iso(r.last_entry) : null);
    by.set(r.accode, e);
  }
  return [...by.values()].filter(e => Math.abs(e.amount) > 0.005).sort((a, b) => b.amount - a.amount);
}

/** Days in the window with no expense posting at all - the tracking-gap signal. */
async function expenseCoverage(days = 30) {
  const { from, to } = lastDays(days);
  const rows = await db.queryRange(from, to, `
    SELECT sh.BILLDATE AS d,
           CAST(SUM(CASE WHEN sh.TRANTYPE='D' THEN sh.amount ELSE -sh.amount END) AS numeric(18,2)) AS amount
    FROM {{YEAR}}.saleshead sh
    JOIN {{ADMIN}}.ACCMAST a ON a.accode = sh.accode
    WHERE ${LIVE} AND sh.BILLDATE >= @from AND sh.BILLDATE <= @to AND a.GROUPID IN ('13','20','26','27')
    GROUP BY sh.BILLDATE`, {}, { ttlMs: 300000 });
  const have = new Set(rows.map(r => iso(r.d)));
  const trading = await db.queryRange(from, to, `
    SELECT DISTINCT sh.BILLDATE AS d FROM {{YEAR}}.saleshead sh
    WHERE ${LIVE} AND sh.BILLDATE >= @from AND sh.BILLDATE <= @to AND sh.PAYMENTMODE='S'`, {}, { ttlMs: 300000 });
  const tradingDays = trading.map(r => iso(r.d));
  const missing = tradingDays.filter(d => !have.has(d));
  return { tradingDays: tradingDays.length, daysWithExpense: have.size, missingDays: missing.sort().reverse() };
}

/* ------------------------------------------------------------- data health */

async function dataHealth() {
  const [ledger, cache, negStock, dupes, purchLink] = await Promise.all([
    db.query(`
      SELECT COUNT(*) AS bad_days FROM (
        SELECT sh.BILLDATE FROM {{YEAR}}.saleshead sh WHERE ${LIVE}
        GROUP BY sh.BILLDATE
        HAVING ABS(SUM(CASE WHEN sh.TRANTYPE='D' THEN sh.amount ELSE -sh.amount END)) > 0.005) x`,
      {}, { ttlMs: 300000 }),
    db.query(`
      WITH bal AS (SELECT itemid, SUM(CASE WHEN Issrec='R' THEN qty ELSE -qty END) AS q
                   FROM {{YEAR}}.ItemTag WHERE ISNULL(cancel,'') <> 'Y' GROUP BY itemid)
      SELECT COUNT(*) AS drift FROM {{ADMIN}}.itemStock s
      FULL OUTER JOIN bal b ON b.itemid = s.itemid
      WHERE ABS(ISNULL(s.Qty,0) - ISNULL(b.q,0)) > 0.005`, {}, { ttlMs: 300000 }),
    db.query(`SELECT COUNT(*) AS c, CAST(SUM(Qty) AS numeric(18,2)) AS q
              FROM {{ADMIN}}.itemStock WHERE Qty < 0`, {}, { ttlMs: 300000 }),
    db.query(`
      SELECT COUNT(*) AS c FROM (
        SELECT ENTREFNO FROM {{YEAR}}.SalesEntry WHERE ISNULL(Cancel,'') <> 'Y'
        GROUP BY ENTREFNO HAVING COUNT(*) > 1) x`, {}, { ttlMs: 300000 }),
    db.query(`
      SELECT COUNT(*) AS c FROM {{YEAR}}.itemPurch ip
      WHERE ISNULL(ip.cancel,'') <> 'Y'
        AND ABS(ip.Qty - ISNULL((SELECT SUM(t.qty) FROM {{YEAR}}.ItemTag t
              WHERE t.BatchNo = ip.Batchno AND t.billtype='PU'),0)) > 0.001`, {}, { ttlMs: 300000 })
  ]);
  return {
    ledgerUnbalancedDays: n(ledger[0]?.bad_days),
    stockCacheDrift: n(cache[0]?.drift),
    negativeStockItems: n(negStock[0]?.c),
    negativeStockQty: n(negStock[0]?.q),
    duplicateBills: n(dupes[0]?.c),
    purchaseStockMismatches: n(purchLink[0]?.c)
  };
}

/** How often a customer is attached to a bill - the growth blocker. */
async function customerCapture(days = 30) {
  const { from, to } = lastDays(days);
  const rows = await db.queryRange(from, to, `
    SELECT COUNT(*) AS bills,
           SUM(CASE WHEN ISNULL(Accode,'') <> '' THEN 1 ELSE 0 END) AS with_customer
    FROM {{YEAR}}.SalesEntry
    WHERE ISNULL(Cancel,'') <> 'Y' AND BILLDATE >= @from AND BILLDATE <= @to`, {}, { ttlMs: 300000 });
  const bills = rows.reduce((a, r) => a + n(r.bills), 0);
  const withC = rows.reduce((a, r) => a + n(r.with_customer), 0);
  return { bills, withCustomer: withC, pct: bills ? (withC / bills) * 100 : 0 };
}

/* --------------------------------------------------------------- discounts */

async function discountLeakage(days = 90) {
  const x = await exploreLast(days, 'category');
  return x.rows.filter(r => r.cur.disc > 0).map(r => ({
    category: r.key, discount: r.cur.disc, revenue: r.cur.revenue,
    units: r.cur.units, discountedUnits: r.cur.discLines,
    discountPct: r.cur.discRate
  })).sort((a, b) => b.discount - a.discount);
}

/* ------------------------------------------------------------------ growth */

/*
 * The Growth page in one call. Everything is year on year, read from a single
 * day-by-day fact table that spans this year, last year and the year before,
 * so every window below is a slice of the same numbers.
 */

/** Ledger takings and line-level pieces/cost per day, keyed by date. */
async function dailyFacts(from, to) {
  const [s, c] = await Promise.all([dailySeries(from, to), dailyCogs(from, to)]);
  const m = new Map();
  const blank = date => ({ date, revenue: 0, bills: 0, discount: 0, units: 0, taxable: 0, cogs: 0 });
  for (const d of s) m.set(d.date, { ...blank(d.date), revenue: d.revenue, bills: d.bills, discount: d.discount });
  for (const d of c) {
    const e = m.get(d.date) || blank(d.date);
    e.units = d.units; e.taxable = d.taxable; e.cogs = d.cogs;
    m.set(d.date, e);
  }
  return m;
}

/** Totals over [from,to]; `skip(date)` leaves days out (festival seasons). */
function sumDays(facts, from, to, skip = null) {
  const a = { from, to, revenue: 0, bills: 0, discount: 0, units: 0, taxable: 0, cogs: 0, days: 0 };
  for (const [date, e] of facts) {
    if (date < from || date > to || (skip && skip(date))) continue;
    a.revenue += e.revenue; a.bills += e.bills; a.discount += e.discount;
    a.units += e.units; a.taxable += e.taxable; a.cogs += e.cogs;
    if (e.revenue > 0) a.days++;
  }
  return derive(a);
}
function derive(a) {
  const gp = a.taxable - a.cogs;
  return {
    ...a, gp,
    margin: a.taxable ? (gp / a.taxable) * 100 : 0,
    abv: a.bills ? a.revenue / a.bills : 0,
    upb: a.bills ? a.units / a.bills : 0,
    ppu: a.units ? a.revenue / a.units : 0,
    perDay: a.days ? a.revenue / a.days : 0,
    billsPerDay: a.days ? a.bills / a.days : 0,
    discRate: a.revenue + a.discount ? (a.discount / (a.revenue + a.discount)) * 100 : 0
  };
}
/** Scale additive figures, e.g. last year's pace over this year's number of trading days. */
function scaleSum(a, k) {
  const keys = ['revenue', 'bills', 'discount', 'units', 'taxable', 'cogs'];
  const out = { ...a };
  for (const key of keys) out[key] = a[key] * k;
  out.days = a.days * k;
  return derive(out);
}
const pctChange = (a, b) => (b ? ((a - b) / Math.abs(b)) * 100 : null);

/**
 * Revenue = bills x pieces per bill x price per piece. Each lever's rupee
 * effect is taken in turn, so the three add up exactly to the change.
 */
function decompose(cur, prev) {
  const B0 = prev.bills, U0 = prev.upb, P0 = prev.ppu;
  const B1 = cur.bills, U1 = cur.upb, P1 = cur.ppu;
  return {
    change: cur.revenue - prev.revenue,
    bills:  { now: cur.bills, was: prev.bills, pct: pctChange(B1, B0), effect: (B1 - B0) * U0 * P0 },
    pieces: { now: U1, was: U0, pct: pctChange(U1, U0), effect: B1 * (U1 - U0) * P0 },
    price:  { now: P1, was: P0, pct: pctChange(P1, P0), effect: B1 * U1 * (P1 - P0) }
  };
}

async function growthSummary(config = {}) {
  const t = P.today();
  const yday = P.addDays(t, -1);
  const fy = P.fyStart(t);
  const curTo = fy > yday ? t : yday;                 // 1 April: today is all there is
  const facts = await dailyFacts(P.addDays(P.addYears(fy, -2), -60), curTo);
  const inSeason = P.seasonLookup(config);

  /* 1. this year so far against the same dates last year */
  const cur = sumDays(facts, fy, curTo);
  const ly = sumDays(facts, P.addYears(fy, -1), P.addYears(curTo, -1));
  const ly2 = sumDays(facts, P.addYears(fy, -2), P.addYears(curTo, -2));
  const gaps = P.seasonGap({ from: fy, to: curTo }, { from: ly.from, to: ly.to }, config);

  // When a festival season sits inside one window and not the other, the
  // honest comparison leaves every season day out of both and compares the
  // ordinary days, last year scaled to this year's number of trading days.
  const curU = sumDays(facts, fy, curTo, inSeason);
  const lyURaw = sumDays(facts, ly.from, ly.to, inSeason);
  const lyU = lyURaw.days ? scaleSum(lyURaw, curU.days / lyURaw.days) : lyURaw;
  const ly2U = sumDays(facts, ly2.from, ly2.to, inSeason);
  const basis = gaps.length && curU.days >= 20 ? 'underlying' : 'calendar';
  const head = basis === 'underlying' ? { cur: curU, prev: lyU } : { cur, prev: ly };
  // Last year's growth on the same basis, so "has it slowed?" compares like with like.
  const headPrevPct = basis === 'underlying' ? pctChange(lyURaw.perDay, ly2U.perDay) : pctChange(ly.revenue, ly2.revenue);

  /* 2. the last 30 days, read three ways */
  const l30 = { from: P.addDays(curTo, -29), to: curTo };
  const fest = P.compareWindow(l30.from, l30.to, config);
  const last30 = {
    cur: sumDays(facts, l30.from, l30.to),
    prev30: sumDays(facts, P.addDays(l30.from, -30), P.addDays(l30.from, -1)),
    lastYear: sumDays(facts, P.addYears(l30.from, -1), P.addYears(l30.to, -1)),
    aligned: fest.basis === 'festival' ? sumDays(facts, fest.from, fest.to) : null,
    alignedNote: fest.basis === 'festival' ? fest.note : null
  };

  /* 3. the festival ahead, or the one in progress */
  let season = null;
  const next = P.upcoming(config, 75);
  if (next) {
    const s = P.seasonOf(next);
    const prevOcc = P.previousOccurrence(next, config);
    season = { name: next.name, date: next.date, daysToGo: P.daysBetween(t, next.date), from: s.from, inProgress: s.from <= curTo };
    if (prevOcc) {
      const ps = P.seasonOf(prevOcc);
      const before = { from: P.addDays(ps.from, -30), to: P.addDays(ps.from, -1) };
      season.lastYear = {
        date: prevOcc.date, from: ps.from, to: ps.to,
        total: sumDays(facts, ps.from, ps.to),
        before: sumDays(facts, before.from, before.to),
        presetId: `season:${prevOcc.name}:${prevOcc.date}`
      };
      if (season.inProgress) {
        const into = P.daysBetween(s.from, curTo);
        season.soFar = {
          cur: sumDays(facts, s.from, curTo),
          prev: sumDays(facts, ps.from, P.addDays(ps.from, into))
        };
      }
    }
  }

  /* 4. who grew and who shrank - on the same basis as the headline */
  const curDaysU = curU.days, prevDaysU = lyURaw.days;
  const cats = await explore({
    by: 'category', from: fy, to: curTo,
    cmpFrom: ly.from, cmpTo: ly.to, cmpBasis: 'calendar',
    excludeSeasons: basis === 'underlying',
    prevScale: basis === 'underlying' && prevDaysU ? curDaysU / prevDaysU : 1
  }, config);

  /* 5. month by month against the same dates last year */
  const months = [];
  for (let m = fy; m <= curTo; m = P.addDays(`${m.slice(0, 7)}-01`, 32).slice(0, 7) + '-01') {
    const mEnd = P.addDays(`${P.addDays(`${m.slice(0, 7)}-01`, 32).slice(0, 7)}-01`, -1);
    const to = mEnd < curTo ? mEnd : curTo;
    const a = sumDays(facts, m, to);
    const b = sumDays(facts, P.addYears(m, -1), P.addYears(to, -1));
    const fNow = P.festivals(config).filter(f => f.date >= m && f.date <= mEnd).map(f => f.name);
    const fThen = P.festivals(config).filter(f => f.date >= P.addYears(m, -1) && f.date <= P.addYears(mEnd, -1)).map(f => f.name);
    months.push({
      month: m.slice(0, 7), label: `${P.MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`,
      partial: to < mEnd, cur: a, prev: b, pct: pctChange(a.revenue, b.revenue),
      festivalsNow: fNow.filter(x => !fThen.includes(x)),
      festivalsThen: fThen.filter(x => !fNow.includes(x))
    });
  }

  /* 6. daily, last 90 days, against the same weekday 52 weeks earlier */
  const daily = [];
  for (let d = P.addDays(curTo, -89); d <= curTo; d = P.addDays(d, 1)) {
    const a = facts.get(d), b = facts.get(P.addDays(d, -364));
    daily.push({ date: d, cur: a ? a.revenue : 0, prev: b ? b.revenue : 0, season: inSeason(d) });
  }

  return {
    asOf: curTo, fyLabel: P.fyLabel(t), fyFrom: fy,
    basis, seasonGaps: gaps, gapNote: P.gapNote(gaps),
    fytd: {
      cur, prev: ly, prev2: ly2,
      pct: pctChange(cur.revenue, ly.revenue),
      prevPct: pctChange(ly.revenue, ly2.revenue),
      gpPct: pctChange(cur.gp, ly.gp)
    },
    underlying: { cur: curU, prev: lyU, prevDays: prevDaysU, pct: pctChange(curU.revenue, lyU.revenue) },
    headline: {
      ...head,
      pct: pctChange(head.cur.revenue, head.prev.revenue),
      gpPct: pctChange(head.cur.gp, head.prev.gp),
      prevPct: headPrevPct
    },
    levers: decompose(head.cur, head.prev),
    last30, season,
    categories: cats.rows.map(r => ({
      key: r.key, label: r.label, cur: r.cur.revenue, prev: r.prev ? r.prev.revenue : 0,
      gpNow: r.cur.gp, gpWas: r.prev ? r.prev.gp : 0, marginNow: r.cur.margin, marginWas: r.prev ? r.prev.margin : 0,
      // Zero-cost opening stock fakes margin moves; callers skip rows where it is material.
      zeroCostNow: r.cur.zeroCostPct, zeroCostWas: r.prev ? r.prev.zeroCostPct : 0,
      d: r.d
    })),
    months, daily
  };
}

module.exports = {
  dailySeries, dailyCogs, today, hourlyToday, hourlyProfile,
  weekdayProfile, monthlyAllYears,
  explore, categoryPerformance, topItems,
  stockAgeing, deadStock, fastMovers, stockSummary,
  payables, receivables, supplierScorecard,
  expenses, expenseCoverage,
  dataHealth, customerCapture, discountLeakage,
  growthSummary, dailyFacts,
  iso, daysAgo
};
