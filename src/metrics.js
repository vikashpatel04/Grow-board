/**
 * Grow Board - metrics.
 *
 * Every figure here follows the rules established in D:\DATA\POS-Schema:
 *   - money comes from `saleshead` (the general ledger), never `SalesEntry`
 *   - soft deletes are filtered with ISNULL(Cancel,'') <> 'Y'
 *   - stock is never filtered by date (ItemTag spans all years)
 *   - purchases join to stock on BatchNo, never Tagno or ENTREFNO
 *   - time-of-day comes from sales.UpTime (100% populated)
 *
 * Ledger shorthand used throughout:
 *   PAYMENTMODE 'S' = goods value   (SALE5P credit / SRTE5P debit) - only 2 accounts
 *   PAYMENTMODE 'T' = GST           (filter BILLTYPE to CS/CR to exclude purchase tax)
 *   PAYMENTMODE 'C' = cash, 'H' = bank/card, 'Q' = UPI, 'R' = customer credit
 *   PAYMENTMODE 'D' / 'I' = discount and its contra - NEVER counted as tender
 */
'use strict';

const db = require('./db');

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

/* ------------------------------------------------------------ daily series */

/**
 * Core daily fact table. One row per trading day with the numbers every page
 * needs. This is the single source the rest of the app aggregates from.
 */
async function dailySeries(fromDate, toDate) {
  const rows = await db.query(`
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
    GROUP BY sh.BILLDATE
    ORDER BY sh.BILLDATE`,
    { from: fromDate, to: toDate }, { ttlMs: 30000 });

  return rows.map(r => ({
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
  const rows = await db.query(`
    SELECT s.BILLDATE AS d,
           CAST(SUM(s.QTY * ISNULL(NULLIF(s.CostRate,0), s.PurRate)) AS numeric(18,2)) AS cogs,
           CAST(SUM(s.TAXABLE) AS numeric(18,2)) AS taxable,
           COUNT(*) AS units
    FROM {{YEAR}}.sales s
    WHERE ISNULL(s.Cancel,'') <> 'Y' AND s.BILLDATE >= @from AND s.BILLDATE <= @to
    GROUP BY s.BILLDATE`, { from: fromDate, to: toDate }, { ttlMs: 30000 });
  const back = await db.query(`
    SELECT e.BILLDATE AS d,
           CAST(SUM(e.QTY * ISNULL(NULLIF(e.CostRate,0), e.purrate)) AS numeric(18,2)) AS cogs,
           CAST(SUM(e.TAXABLE) AS numeric(18,2)) AS taxable,
           COUNT(*) AS units
    FROM {{YEAR}}.exchange e
    WHERE ISNULL(e.Cancel,'') <> 'Y' AND e.BILLDATE >= @from AND e.BILLDATE <= @to
    GROUP BY e.BILLDATE`, { from: fromDate, to: toDate }, { ttlMs: 30000 });

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

/** The shop's typical hourly shape, used to pace the day and to staff it. */
async function hourlyProfile(weekdayOnly = null) {
  const wd = weekdayOnly === null ? -1 : weekdayOnly;
  const rows = await db.query(`
    SELECT DATEPART(hour, s.UpTime) AS hr,
           CAST(SUM(s.AMOUNT) AS numeric(18,2)) AS amt,
           COUNT(DISTINCT s.BILLDATE) AS days,
           COUNT(DISTINCT s.ENTREFNO) AS bills
    FROM {{YEAR}}.sales s
    WHERE ISNULL(s.Cancel,'') <> 'Y' AND s.UpTime IS NOT NULL
      AND (@wd = -1 OR (DATEDIFF(day, '19700104', s.BILLDATE) % 7) = @wd)
    GROUP BY DATEPART(hour, s.UpTime) ORDER BY hr`, { wd }, { ttlMs: 600000 });
  return rows.map(r => ({
    hour: n(r.hr),
    avgAmount: n(r.days) ? n(r.amt) / n(r.days) : 0,
    bills: n(r.bills), days: n(r.days)
  }));
}

/* -------------------------------------------------------------- performance */

async function weekdayProfile() {
  const rows = await db.query(`
    SELECT (DATEDIFF(day, '19700104', sh.BILLDATE) % 7) AS wd,
           CAST(${NET_GOODS} + ${NET_GST} AS numeric(18,2)) AS revenue,
           COUNT(DISTINCT sh.BILLDATE) AS days
    FROM {{YEAR}}.saleshead sh
    WHERE ${LIVE}
    GROUP BY (DATEDIFF(day, '19700104', sh.BILLDATE) % 7) ORDER BY wd`, {}, { ttlMs: 600000 });
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return rows.map(r => ({
    weekday: n(r.wd), name: names[n(r.wd)] || '?',
    avgRevenue: n(r.days) ? n(r.revenue) / n(r.days) : 0,
    days: n(r.days)
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

/* ------------------------------------------------------------- product mix */

async function categoryPerformance(days = 90) {
  const from = iso(daysAgo(days));
  const rows = await db.query(`
    SELECT ISNULL(c.CATNAME,'(uncategorised)') AS category,
           COUNT(*) AS units,
           COUNT(DISTINCT s.ENTREFNO) AS bills,
           CAST(SUM(s.TAXABLE) AS numeric(18,2)) AS taxable,
           CAST(SUM(s.AMOUNT)  AS numeric(18,2)) AS revenue,
           CAST(SUM(s.QTY * ISNULL(NULLIF(s.CostRate,0), s.PurRate)) AS numeric(18,2)) AS cogs,
           CAST(SUM(s.disccash) AS numeric(18,2)) AS discount
    FROM {{YEAR}}.sales s
    LEFT JOIN {{ADMIN}}.itemmast i ON i.ITEMID = s.ITEMID
    LEFT JOIN {{ADMIN}}.catmast  c ON c.CATID  = i.CATID
    WHERE ISNULL(s.Cancel,'') <> 'Y' AND s.BILLDATE >= @from
    GROUP BY c.CATNAME
    ORDER BY revenue DESC`, { from }, { ttlMs: 120000 });
  return rows.map(r => {
    const taxable = n(r.taxable), cogs = n(r.cogs);
    return {
      category: r.category, units: n(r.units), bills: n(r.bills),
      revenue: n(r.revenue), taxable, cogs, discount: n(r.discount),
      grossProfit: taxable - cogs,
      marginPct: taxable ? ((taxable - cogs) / taxable) * 100 : 0
    };
  });
}

async function topItems(days = 90, limit = 40) {
  const from = iso(daysAgo(days));
  const rows = await db.query(`
    SELECT TOP (@lim) s.ITEMID AS itemid, i.ITEMNAME AS name, c.CATNAME AS category,
           COUNT(*) AS units,
           CAST(SUM(s.QTY) AS numeric(18,2)) AS qty,
           CAST(SUM(s.AMOUNT) AS numeric(18,2)) AS revenue,
           CAST(SUM(s.TAXABLE) AS numeric(18,2)) AS taxable,
           CAST(SUM(s.QTY * ISNULL(NULLIF(s.CostRate,0), s.PurRate)) AS numeric(18,2)) AS cogs,
           CAST(ISNULL(st.Qty,0) AS numeric(18,2)) AS onhand
    FROM {{YEAR}}.sales s
    LEFT JOIN {{ADMIN}}.itemmast  i ON i.ITEMID = s.ITEMID
    LEFT JOIN {{ADMIN}}.catmast   c ON c.CATID  = i.CATID
    LEFT JOIN {{ADMIN}}.itemStock st ON st.itemid = s.ITEMID
    WHERE ISNULL(s.Cancel,'') <> 'Y' AND s.BILLDATE >= @from
    GROUP BY s.ITEMID, i.ITEMNAME, c.CATNAME, st.Qty
    ORDER BY revenue DESC`, { from, lim: limit }, { ttlMs: 120000 });
  return rows.map(r => {
    const taxable = n(r.taxable), cogs = n(r.cogs);
    return {
      itemid: r.itemid, name: r.name || '(unknown)', category: r.category || '-',
      units: n(r.units), qty: n(r.qty), revenue: n(r.revenue), taxable, cogs,
      grossProfit: taxable - cogs,
      marginPct: taxable ? ((taxable - cogs) / taxable) * 100 : 0,
      onHand: n(r.onhand)
    };
  });
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
  const from = iso(daysAgo(days));
  const rows = await db.query(`
    WITH sold AS (
      SELECT s.ITEMID, SUM(s.QTY) AS qty, COUNT(*) AS lines_,
             CAST(SUM(s.AMOUNT) AS numeric(18,2)) AS revenue
      FROM {{YEAR}}.sales s
      WHERE ISNULL(s.Cancel,'') <> 'Y' AND s.BILLDATE >= @from
      GROUP BY s.ITEMID)
    SELECT TOP (@lim) sold.ITEMID AS itemid, i.ITEMNAME AS name, c.CATNAME AS category,
           CAST(sold.qty AS numeric(18,2)) AS sold_qty, sold.revenue,
           CAST(ISNULL(st.Qty,0) AS numeric(18,2)) AS onhand,
           CAST(sold.qty / @days AS numeric(18,3)) AS per_day,
           CASE WHEN sold.qty > 0 THEN CAST(ISNULL(st.Qty,0) / (sold.qty / @days) AS numeric(18,1)) ELSE NULL END AS cover_days,
           i.PURRATE AS purrate, i.SELRATE AS selrate
    FROM sold
    JOIN {{ADMIN}}.itemmast i ON i.ITEMID = sold.ITEMID
    LEFT JOIN {{ADMIN}}.catmast c ON c.CATID = i.CATID
    LEFT JOIN {{ADMIN}}.itemStock st ON st.itemid = sold.ITEMID
    WHERE ISNULL(i.ACTIVE,'') = 'Y'
      AND sold.qty > 0
      AND ISNULL(st.Qty,0) / NULLIF(sold.qty / @days, 0) < 21
    ORDER BY sold.revenue DESC`, { from, days, lim: limit }, { ttlMs: 300000 });
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
  const from = iso(daysAgo(days));
  const rows = await db.query(`
    WITH bought AS (
      SELECT ip.Supplier AS accode,
             CAST(SUM(ip.Qty) AS numeric(18,2)) AS qty,
             CAST(SUM(ip.Amount) AS numeric(18,2)) AS amount,
             COUNT(DISTINCT ip.entrefno) AS invoices,
             MAX(ip.Dcdate) AS last_purchase
      FROM {{YEAR}}.itemPurch ip
      WHERE ISNULL(ip.cancel,'') <> 'Y' AND ip.Dcdate >= @from AND ISNULL(ip.Supplier,'') <> ''
      GROUP BY ip.Supplier),
    sold AS (
      SELECT pu.Supplier AS accode,
             CAST(SUM(s.AMOUNT) AS numeric(18,2)) AS revenue,
             CAST(SUM(s.TAXABLE) AS numeric(18,2)) AS taxable,
             CAST(SUM(s.QTY * ISNULL(NULLIF(s.CostRate,0), s.PurRate)) AS numeric(18,2)) AS cogs
      FROM {{YEAR}}.sales s
      CROSS APPLY (SELECT TOP 1 t.Supplier FROM {{YEAR}}.ItemTag t
                   WHERE t.Tagno = s.TagNo AND t.itemid = s.ITEMID
                     AND t.billtype = 'PU' AND ISNULL(t.Supplier,'') <> '') pu
      WHERE ISNULL(s.Cancel,'') <> 'Y' AND s.BILLDATE >= @from
      GROUP BY pu.Supplier)
    SELECT b.accode, a.NAME AS name,
           b.qty, b.amount, b.invoices, b.last_purchase,
           ISNULL(sd.revenue,0) AS revenue, ISNULL(sd.taxable,0) AS taxable, ISNULL(sd.cogs,0) AS cogs
    FROM bought b
    LEFT JOIN sold sd ON sd.accode = b.accode
    LEFT JOIN {{ADMIN}}.ACCMAST a ON a.accode = b.accode
    ORDER BY b.amount DESC`, { from }, { ttlMs: 600000 });
  return rows.map(r => {
    const taxable = n(r.taxable), cogs = n(r.cogs), bought = n(r.amount);
    return {
      accode: r.accode, name: r.name || r.accode,
      purchaseQty: n(r.qty), purchaseValue: bought, invoices: n(r.invoices),
      lastPurchase: r.last_purchase ? iso(r.last_purchase) : null,
      revenue: n(r.revenue), taxable, cogs,
      grossProfit: taxable - cogs,
      marginPct: taxable ? ((taxable - cogs) / taxable) * 100 : 0,
      sellThroughPct: bought ? (cogs / bought) * 100 : 0
    };
  });
}

/* ----------------------------------------------------------------- expenses */

/** Expense postings from the ledger - groups 13/20/26/27 in GROUPMAST. */
async function expenses(days = 90) {
  const from = iso(daysAgo(days));
  const rows = await db.query(`
    SELECT sh.accode, a.NAME AS name, g.GROUPNAME AS grp,
           CAST(SUM(CASE WHEN sh.TRANTYPE='D' THEN sh.amount ELSE -sh.amount END) AS numeric(18,2)) AS amount,
           COUNT(*) AS entries, MAX(sh.BILLDATE) AS last_entry
    FROM {{YEAR}}.saleshead sh
    JOIN {{ADMIN}}.ACCMAST a ON a.accode = sh.accode
    LEFT JOIN {{ADMIN}}.GROUPMAST g ON g.GROUPID = a.GROUPID
    WHERE ${LIVE} AND sh.BILLDATE >= @from
      AND a.GROUPID IN ('13','20','26','27')
    GROUP BY sh.accode, a.NAME, g.GROUPNAME
    HAVING SUM(CASE WHEN sh.TRANTYPE='D' THEN sh.amount ELSE -sh.amount END) <> 0
    ORDER BY amount DESC`, { from }, { ttlMs: 300000 });
  return rows.map(r => ({
    accode: r.accode, name: r.name, group: r.grp || '-',
    amount: n(r.amount), entries: n(r.entries),
    lastEntry: r.last_entry ? iso(r.last_entry) : null
  }));
}

/** Days in the window with no expense posting at all - the tracking-gap signal. */
async function expenseCoverage(days = 30) {
  const from = iso(daysAgo(days));
  const rows = await db.query(`
    SELECT sh.BILLDATE AS d,
           CAST(SUM(CASE WHEN sh.TRANTYPE='D' THEN sh.amount ELSE -sh.amount END) AS numeric(18,2)) AS amount
    FROM {{YEAR}}.saleshead sh
    JOIN {{ADMIN}}.ACCMAST a ON a.accode = sh.accode
    WHERE ${LIVE} AND sh.BILLDATE >= @from AND a.GROUPID IN ('13','20','26','27')
    GROUP BY sh.BILLDATE`, { from }, { ttlMs: 300000 });
  const have = new Set(rows.map(r => iso(r.d)));
  const trading = await db.query(`
    SELECT DISTINCT sh.BILLDATE AS d FROM {{YEAR}}.saleshead sh
    WHERE ${LIVE} AND sh.BILLDATE >= @from AND sh.PAYMENTMODE='S'`, { from }, { ttlMs: 300000 });
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
  const from = iso(daysAgo(days));
  const rows = await db.query(`
    SELECT COUNT(*) AS bills,
           SUM(CASE WHEN ISNULL(Accode,'') <> '' THEN 1 ELSE 0 END) AS with_customer
    FROM {{YEAR}}.SalesEntry
    WHERE ISNULL(Cancel,'') <> 'Y' AND BILLDATE >= @from`, { from }, { ttlMs: 300000 });
  const r = rows[0] || {};
  const bills = n(r.bills), withC = n(r.with_customer);
  return { bills, withCustomer: withC, pct: bills ? (withC / bills) * 100 : 0 };
}

/* --------------------------------------------------------------- discounts */

async function discountLeakage(days = 90) {
  const from = iso(daysAgo(days));
  const rows = await db.query(`
    SELECT ISNULL(c.CATNAME,'(uncategorised)') AS category,
           CAST(SUM(s.disccash) AS numeric(18,2)) AS discount,
           CAST(SUM(s.AMOUNT) AS numeric(18,2)) AS revenue,
           COUNT(*) AS units,
           SUM(CASE WHEN s.disccash > 0 THEN 1 ELSE 0 END) AS discounted_units
    FROM {{YEAR}}.sales s
    LEFT JOIN {{ADMIN}}.itemmast i ON i.ITEMID = s.ITEMID
    LEFT JOIN {{ADMIN}}.catmast  c ON c.CATID  = i.CATID
    WHERE ISNULL(s.Cancel,'') <> 'Y' AND s.BILLDATE >= @from
    GROUP BY c.CATNAME
    HAVING SUM(s.disccash) > 0
    ORDER BY discount DESC`, { from }, { ttlMs: 300000 });
  return rows.map(r => ({
    category: r.category, discount: n(r.discount), revenue: n(r.revenue),
    units: n(r.units), discountedUnits: n(r.discounted_units),
    discountPct: n(r.revenue) ? (n(r.discount) / (n(r.revenue) + n(r.discount))) * 100 : 0
  }));
}

module.exports = {
  dailySeries, dailyCogs, today, hourlyToday, hourlyProfile,
  weekdayProfile, monthlyAllYears,
  categoryPerformance, topItems,
  stockAgeing, deadStock, fastMovers, stockSummary,
  payables, receivables, supplierScorecard,
  expenses, expenseCoverage,
  dataHealth, customerCapture, discountLeakage,
  iso, daysAgo
};
