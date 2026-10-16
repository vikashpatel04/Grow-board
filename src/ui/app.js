/**
 * Grow Board - renderer.
 *
 * House rule for every page: lead with a verdict in plain language, then show
 * the evidence, and put a "so what" line under each chart. A number without an
 * interpretation does not ship.
 */
'use strict';

(function () {

/* Surface any failure on screen. A shop-floor app that silently shows
   "Loading..." forever is worse than one that says what broke. */
function fatal(msg, detail) {
  const host = document.querySelector('.page.active') || document.body;
  host.innerHTML = `<div class="notice bad" style="margin:20px">
    <strong>${msg}</strong><br>
    <span style="font-family:monospace;font-size:12px">${String(detail || '').slice(0, 500)}</span><br><br>
    Use Refresh to try again, or check the Settings page for the database connection.
  </div>`;
}
window.addEventListener('error', e => fatal('Something went wrong in the dashboard.', e.message));
window.addEventListener('unhandledrejection', e =>
  fatal('A data request failed.', e.reason && e.reason.message ? e.reason.message : e.reason));

if (!window.GBCharts) {
  fatal('Chart library did not load.', 'window.GBCharts is undefined - charts.js failed to run.');
  throw new Error('GBCharts missing');
}

const { lineChart, barChart, hbarChart, progressRing, stackBar, sparkline,
        fmtMoney, fmtShort, fmtNum, esc, hideTip } = window.GBCharts;

const S = {
  update: null,
  page: 'today',
  cache: {},
  actions: [],
  config: null,
  refreshTimer: null
};

const $ = id => document.getElementById(id);
const C = {
  s1: 'var(--series-1)', s2: 'var(--series-2)', s3: 'var(--series-3)',
  s4: 'var(--series-4)', s5: 'var(--series-5)', s6: 'var(--series-6)',
  good: 'var(--status-good)', warn: 'var(--status-warning)',
  serious: 'var(--status-serious)', crit: 'var(--status-critical)',
  muted: 'var(--text-muted)'
};

const PAGES = {
  today:     { title: 'Today', sub: 'What is happening right now, and whether you are on track' },
  actions:   { title: 'Focus', sub: 'Ranked by what will move the business most' },
  growth:    { title: 'Growth', sub: 'Year on year, like for like - and which lever is moving it' },
  profit:    { title: 'Profit', sub: 'What you keep, sliced any way you need, against last year' },
  stock:     { title: 'Stock', sub: 'Cash sitting on the shelf, and what to clear or reorder' },
  suppliers: { title: 'Suppliers', sub: 'Who you owe, and which suppliers earn their shelf space' },
  customers: { title: 'Customers', sub: 'Who is buying - and why you cannot yet answer that' },
  health:    { title: 'Data Health', sub: 'Whether the numbers in this app can be trusted' },
  settings:  { title: 'Settings', sub: 'Connection, goal and notification preferences' }
};

/* ------------------------------------------------------------------ utils */

const unwrap = r => (r && r.ok ? r.data : null);
async function get(key, fn, ttl = 60000) {
  const hit = S.cache[key];
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const v = unwrap(await fn());
  S.cache[key] = { at: Date.now(), v };
  return v;
}
/** Like get(), but a failed request throws its own message instead of quietly returning null. */
async function need(key, fn, ttl = 60000) {
  const hit = S.cache[key];
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const r = await fn();
  if (!r || !r.ok) throw new Error((r && r.error) || 'No data came back from the database.');
  S.cache[key] = { at: Date.now(), v: r.data };
  return r.data;
}
function clearCache() { S.cache = {}; }

function deltaTag(cur, prev, invert = false) {
  if (!prev) return '<span class="delta flat">-</span>';
  const d = ((cur - prev) / Math.abs(prev)) * 100;
  const good = invert ? d < 0 : d > 0;
  const cls = Math.abs(d) < 1 ? 'flat' : good ? 'up' : 'down';
  const arrow = Math.abs(d) < 1 ? '' : d > 0 ? '↑' : '↓';
  return `<span class="delta ${cls}">${arrow} ${Math.abs(d).toFixed(0)}%</span>`;
}

const ICON = {
  good: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--status-good)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--status-warning)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9.5 17h-19z"/><path d="M12 9.5v4.5M12 17.2v.1"/></svg>`,
  serious: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--status-serious)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.4v.1"/></svg>`,
  critical: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--status-critical)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.4v.1"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--series-1)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/></svg>`
};
const DO_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

function verdict(state, title, body) {
  return `<div class="verdict ${state}">
    <div class="verdict-icon">${ICON[state] || ICON.info}</div>
    <div class="verdict-body"><h2>${title}</h2><p>${body}</p></div>
  </div>`;
}
function card(title, inner, hint) {
  return `<div class="card">
    <div class="card-head"><h3>${esc(title)}</h3>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>
    ${inner}</div>`;
}
function sowhat(html) { return `<p class="sowhat">${html}</p>`; }
const dayLabel = d => {
  const x = new Date(d + 'T00:00:00');
  return x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
/**
 * Click-to-sort for plain tables (class "sortable"). Money, counts and "45d"
 * style cells sort as numbers; anything else sorts as text. The total row, if
 * any, stays at the bottom.
 */
function cellValue(td) {
  if (td.dataset.v !== undefined) return Number(td.dataset.v);
  const t = td.textContent.replace(/[₹,%\s]/g, '').trim();
  return /^-?\d+(\.\d+)?[a-z]*$/i.test(t) ? parseFloat(t) : td.textContent.trim().toLowerCase();
}
function makeSortable(table) {
  const ths = table.querySelectorAll('thead th');
  ths.forEach((th, i) => {
    th.classList.add('sort');
    th.onclick = () => {
      const dir = th.classList.contains('desc') ? 1 : -1;
      ths.forEach(h => h.classList.remove('asc', 'desc'));
      th.classList.add(dir > 0 ? 'asc' : 'desc');
      const body = table.tBodies[0];
      const rows = [...body.rows].filter(r => !r.classList.contains('total'));
      const totals = [...body.rows].filter(r => r.classList.contains('total'));
      rows.sort((a, b) => {
        const va = cellValue(a.cells[i]), vb = cellValue(b.cells[i]);
        if (typeof va !== typeof vb) return typeof va === 'number' ? -1 : 1;
        return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
      });
      for (const r of [...rows, ...totals]) body.appendChild(r);
    };
  });
}
function fail(host, e) {
  host.innerHTML = `<div class="notice bad"><strong>Could not load this page.</strong><br>
    ${esc(e && e.message ? e.message : String(e))}</div>`;
}

/* ----------------------------------------------------------- update bar */

function renderUpdateBar(st) {
  S.update = st;
  let bar = document.getElementById('updateBar');
  const show = st && (st.downloaded || st.available || (st.progress && st.progress.percent < 100));
  if (!show) { if (bar) bar.remove(); return; }

  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'updateBar';
    bar.className = 'update-bar';
    document.querySelector('.topbar').insertAdjacentElement('afterend', bar);
  }

  if (st.downloaded) {
    bar.className = 'update-bar ready';
    bar.innerHTML = `
      <div class="update-text">
        <strong>Grow Board ${esc(st.downloaded.version)} is ready.</strong>
        ${st.downloaded.notes.length ? `<span class="muted"> ${esc(st.downloaded.notes.slice(0, 2).join(' - '))}</span>` : ''}
      </div>
      <button class="btn sm" id="updLater">Later</button>
      <button class="btn sm primary" id="updInstall">Install and restart</button>`;
    document.getElementById('updInstall').onclick = () => window.gb.updateInstall();
    document.getElementById('updLater').onclick = () => bar.remove();
  } else if (st.progress) {
    bar.className = 'update-bar';
    bar.innerHTML = `<div class="update-text">Downloading version
      ${esc(st.available ? st.available.version : '')} - ${st.progress.percent}%</div>
      <div class="update-prog"><div style="width:${st.progress.percent}%"></div></div>`;
  } else if (st.available) {
    bar.className = 'update-bar';
    bar.innerHTML = `<div class="update-text">
      <strong>Version ${esc(st.available.version)} is available.</strong>
      <span class="muted">Downloading in the background - you will be asked before anything is installed.</span>
      </div>`;
  }
}

/* ============================================================ PAGE: TODAY */

async function renderToday(host) {
  const b = unwrap(await window.gb.briefing());
  if (!b) throw new Error('No data returned. Check the database connection on the Settings page.');

  const { today: t, goal, expected, verdict: v } = b;
  const pctOfGoal = goal.goal ? (t.revenue / goal.goal) * 100 : 0;
  const remaining = Math.max(0, goal.goal - t.revenue);

  const series = await get('series30', () => window.gb.series(isoDaysAgo(30), isoToday()), 60000) || [];
  const prior = series.filter(d => d.date !== t.date);
  const avg7 = prior.slice(-7).reduce((a, d) => a + d.revenue, 0) / Math.max(1, prior.slice(-7).length);

  host.innerHTML = `
    ${verdict(v.state, `${fmtMoney(t.revenue)} today against a ${fmtMoney(goal.goal)} goal`, esc(v.line))}

    <div class="card" style="margin-bottom:14px">
      <div class="hero">
        <div class="ring-wrap" id="goalRing"></div>
        <div>
          <div class="hero-figures">
            <div class="stat hero-main">
              <div class="stat-label">Taken today</div>
              <div class="stat-value">${fmtMoney(t.revenue)}</div>
              <div class="stat-foot">${deltaTag(t.revenue, avg7)} vs your 7-day average of ${fmtMoney(avg7)}</div>
            </div>
            <div class="stat">
              <div class="stat-label">${remaining > 0 ? 'Still to go' : 'Over goal by'}</div>
              <div class="stat-value sm">${fmtMoney(remaining > 0 ? remaining : t.revenue - goal.goal)}</div>
              <div class="stat-foot">${expected ? `Usually ${Math.round(expected.sharePct)}% of the day is done by now` : 'Pacing needs more history'}</div>
            </div>
            <div class="stat">
              <div class="stat-label">Bills</div>
              <div class="stat-value sm">${fmtNum(t.bills)}</div>
              <div class="stat-foot">Average ${fmtMoney(t.abv)} per bill</div>
            </div>
            <div class="stat">
              <div class="stat-label">Gross margin</div>
              <div class="stat-value sm">${t.marginPct.toFixed(1)}%</div>
              <div class="stat-foot">${fmtMoney(t.grossProfit)} earned on goods sold</div>
            </div>
          </div>
          <details class="goal-why">
            <summary>How today's goal was worked out</summary>
            <ul>${goal.explain.map(e => `<li>${esc(e)}</li>`).join('')}
              <li class="muted">Confidence: ${goal.confidence} (based on ${goal.sampleDays} recent ${esc(goal.weekday)}s).</li>
            </ul>
          </details>
        </div>
      </div>
    </div>

    <div class="grid g-2-1" style="margin-bottom:14px">
      ${card('Today hour by hour, against a normal day', '<div id="hourChart"></div><div id="hourSoWhat"></div>',
             'bars = today, line = typical')}
      ${card('How the money came in', '<div id="tenderChart"></div><div id="tenderSoWhat"></div>')}
    </div>

    <div class="section-title">Do this now</div>
    <div id="todayActions"></div>

    ${card('Last 30 days', '<div id="trend30"></div>' +
      sowhat(`The dashed line is your daily average of <strong>${fmtMoney(avg7 || 0)}</strong> over the last 7 trading days.`))}
  `;

  progressRing($('goalRing'), pctOfGoal, { sub: pctOfGoal >= 100 ? 'goal beaten' : 'of goal' });

  /* hourly: today's bars against the typical shape */
  const profile = await get('hourProfile', () => window.gb.hourlyProfile(), 600000) || [];
  const hours = [];
  const openH = (S.config?.business?.openHour) ?? 8;
  const closeH = (S.config?.business?.closeHour) ?? 22;
  for (let h = openH; h <= closeH; h++) hours.push(h);
  const todayByHour = new Map((t.hourly || []).map(x => [x.hour, x.amount]));
  const profByHour = new Map(profile.map(x => [x.hour, x.avgAmount]));

  barChart($('hourChart'), {
    height: 210,
    data: hours.map(h => ({
      label: h > 12 ? `${h - 12}p` : h === 12 ? '12p' : `${h}a`,
      value: todayByHour.get(h) || 0,
      note: `Typical ${fmtShort(profByHour.get(h) || 0)}`,
      color: (todayByHour.get(h) || 0) >= (profByHour.get(h) || 0) ? C.s3 : C.s1
    })),
    valueName: 'Today'
  });
  const nowH = new Date().getHours();
  const peak = profile.slice().sort((a, b) => b.avgAmount - a.avgAmount)[0];
  $('hourSoWhat').innerHTML = sowhat(
    peak ? `Your strongest hour is normally <strong>${hourName(peak.hour)}</strong>. ${
      nowH < peak.hour
        ? `That is still ahead of you today - the day is not decided yet.`
        : `That has already passed today.`}` : 'Not enough history yet to show a typical shape.');

  stackBar($('tenderChart'), [
    { label: 'Cash', value: t.cash, color: C.s1 },
    { label: 'Card / bank', value: t.digital, color: C.s2 },
    { label: 'On credit', value: t.credit, color: C.s4 }
  ]);
  const digitalShare = (t.cash + t.digital) ? (t.digital / (t.cash + t.digital)) * 100 : 0;
  $('tenderSoWhat').innerHTML = sowhat(
    t.credit > 0
      ? `<strong>${fmtMoney(t.credit)}</strong> went out on credit today - money you have not actually received.`
      : `All of today's takings are settled. Digital is <strong>${digitalShare.toFixed(0)}%</strong> of the counter.`);

  const top3 = b.topActions.slice(0, 2);
  $('todayActions').innerHTML = top3.length
    ? top3.map((a, i) => actionCard(a, i)).join('') +
      `<button class="btn sm" data-goto="actions">See all ${b.allActions.length} things to act on</button>`
    : '<div class="notice good">Nothing urgent. Keep serving.</div>';

  const days = series.slice(-30);
  lineChart($('trend30'), {
    height: 220,
    labels: days.map(d => dayLabel(d.date)),
    series: [
      { name: 'Revenue', values: days.map(d => d.revenue), color: C.s1, area: true },
      { name: '7-day average', values: days.map(() => avg7), color: C.muted, dashed: true }
    ]
  });
}

const hourName = h => h > 12 ? `${h - 12} pm` : h === 12 ? '12 noon' : `${h} am`;
// Local calendar dates. toISOString() is UTC, which is still yesterday before 5:30 am in India.
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isoToday = () => isoLocal(new Date());
function isoDaysAgo(k) { const d = new Date(); d.setDate(d.getDate() - k); return isoLocal(d); }

/* ========================================================== PAGE: ACTIONS */

function actionCard(a, i) {
  return `<div class="action ${a.severity}">
    <div class="action-head">
      <span class="action-rank">${i + 1}</span>
      <h3>${esc(a.title)}</h3>
      <span class="chip ${a.severity}">${esc(a.severity)}</span>
      <span class="chip">${esc(a.theme)}</span>
    </div>
    <p class="action-why">${esc(a.why)}</p>
    <div class="action-do">${DO_ICON}<div>${esc(a.todo)}</div></div>
    ${a.impact || a.impactLabel ? `<div class="action-impact">
        ${a.impact ? `<span class="amt">${fmtMoney(a.impact)}</span>` : ''}
        <span>${esc(a.impactLabel || '')}</span></div>` : ''}
    ${a.where ? `<div class="action-foot"><button class="btn sm" data-goto="${esc(a.where)}">Show me the detail</button></div>` : ''}
  </div>`;
}

async function renderActions(host) {
  const actions = unwrap(await window.gb.actions()) || [];
  S.actions = actions;
  const crit = actions.filter(a => a.severity === 'critical').length;
  const money = actions.reduce((s, a) => s + (a.impact || 0), 0);

  host.innerHTML =
    verdict(crit ? 'critical' : actions.length ? 'warning' : 'good',
      crit ? `${crit} thing${crit > 1 ? 's need' : ' needs'} attention now`
           : actions.length ? `${actions.length} things worth acting on` : 'Nothing needs your attention',
      actions.length
        ? `Worked out from your own numbers and ordered by what moves the business most. Roughly <strong>${fmtMoney(money)}</strong> is identified across these, though the estimates are deliberately conservative.`
        : 'No issues detected in the current data.') +
    (actions.length ? actions.map((a, i) => actionCard(a, i)).join('')
                    : '<div class="notice good">All clear.</div>');
}

/* =========================================================== PAGE: GROWTH */

/*
 * Year on year, like for like. The headline compares this financial year so
 * far with the same dates last year - unless a festival season sits inside one
 * window and not the other, in which case it leaves every season day out of
 * both and compares ordinary trading days. The page says which it did.
 */

const pctOf = (a, b) => (b ? ((a - b) / Math.abs(b)) * 100 : null);
const fmtPct = (p, d = 1) => (p === null || p === undefined || !isFinite(p) ? '-' : `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(d)}%`);
const signed = v => `${v >= 0 ? '+' : '−'}${fmtMoney(Math.abs(v))}`;
const signedShort = v => `${v >= 0 ? '+' : '−'}${fmtShort(Math.abs(v))}`;
function pctTag(p, invert = false) {
  if (p === null || p === undefined || !isFinite(p)) return '<span class="delta flat">-</span>';
  const good = invert ? p < 0 : p > 0;
  const cls = Math.abs(p) < 0.5 ? 'flat' : good ? 'up' : 'down';
  const arrow = Math.abs(p) < 0.5 ? '' : p > 0 ? '↑' : '↓';
  return `<span class="delta ${cls}">${arrow} ${Math.abs(p).toFixed(1)}%</span>`;
}

/** Jump to the Profit page with a view already chosen. */
function openExplorer(state) {
  S.ex = { ...exDefaults(), ...state };
  saveEx();
  show('profit');
}

function leverBlock(name, l, fmtV, how, under) {
  return `<div class="lever">
    <div class="lever-name">${name}</div>
    <div class="lever-val">${fmtV(l.now)}</div>
    <div class="lever-was">last year ${fmtV(l.was)} ${pctTag(l.pct)}</div>
    <div class="lever-effect ${l.effect >= 0 ? 'up' : 'down'}">${signed(l.effect)}
      <small>${under ? 'on ordinary days' : 'of the change'}</small></div>
    <p class="lever-how">${how}</p>
  </div>`;
}

async function renderGrowth(host) {
  const [g, wd, monthly, profile] = await Promise.all([
    need('growth', () => window.gb.growth(), 300000),
    get('weekday', () => window.gb.weekday(), 600000),
    get('monthly', () => window.gb.monthly(), 900000),
    get('hourProfile', () => window.gb.hourlyProfile(), 600000)
  ]);

  const H = g.headline, F = g.fytd, U = g.underlying, L = g.levers;
  const under = g.basis === 'underlying';
  const pct = H.pct || 0;
  const state = pct >= 5 ? 'good' : pct >= 0 ? 'warning' : 'serious';
  const priceOnly = L.price.effect > 0 && L.price.effect >= L.change && (L.bills.effect < 0 || L.pieces.effect < 0);
  const draggers = [L.bills.effect < 0 ? 'fewer bills' : null, L.pieces.effect < 0 ? 'fewer pieces per bill' : null].filter(Boolean);

  const title = under
    ? `Like for like, sales are ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(1)}% on last year`
    : `Sales are ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(1)}% on the same dates last year`;
  const body = (under
    ? `${esc(g.gapNote)} So the fair comparison leaves every festival-season day out of both years:
       an ordinary trading day now brings <strong>${fmtMoney(U.cur.perDay)}</strong>, against
       <strong>${fmtMoney(U.prev.perDay)}</strong> last year. On the plain calendar it reads
       ${fmtShort(F.cur.revenue)} against ${fmtShort(F.prev.revenue)} (${fmtPct(F.pct)}).`
    : `<strong>${fmtMoney(F.cur.revenue)}</strong> from 1 April to ${dayLabel(g.asOf)}, against
       <strong>${fmtMoney(F.prev.revenue)}</strong> over the same dates last year.`)
    + (priceOnly ? ` <strong>All of it came from higher prices per piece</strong> - ${draggers.join(' and ')} pulled the other way.` : '');

  const prevPct = H.prevPct;
  const slowed = prevPct !== null && pct < prevPct;

  host.innerHTML = `
    ${verdict(state, title, body)}

    <div class="grid g4" style="margin-bottom:14px">
      ${statTile('This year so far', fmtMoney(F.cur.revenue), `${pctTag(F.pct)} vs same dates last year`)}
      ${under
        ? statTile('Like for like', fmtPct(U.pct), 'festival-season days left out of both years')
        : statTile('Per trading day', fmtMoney(F.cur.perDay), `${pctTag(pctOf(F.cur.perDay, F.prev.perDay))} vs ${fmtMoney(F.prev.perDay)}`)}
      ${statTile('Gross profit so far', fmtMoney(F.cur.gp), `${pctTag(F.gpPct)} · margin ${F.cur.margin.toFixed(1)}% (was ${F.prev.margin.toFixed(1)}%)`)}
      ${statTile('Growth a year ago', prevPct === null ? '-' : fmtPct(prevPct),
        prevPct === null ? 'not enough history' : `on the same basis - growth has ${slowed ? 'slowed' : 'picked up'}`)}
    </div>

    ${card('Where the change came from', `
      <p class="equation">Takings = <strong>bills</strong> × <strong>pieces per bill</strong> × <strong>price per piece</strong>.
        Each lever moves for a different reason and has a different fix. Together they make up the
        <strong>${signed(L.change)}</strong>${under ? ' change on ordinary trading days' : ' change'}.</p>
      <div class="grid g3">
        ${leverBlock(under ? 'Bills per trading day' : 'Bills', under
          ? { ...L.bills, now: H.cur.billsPerDay, was: H.prev.billsPerDay } : L.bills,
          v => (under ? v.toFixed(1) : fmtNum(v)),
          L.bills.effect < 0
            ? 'Fewer customers billed. Until mobile numbers are captured, the levers are the shop front, festival boards and WhatsApp status.'
            : 'More customers billed than last year. Keep doing what brings them in.', under)}
        ${leverBlock('Pieces per bill', L.pieces, v => v.toFixed(2),
          L.pieces.effect < 0
            ? `Each bill carries fewer pieces. One add-on per bill - innerwear, kids wear, a lining with every saree - is the cheapest growth there is. Back at ${L.pieces.was.toFixed(2)} a bill is worth about <strong>${fmtShort(Math.abs(L.pieces.effect) * (L.price.now / (L.price.was || 1)))}</strong>.`
            : 'Customers take more pieces per bill than last year - the counter add-on is working.', under)}
        ${leverBlock('Price per piece', L.price, v => fmtMoney(v),
          L.price.effect >= 0
            ? 'Each piece sells for more: higher rates, or customers choosing better ranges. The price-band view shows which.'
            : 'Customers are trading down to cheaper ranges, or discounting has grown. The price-band view shows which.', under)}
      </div>
      ${sowhat(`Gross margin <strong>${H.cur.margin.toFixed(1)}%</strong> against ${H.prev.margin.toFixed(1)}% last year.
        Discount given: <strong>${fmtMoney(H.cur.discount)}</strong> against ${fmtMoney(H.prev.discount)}
        (${fmtPct(pctOf(H.cur.discount, H.prev.discount), 0)}) - ${H.cur.discount <= H.prev.discount
          ? 'less given away is profit kept.' : 'more is being given away than last year.'}
        <button class="btn sm" id="gPrice" style="margin-left:6px">Price bands on the Profit page</button>`)}
    `)}

    <div class="spacer-16"></div>
    <div class="grid g2">
      ${card('The last 30 days, read three ways', last30Table(g.last30), 'which comparison to trust')}
      ${card(g.season ? `${esc(g.season.name)} ${g.season.inProgress ? 'season is on' : 'is coming'}` : 'Festival season', seasonCard(g.season))}
    </div>

    <div class="spacer-16"></div>
    ${card('Who grew and who shrank', `
      <div class="grid g2">
        <div><div class="sub-head">Added the most</div><div id="gUp"></div></div>
        <div><div class="sub-head">Lost the most</div><div id="gDown"></div></div>
      </div>
      <div id="gCatSoWhat"></div>`,
      under ? 'sales by category, ordinary days, last year scaled to the same number of days' : 'sales by category, same dates last year')}

    <div class="spacer-16"></div>
    ${card('Month by month against last year', monthsTable(g.months) + '<div id="gMonthly" style="margin-top:14px"></div>' + sowhat(
      `${g.months.filter(m => (m.pct || 0) > 0).length} of ${g.months.length} months are ahead of last year.
       The line shows the shape of each financial year - festival months repeat, so buy against the same season last year, not against last month.`),
      'the current month is compared day for day')}

    <div class="spacer-16"></div>
    ${card('Daily sales, last 90 days', '<div id="g90"></div><div id="g90SoWhat"></div>', '7-day average · last year = same weekday 52 weeks earlier')}

    <div class="spacer-16"></div>
    <div class="grid g2">
      ${card('Which day of the week earns most', '<div id="gWeek"></div><div id="gWeekSoWhat"></div>', 'last 12 months')}
      ${card('Which hour earns most', '<div id="gHour"></div>' + sowhat(
        'The shop is open all day but earns in bursts. Make sure your best staff and freshest display are on the floor during the tall bars.'), 'last 12 months')}
    </div>
  `;

  $('gPrice').onclick = () => openExplorer({ presetId: 'fytd', by: 'price' });
  const sb = $('gSeasonBtn');
  if (sb) sb.onclick = () => openExplorer({ presetId: sb.dataset.preset, by: 'item' });

  /* who grew, who shrank */
  const cats = (g.categories || []).filter(c => c.key);
  const up = cats.filter(c => c.d.revenue > 0).sort((a, b) => b.d.revenue - a.d.revenue).slice(0, 7);
  const down = cats.filter(c => c.d.revenue < 0).sort((a, b) => a.d.revenue - b.d.revenue).slice(0, 7);
  const catNote = c => `${fmtMoney(c.prev)} → ${fmtMoney(c.cur)}. Gross profit ${signed(c.d.gp)}: ` +
    (Math.abs(c.d.marginEffect) > Math.abs(c.d.volumeEffect)
      ? (Math.max(c.zeroCostNow, c.zeroCostWas) > 10
        ? 'mostly opening stock sold with no cost price, not a real margin change'
        : `mostly margin (${c.marginWas.toFixed(1)}% → ${c.marginNow.toFixed(1)}%)`)
      : `mostly from selling ${c.d.volumeEffect >= 0 ? 'more' : 'less'}`) + '. Click for its items.';
  const toItems = d => openExplorer({ presetId: 'fytd', by: 'item', filter: { category: d.key }, labels: { category: d.key } });
  hbarChart($('gUp'), {
    data: up.map(c => ({ key: c.key, label: c.label, value: c.d.revenue, color: C.s3, note: catNote(c) })),
    format: signedShort, onClick: toItems, limit: 7
  });
  hbarChart($('gDown'), {
    data: down.map(c => ({ key: c.key, label: c.label, value: c.d.revenue, color: C.s2, note: catNote(c) })),
    format: signedShort, onClick: toItems, limit: 7
  });
  const added = cats.filter(c => c.d.revenue > 0).reduce((a, c) => a + c.d.revenue, 0);
  const lost = cats.filter(c => c.d.revenue < 0).reduce((a, c) => a + c.d.revenue, 0);
  const squeeze = cats.filter(c => c.cur > 20000 && c.zeroCostNow < 10 && c.zeroCostWas < 10)
    .sort((a, b) => a.d.marginEffect - b.d.marginEffect)[0];
  $('gCatSoWhat').innerHTML = sowhat(
    `Growing categories added <strong>${fmtMoney(added)}</strong>; shrinking ones lost <strong>${fmtMoney(-lost)}</strong>.
     The total hides that churn - the work is in the individual lines.` +
    (squeeze && squeeze.d.marginEffect < -5000
      ? ` Biggest margin squeeze: <strong>${esc(squeeze.label)}</strong> lost ${fmtMoney(-squeeze.d.marginEffect)} of gross profit to a thinner margin
         (${squeeze.marginWas.toFixed(1)}% → ${squeeze.marginNow.toFixed(1)}%). Check its buying rates and discounts.` : ''));

  /* month by month: shape of each financial year */
  const byFy = {};
  for (const m of (monthly || [])) (byFy[m.fy] = byFy[m.fy] || []).push(m);
  const fys = Object.keys(byFy).sort().slice(-3);
  const months = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
  const order = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
  const cols = [C.muted, C.s2, C.s1];
  lineChart($('gMonthly'), {
    height: 220,
    labels: months,
    series: fys.map((fy, i) => ({
      name: `FY ${fy}`, color: cols[(cols.length - fys.length + i) % cols.length], dashed: i < fys.length - 2,
      values: order.map(mo => { const r = byFy[fy].find(x => x.month === mo); return r ? r.revenue : null; })
    }))
  });

  /* daily, 7-day average */
  const daily = g.daily || [];
  const avg7 = arr => arr.map((_, i) => { const w = arr.slice(Math.max(0, i - 6), i + 1); return w.reduce((a, b) => a + b, 0) / w.length; });
  lineChart($('g90'), {
    height: 240,
    labels: daily.map(d => dayLabel(d.date)),
    series: [
      { name: 'This year', values: avg7(daily.map(d => d.cur)), color: C.s1, area: true },
      { name: 'Last year', values: avg7(daily.map(d => d.prev)), color: C.muted, dashed: true }
    ]
  });
  const w1 = daily.slice(-7), w0 = daily.slice(-14, -7);
  const sum = (a, k) => a.reduce((s, d) => s + d[k], 0);
  const seasonDays = daily.filter(d => d.season).length;
  $('g90SoWhat').innerHTML = sowhat(
    `Last 7 days: <strong>${fmtMoney(sum(w1, 'cur'))}</strong> against ${fmtMoney(sum(w1, 'prev'))} on the same weekdays last year
     (${fmtPct(pctOf(sum(w1, 'cur'), sum(w1, 'prev')))}); the week before was ${fmtPct(pctOf(sum(w0, 'cur'), sum(w0, 'prev')))}.` +
    (seasonDays ? ` Festival weeks never line up exactly - where last year's line jumps, that is its festival rush, not a lost week.` : ''));

  /* weekday and hour, rolling twelve months */
  const active = (wd || []).filter(w => w.days >= 3);
  const bestDay = active.slice().sort((a, b) => b.avgRevenue - a.avgRevenue)[0];
  const worstDay = active.slice().sort((a, b) => a.avgRevenue - b.avgRevenue)[0];
  const avgDay = active.length ? active.reduce((a, w) => a + w.avgRevenue, 0) / active.length : 0;
  barChart($('gWeek'), {
    height: 210,
    data: active.map(w => ({
      label: w.name.slice(0, 3), value: w.avgRevenue,
      note: `${w.days} days recorded`,
      color: w.avgRevenue >= avgDay ? C.s3 : C.s2
    })),
    valueName: 'Average'
  });
  $('gWeekSoWhat').innerHTML = sowhat(worstDay && bestDay
    ? `<strong>${esc(worstDay.name)}</strong> is worth about ${fmtMoney(bestDay.avgRevenue - worstDay.avgRevenue)} less than <strong>${esc(bestDay.name)}</strong>. Same rent, same staff - that gap is the cheapest growth you can buy.`
    : 'Not enough history yet.');
  barChart($('gHour'), {
    height: 210,
    data: (profile || []).map(p => ({
      label: p.hour > 12 ? `${p.hour - 12}p` : p.hour === 12 ? '12p' : `${p.hour}a`,
      value: p.avgAmount, note: `${p.bills} bills`, color: C.s1
    })),
    valueName: 'Average'
  });
}

function last30Table(l) {
  const row = (name, s, read, fair) => `<tr${fair ? ' class="fair"' : ''}>
    <td class="name">${name}</td>
    <td class="num">${fmtMoney(s.revenue)}</td>
    <td class="num">${pctTag(pctOf(l.cur.revenue, s.revenue))}</td>
    <td class="muted">${read}</td></tr>`;
  const aligned = !!l.aligned;
  return `<p class="equation" style="margin-bottom:8px">This year's last 30 days brought <strong>${fmtMoney(l.cur.revenue)}</strong>
    from <strong>${fmtNum(l.cur.bills)}</strong> bills.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Compared with</th><th class="num">They brought</th><th class="num">Change</th><th>How to read it</th></tr></thead>
      <tbody>
        ${row('The 30 days before', l.prev30, 'Mostly season: every month differs from the last.', false)}
        ${row('Same dates last year', l.lastYear, aligned ? 'Distorted - the festival fell on a different date.' : 'The fair comparison: no festival nearby.', !aligned)}
        ${aligned ? row('Same point in the festival run-up last year', l.aligned, `The fair comparison. ${esc(l.alignedNote)}`, true) : ''}
      </tbody></table></div>`;
}

function seasonCard(s) {
  if (!s) {
    return `<p class="empty">No festival in the next 75 days in the festival list.</p>
      <p class="sowhat">Festival dates live in <code>config.json</code> under <code>festivals</code>. Add each new year's dates from the Tamil Nadu holiday list.</p>`;
  }
  const ly = s.lastYear;
  const multiple = ly && ly.before.revenue ? ly.total.revenue / ly.before.revenue : null;
  const lead = s.inProgress
    ? (s.soFar
      ? `<div class="stat"><div class="stat-label">Season so far</div>
           <div class="stat-value sm">${fmtMoney(s.soFar.cur.revenue)}</div>
           <div class="stat-foot">${pctTag(pctOf(s.soFar.cur.revenue, s.soFar.prev.revenue))} on the same days into last year's run-up (${fmtMoney(s.soFar.prev.revenue)})</div></div>`
      : '')
    : `<div class="stat"><div class="stat-label">${esc(s.name)} is on ${dayLabel(s.date)}</div>
         <div class="stat-value sm">${s.daysToGo} days to go</div>
         <div class="stat-foot">the run-up starts ${dayLabel(s.from)}</div></div>`;
  return `${lead}
    ${s.inProgress ? `<p class="equation" style="margin-top:10px">${s.daysToGo} days to ${esc(s.name)} (${dayLabel(s.date)}).</p>` : ''}
    ${ly ? `<p class="sowhat" style="border:0;padding-top:4px">Last year's season (${dayLabel(ly.from)} – ${dayLabel(ly.to)}) brought
      <strong>${fmtMoney(ly.total.revenue)}</strong> from ${fmtNum(ly.total.bills)} bills${multiple
        ? ` - <strong>${multiple.toFixed(1)}×</strong> the 30 days before it` : ''}.
      Whatever sold then is what customers will come in asking for now.</p>
      <button class="btn sm primary" id="gSeasonBtn" data-preset="${esc(ly.presetId)}">See what sold last season, item by item</button>`
      : '<p class="sowhat">No date for last year\'s festival in the list, so there is nothing to compare against yet.</p>'}`;
}

function monthsTable(months) {
  const note = m => [
    ...m.festivalsNow.map(f => `${f} this year`),
    ...m.festivalsThen.map(f => `${f} was in this month last year`)
  ].join('; ');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Month</th><th class="num">This year</th><th class="num">Last year</th><th class="num">Change</th><th>Why it may differ</th></tr></thead>
    <tbody>${months.map(m => `<tr>
      <td class="name">${esc(m.label)}${m.partial ? ' <span class="muted">so far</span>' : ''}</td>
      <td class="num">${fmtMoney(m.cur.revenue)}</td>
      <td class="num muted">${fmtMoney(m.prev.revenue)}</td>
      <td class="num">${pctTag(m.pct)}</td>
      <td class="muted">${esc(note(m))}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function updateCard(upd, ver) {
  const cur = ver ? ver.version : '';
  if (!upd || !upd.configured) {
    return `<div class="notice"><strong>Automatic updates are not switched on yet.</strong><br>
      Grow Board is version <strong>${esc(cur)}</strong>. To turn updates on, set
      <code>update.enabled</code>, <code>update.owner</code> and <code>update.repo</code>
      in <code>config.json</code> to your GitHub account and repository.</div>
      <div class="help">Once configured, Grow Board checks GitHub on startup and every few hours,
      downloads a new version quietly, and asks you before installing it.</div>`;
  }
  const rows = [];
  rows.push(`<div class="field"><label>Installed version</label><input value="${esc(cur)}" disabled></div>`);
  if (upd.downloaded) {
    rows.push(`<div class="notice good"><strong>Version ${esc(upd.downloaded.version)} is downloaded and ready.</strong>
      ${upd.downloaded.notes.length ? `<ul style="margin:8px 0 0;padding-left:18px">${
        upd.downloaded.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>
      <button class="btn primary sm" id="installUpd">Install and restart</button>`);
  } else if (upd.progress) {
    rows.push(`<div class="notice">Downloading - ${upd.progress.percent}%</div>`);
  } else if (upd.available) {
    rows.push(`<div class="notice">Version ${esc(upd.available.version)} found. Downloading in the background.</div>`);
  } else {
    rows.push(`<div class="notice good">You are on the latest version.</div>`);
  }
  rows.push(`<button class="btn sm" id="checkUpd">Check for updates now</button>
    <span id="updMsg" class="muted" style="margin-left:8px"></span>`);
  if (upd.lastCheck) rows.push(`<div class="help" style="margin-top:8px">Last checked
    ${new Date(upd.lastCheck).toLocaleString('en-IN')}.</div>`);
  if (upd.error) rows.push(`<div class="help" style="color:var(--status-warning)">${esc(upd.error)}</div>`);
  return rows.join('');
}

function festivalCard(cfg) {
  const list = (cfg.festivals && cfg.festivals.list) || [];
  if (!list.length) {
    return `<p class="empty">No festivals listed. Growth will compare the same dates last year only.</p>`;
  }
  const t = isoToday();
  return `<div class="table-wrap"><table>
      <thead><tr><th>Festival</th><th class="num">Season</th><th>Last</th><th>Next</th></tr></thead>
      <tbody>${list.map(f => {
        const dates = (f.dates || []).slice().sort();
        const past = dates.filter(d => d < t), next = dates.filter(d => d >= t);
        return `<tr><td class="name">${esc(f.name)}</td>
          <td class="num">${esc(f.leadDays)} days</td>
          <td class="muted">${past.length ? dayLabel(past[past.length - 1]) + ' ' + past[past.length - 1].slice(0, 4) : '-'}</td>
          <td>${next.length ? dayLabel(next[0]) + ' ' + next[0].slice(0, 4)
            : '<span class="pill warn">add next year\'s date</span>'}</td></tr>`;
      }).join('')}</tbody></table></div>
    <div class="help" style="margin-top:8px">Edit these in <code>config.json</code> under <code>festivals</code>, using the Tamil Nadu
      holiday list. A wrong date shifts every festival comparison, so check each new year's dates once.</div>`;
}

function statTile(label, value, foot) {
  return `<div class="card"><div class="stat">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value sm">${value}</div>
    <div class="stat-foot">${foot || ''}</div></div></div>`;
}

/* =========================================================== PAGE: PROFIT */

/*
 * The profit explorer. One period (with its comparison chosen in periods.js),
 * one way of slicing it, any number of filters stacked by clicking down:
 * category -> its items -> one item by month -> ...
 * Every view opens with what the rows say, not with the rows.
 */

const EX_DIMS = [
  ['category', 'Category'], ['item', 'Item'], ['price', 'Price band'], ['supplier', 'Supplier'], ['size', 'Size'],
  ['month', 'Month'], ['week', 'Week'], ['day', 'Day'], ['weekday', 'Weekday'], ['hour', 'Hour']
];
const EX_TIME = new Set(['day', 'week', 'month']);
const EX_ORDERED = new Set(['weekday', 'hour', 'price']);
const EX_DRILL = { category: 'item', supplier: 'item', price: 'item', size: 'item', item: 'month', weekday: 'hour', month: 'day', week: 'day' };
const EX_NOUN = {
  category: ['category', 'categories'], item: ['item', 'items'], price: ['price band', 'price bands'],
  supplier: ['supplier', 'suppliers'], size: ['size', 'sizes'], month: ['month', 'months'], week: ['week', 'weeks'],
  day: ['day', 'days'], weekday: ['weekday', 'weekdays'], hour: ['hour', 'hours']
};
const EX_FILTER_NAME = { category: 'Category', item: 'Item', price: 'Price', supplier: 'Supplier', size: 'Size', weekday: 'Weekday', hour: 'Hour' };

function exDefaults() { return { presetId: 'fytd', window: null, by: 'category', filter: {}, labels: {}, sort: null, showAll: false }; }
function loadEx() {
  try {
    const v = JSON.parse(localStorage.getItem('gb-explorer') || 'null');
    return v && typeof v === 'object' ? { ...exDefaults(), ...v } : null;
  } catch { return null; }
}
function saveEx() { try { localStorage.setItem('gb-explorer', JSON.stringify(S.ex)); } catch { /* private mode */ } }

const isoAdd = (s, k) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + k); return isoLocal(d); };
const monthEnd = ym => { const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0); return isoLocal(d); };

/** Share of a row's sales, either year, that is stock with no cost price recorded. */
const zeroCostOf = r => Math.max(r.cur.zeroCostPct || 0, r.prev ? r.prev.zeroCostPct || 0 : 0);

/**
 * Why a row's gross profit moved: selling more or less, or earning more or
 * less per rupee. When zero-cost opening stock is part of either year, a
 * margin move is mostly that stock, not buying or pricing - and it says so.
 */
function causeOf(r) {
  if (!r.prev || !r.prev.taxable) return { text: 'new', good: true, tip: 'Nothing sold in the comparison period.' };
  if (!r.cur.taxable) return { text: 'stopped', good: false, tip: 'Sold in the comparison period, nothing now.' };
  const v = r.d.volumeEffect, m = r.d.marginEffect;
  const tip = `${signed(v)} from selling ${v >= 0 ? 'more' : 'less'}, ${signed(m)} from a ${m >= 0 ? 'better' : 'thinner'} margin`;
  if (Math.abs(r.d.gp) < 500) return { text: 'steady', good: null, tip };
  if (Math.abs(m) > Math.abs(v) && zeroCostOf(r) > 10) {
    return { text: 'no-cost stock', good: null,
      tip: `The margin moved mostly because of opening stock sold with no cost price, which counts as pure profit. On stock with a recorded cost: ${r.prev.costedMargin.toFixed(1)}% last year, ${r.cur.costedMargin.toFixed(1)}% now.` };
  }
  return Math.abs(m) > Math.abs(v)
    ? { text: m < 0 ? 'thinner margin' : 'better margin', good: m >= 0, tip }
    : { text: v < 0 ? 'sold less' : 'sold more', good: v >= 0, tip };
}

function exInsights(x, ex) {
  const out = [];
  const T = x.totals;
  const noun = EX_NOUN[x.by];
  const rows = x.rows.filter(r => r.key !== '');
  const name = r => `<strong>${esc(r.label)}</strong>`;
  const time = EX_TIME.has(x.by);

  if (time) {
    const both = rows.filter(r => r.prev && r.prev.gp);
    const ahead = both.filter(r => r.cur.gp > r.prev.gp).length;
    if (both.length >= 2) {
      out.push({ tone: ahead >= both.length / 2 ? 'good' : 'warning',
        html: `Gross profit is ahead of last year in <strong>${ahead} of ${both.length}</strong> ${noun[1]}.` });
    }
    const worst = both.slice().sort((a, b) => a.d.gp - b.d.gp)[0];
    if (worst && worst.d.gp < 0) {
      out.push({ tone: 'warning', html: `Weakest against last year: ${name(worst)}, ${signed(worst.d.gp)} of gross profit (${causeOf(worst).text}).` });
    }
  } else if (rows.length >= 4 && T.cur.gp > 0) {
    const sorted = rows.slice().sort((a, b) => b.cur.gp - a.cur.gp);
    const top = sorted.slice(0, 3);
    const share = top.reduce((a, r) => a + r.cur.gp, 0) / T.cur.gp * 100;
    out.push({ tone: 'info', html: `${top.map(name).join(', ')} earn <strong>${share.toFixed(0)}%</strong> of the gross profit in this view.
      ${share > 60 ? 'Never let these run short.' : ''}` });
  }

  if (!time) {
    // Rows that are mostly zero-cost stock have no real margin to talk about.
    const moved = rows.filter(r => r.prev && r.prev.taxable > 0 && r.cur.taxable > 0 && r.cur.zeroCostPct < 50 && r.prev.zeroCostPct < 50);
    const floor = Math.max(2000, Math.abs(T.prev.gp) * 0.01);
    const realMove = r => `On stock with a recorded cost its margin went from ${r.prev.costedMargin.toFixed(1)}% to ${r.cur.costedMargin.toFixed(1)}%`;
    const loser = moved.slice().sort((a, b) => a.d.gp - b.d.gp)[0];
    if (loser && loser.d.gp < -floor) {
      const viaMargin = Math.abs(loser.d.marginEffect) > Math.abs(loser.d.volumeEffect);
      const real = loser.cur.costedMargin - loser.prev.costedMargin;
      if (viaMargin && zeroCostOf(loser) > 10) {
        out.push({ tone: real < -2 ? 'serious' : 'info', html: `${name(loser)} earned ${fmtMoney(-loser.d.gp)} less gross profit than last year.
          Much of last year's figure was opening stock sold with no cost price, which counted as pure profit. ${realMove(loser)}${
          real < -2 ? ' - still thinner, so check buying rates and discount too.' : real > 2 ? ' - the goods themselves now earn more, not less.' : ' - about the same.'}` });
      } else {
        out.push({ tone: 'serious', html: viaMargin
          ? `${name(loser)} earned ${fmtMoney(-loser.d.gp)} less gross profit than last year, mostly from a thinner margin
             (${loser.prev.margin.toFixed(1)}% → ${loser.cur.margin.toFixed(1)}%), not lower sales. Check what you pay for it and how much discount it gets.`
          : `${name(loser)} earned ${fmtMoney(-loser.d.gp)} less gross profit, mostly from selling less
             (sales ${fmtPct(pctOf(loser.cur.revenue, loser.prev.revenue), 0)}). Margin held at ${loser.cur.margin.toFixed(1)}%. Check stock depth, sizes and display before cutting the price.` });
      }
    }
    const winner = moved.slice().sort((a, b) => b.d.gp - a.d.gp)[0];
    if (winner && winner.d.gp > floor) {
      const viaMargin = Math.abs(winner.d.marginEffect) > Math.abs(winner.d.volumeEffect);
      out.push(viaMargin && zeroCostOf(winner) > 10
        ? { tone: 'info', html: `${name(winner)} added ${fmtMoney(winner.d.gp)} of gross profit, but mostly by selling opening stock with
            no cost price recorded - that counts as pure profit. ${realMove(winner)}.` }
        : { tone: 'good', html: `${name(winner)} added ${fmtMoney(winner.d.gp)} of gross profit -
            ${viaMargin ? 'mostly a better margin' : 'mostly from selling more'}. Keep it stocked deep and in front.` });
    }
    const avgReal = T.cur.costedMargin;
    const heavy = rows.filter(r => r.revShare >= 8 && r.cur.zeroCostPct < 10 && r.cur.costedMargin < avgReal - 8)
      .sort((a, b) => b.revShare - a.revShare)[0];
    if (heavy) {
      out.push({ tone: 'warning', html: `${name(heavy)} is ${heavy.revShare.toFixed(0)}% of sales but earns only ${heavy.cur.costedMargin.toFixed(1)}%
        against ${avgReal.toFixed(1)}% on everything else with a recorded cost. Two points better on its buying rate or price is worth
        <strong>${fmtMoney(heavy.cur.taxable * 0.02)}</strong> over this period.` });
    }
    const disc = rows.filter(r => r.cur.disc > T.cur.disc * 0.05 && r.cur.discRate > Math.max(T.cur.discRate * 2, T.cur.discRate + 4))
      .sort((a, b) => b.cur.disc - a.cur.disc)[0];
    if (disc) {
      out.push({ tone: 'warning', html: `${name(disc)} gets the heaviest discounting: ${disc.cur.discRate.toFixed(1)}% off full price,
        against ${T.cur.discRate.toFixed(1)}% across this view (${fmtMoney(disc.cur.disc)}).` });
    }
  }
  if (x.identifiedPct !== null) {
    out.push({ tone: 'info', html: `The ${noun[0]} is known for <strong>${x.identifiedPct.toFixed(0)}%</strong> of sales here - it comes from the
      purchase tag, and older or untagged stock has none. Treat these as strong indicators, not exact totals.` });
  }
  return out.slice(0, 5);
}

async function renderProfit(host) {
  if (!S.ex) S.ex = loadEx() || exDefaults();
  const ex = S.ex;
  const presets = await need('periods', () => window.gb.periods(), 300000);
  let win = ex.presetId === 'custom' && ex.window ? ex.window : presets.find(p => p.id === ex.presetId);
  if (!win) { ex.presetId = 'fytd'; ex.window = null; win = presets.find(p => p.id === 'fytd') || presets[0]; }

  const q = { by: ex.by, from: win.from, to: win.to, cmpFrom: win.cmp.from, cmpTo: win.cmp.to, cmpBasis: win.cmp.basis, filter: ex.filter };
  const [x, exp, cov] = await Promise.all([
    need('ex:' + JSON.stringify(q), () => window.gb.explore(q), 120000),
    get(`exp:${win.from}:${win.to}`, () => window.gb.expenses(win.from, win.to), 300000),
    get('cov30', () => window.gb.expenseCoverage(30), 300000)
  ]);

  const T = x.totals;
  const gpPct = pctOf(T.cur.gp, T.prev.gp);
  const scope = Object.keys(ex.filter).map(d => ex.labels[d] || ex.filter[d]).join(' · ');
  const coverage = cov && cov.tradingDays ? (cov.daysWithExpense / cov.tradingDays) * 100 : 0;
  const costedMargin = T.cur.taxable - T.cur.zeroCost > 0 ? (T.cur.gp - T.cur.zeroCost) / (T.cur.taxable - T.cur.zeroCost) : 0;
  const overstated = T.cur.zeroCost * (1 - costedMargin);
  const state = gpPct === null ? 'info' : gpPct >= 3 ? 'good' : gpPct >= -3 ? 'warning' : 'serious';
  const zcMaterial = Math.max(T.cur.zeroCostPct, T.prev.zeroCostPct) > 3;
  const pts = d => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} points`;
  const basisText = win.cmp.basis === 'festival' ? `lined up on ${esc(win.cmp.festival || 'the festival')}` : 'same dates';

  host.innerHTML = `
    ${verdict(state,
      `${scope ? esc(scope) + ': ' : ''}${fmtMoney(T.cur.gp)} gross profit${gpPct === null ? '' : `, ${gpPct >= 0 ? 'up' : 'down'} ${Math.abs(gpPct).toFixed(1)}% on last year`}`,
      `On <strong>${fmtMoney(T.cur.revenue)}</strong> of sales at a <strong>${T.cur.margin.toFixed(1)}%</strong> margin
       (${T.prev.margin.toFixed(1)}% last year), ${esc(win.label)}.${zcMaterial ? ` On stock with a recorded cost the margin is <strong>${T.cur.costedMargin.toFixed(1)}%</strong> against ${T.prev.costedMargin.toFixed(1)}%.` : ''} ${win.cmp.note ? esc(win.cmp.note) : ''}`)}

    ${coverage < 60 ? `<div class="notice warn">This is <strong>gross</strong> profit - what the goods earn before rent, salary and running costs.
      Expenses are entered on only ${cov ? cov.daysWithExpense : 0} of the last ${cov ? cov.tradingDays : 0} trading days, so net profit
      cannot be worked out yet. See <em>Recorded expenses</em> at the bottom.</div>` : ''}
    ${T.cur.zeroCostPct > 3 ? `<div class="notice">${T.cur.zeroCostPct.toFixed(0)}% of the sales in this view are stock with no cost price
      recorded (opening stock entered at zero), which shows as pure profit. If it cost what the rest does, gross profit here is overstated by
      about <strong>${fmtMoney(overstated)}</strong>. Rows marked <span class="pill warn">no cost</span> are affected most.</div>` : ''}

    <div class="card toolbar">
      <div class="tb-row">
        <label for="exPeriod">Period</label>
        <select id="exPeriod">
          <optgroup label="Periods">${presets.filter(p => p.group === 'period').map(p =>
            `<option value="${esc(p.id)}" ${p.id === ex.presetId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>
          <optgroup label="Festival seasons">${presets.filter(p => p.group === 'season').map(p =>
            `<option value="${esc(p.id)}" ${p.id === ex.presetId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>
          <option value="custom" ${ex.presetId === 'custom' ? 'selected' : ''}>Pick dates...</option>
        </select>
        <span id="exCustom" ${ex.presetId === 'custom' ? '' : 'hidden'}>
          <input type="date" id="exFrom" value="${esc(win.from)}"> to <input type="date" id="exTo" value="${esc(win.to)}">
          <button class="btn sm" id="exApply">Show</button>
        </span>
        <span class="muted">${esc(win.label)} &nbsp;against&nbsp; <strong>${esc(win.cmp.label)}</strong></span>
        <span class="basis">${basisText}</span>
      </div>
      <div class="tb-row">
        <label>View by</label>
        <div class="seg" id="exBy">${EX_DIMS.map(([id, name]) =>
          `<button data-by="${id}" class="${id === ex.by ? 'on' : ''}" ${ex.filter[id] !== undefined ? 'disabled title="Already filtered to one"' : ''}>${name}</button>`).join('')}</div>
      </div>
      ${Object.keys(ex.filter).length ? `<div class="tb-row crumbs">
        <label>Showing only</label>
        ${Object.keys(ex.filter).map(d => `<span class="crumb">${esc(EX_FILTER_NAME[d] || d)}: <strong>${esc(ex.labels[d] || ex.filter[d])}</strong>
          <button data-unfilter="${esc(d)}" title="Remove this filter">×</button></span>`).join('')}
        <button class="btn sm" id="exClear">Show everything</button>
      </div>` : ''}
    </div>

    <div class="grid g4" style="margin-bottom:14px">
      ${statTile('Sales', fmtMoney(T.cur.revenue), `${pctTag(pctOf(T.cur.revenue, T.prev.revenue))} vs ${fmtShort(T.prev.revenue)}`)}
      ${statTile('Gross profit', fmtMoney(T.cur.gp), `${pctTag(gpPct)} vs ${fmtShort(T.prev.gp)}`)}
      ${statTile('Gross margin', `${T.cur.margin.toFixed(1)}%`, `${pts(T.cur.margin - T.prev.margin)} on last year${zcMaterial ? ` · ${pts(T.cur.costedMargin - T.prev.costedMargin)} on costed stock` : ''}`)}
      ${statTile('Discount given', fmtMoney(T.cur.disc), `${T.cur.discRate.toFixed(1)}% off full price · was ${T.prev.discRate.toFixed(1)}%`)}
    </div>

    ${card(`By ${EX_NOUN[x.by][0]}`, `
      <ul class="insights" id="exInsights"></ul>
      <div id="exChart"></div>
      ${EX_TIME.has(x.by) ? '' : `<p class="chart-key"><span class="legend-item"><span class="legend-dot" style="background:${C.s3}"></span>margin at or above
        ${T.cur.costedMargin.toFixed(1)}%</span><span class="legend-item"><span class="legend-dot" style="background:${C.s2}"></span>below it</span>
        <span class="muted">- measured on stock with a recorded cost</span></p>`}
      <div class="spacer-16"></div>
      <div id="exTable"></div>`,
      EX_DRILL[x.by] ? `click a row to see its ${EX_NOUN[EX_DRILL[x.by]][1]}` : '')}

    <div class="spacer-16"></div>
    ${card('Recorded expenses in this period', expensesTable(exp, cov), 'from the POS ledger')}
  `;

  const rerender = async () => {
    saveEx();
    host.classList.add('busy');
    try { await renderProfit(host); } catch (e) { fail(host, e); } finally { host.classList.remove('busy'); }
  };

  /* controls */
  $('exPeriod').onchange = (e) => {
    if (e.target.value === 'custom') { $('exCustom').hidden = false; return; }
    ex.presetId = e.target.value; ex.window = null; ex.sort = null; ex.showAll = false;
    rerender();
  };
  $('exApply').onclick = async () => {
    const r = await window.gb.periodWindow($('exFrom').value, $('exTo').value);
    if (!r || !r.ok) { fatalInline($('exCustom'), (r && r.error) || 'Could not use those dates.'); return; }
    ex.presetId = 'custom'; ex.window = r.data; ex.sort = null;
    rerender();
  };
  $('exBy').onclick = (e) => {
    const b = e.target.closest('button[data-by]');
    if (!b || b.disabled) return;
    ex.by = b.dataset.by; ex.sort = null; ex.showAll = false;
    rerender();
  };
  host.querySelectorAll('[data-unfilter]').forEach(b => b.onclick = () => {
    delete ex.filter[b.dataset.unfilter]; delete ex.labels[b.dataset.unfilter];
    rerender();
  });
  const clr = $('exClear');
  if (clr) clr.onclick = () => { ex.filter = {}; ex.labels = {}; rerender(); };

  const drill = async (row) => {
    const next = EX_DRILL[x.by];
    if (!next) return;
    if (x.by === 'month' || x.by === 'week') {
      let f = x.by === 'month' ? `${row.key}-01` : row.key;
      let t = x.by === 'month' ? monthEnd(row.key) : isoAdd(row.key, 6);
      if (f < win.from) f = win.from;
      if (t > win.to) t = win.to;
      const r = await window.gb.periodWindow(f, t);
      if (!r || !r.ok) return;
      ex.presetId = 'custom'; ex.window = r.data; ex.by = 'day';
    } else {
      ex.filter = { ...ex.filter, [x.by]: row.key };
      ex.labels = { ...ex.labels, [x.by]: row.label };
      ex.by = next;
    }
    ex.sort = null; ex.showAll = false;
    rerender();
  };

  /* what the rows say */
  const ins = exInsights(x, ex);
  $('exInsights').innerHTML = ins.length
    ? ins.map(i => `<li><span class="verdict-icon">${ICON[i.tone] || ICON.info}</span><span>${i.html}</span></li>`).join('')
    : '';
  if (!ins.length) $('exInsights').remove();

  /* chart */
  const rows = x.rows;
  if (EX_TIME.has(x.by)) {
    const short = r => (x.by === 'month' ? r.label.replace(/ 20(\d\d)$/, " '$1") : dayLabel(r.key));
    lineChart($('exChart'), {
      height: 230,
      labels: rows.map(short),
      series: [
        { name: 'Gross profit', values: rows.map(r => r.cur.gp), color: C.s3, area: true },
        { name: 'Last year', values: rows.map(r => (r.prev ? r.prev.gp : 0)), color: C.muted, dashed: true }
      ]
    });
  } else if (EX_ORDERED.has(x.by)) {
    const ordered = rows.slice().sort((a, b) => Number(a.key) - Number(b.key)).filter(r => r.key !== '');
    barChart($('exChart'), {
      height: 220,
      data: ordered.map(r => ({
        label: x.by === 'weekday' ? r.label.slice(0, 3) : x.by === 'hour' ? r.label.replace(' noon', 'p').replace(' am', 'a').replace(' pm', 'p') : r.label,
        value: r.cur.gp, color: r.cur.costedMargin >= T.cur.costedMargin ? C.s3 : C.s2,
        note: `${fmtMoney(r.cur.revenue)} sales, ${r.cur.margin.toFixed(1)}% margin. Last year ${r.prev ? fmtMoney(r.prev.gp) : '-'} gross profit.`
      })),
      valueName: 'Gross profit'
    });
  } else {
    const top = rows.filter(r => r.key !== '' && r.cur.gp > 0).slice(0, 12);
    hbarChart($('exChart'), {
      data: top.map(r => ({
        key: r.key, row: r, label: r.label, value: r.cur.gp,
        color: r.cur.costedMargin >= T.cur.costedMargin ? C.s3 : C.s2,
        note: `${fmtMoney(r.cur.revenue)} sales at ${r.cur.margin.toFixed(1)}% margin. Gross profit ${r.prev ? signed(r.d.gp) + ' on last year' : 'new this period'}.`
      })),
      limit: 12,
      onClick: EX_DRILL[x.by] ? d => drill(d.row) : null
    });
  }

  /* table */
  const cols = [
    { id: 'label', label: EX_NOUN[x.by][0], v: r => (EX_TIME.has(x.by) || EX_ORDERED.has(x.by) ? (EX_ORDERED.has(x.by) ? Number(r.key) : r.key) : r.label.toLowerCase()),
      html: r => `<span class="name">${esc(r.label)}</span>${r.sub && !ex.filter.category ? ` <span class="muted">${esc(r.sub)}</span>` : ''}` },
    { id: 'rev', label: 'Sales', num: true, v: r => r.cur.revenue, html: r => fmtMoney(r.cur.revenue) },
    { id: 'revd', label: 'vs last yr', num: true, v: r => (r.prev && r.prev.revenue ? pctOf(r.cur.revenue, r.prev.revenue) : -1e9),
      html: r => (r.prev && r.prev.revenue ? pctTag(pctOf(r.cur.revenue, r.prev.revenue)) : '<span class="pill">new</span>') },
    { id: 'gp', label: 'Gross profit', num: true, v: r => r.cur.gp, html: r => fmtMoney(r.cur.gp) },
    { id: 'gpd', label: 'Profit change', num: true, v: r => r.d.gp,
      html: r => `<span class="${r.d.gp >= 0 ? 'pos' : 'neg'}">${signedShort(r.d.gp)}</span>` },
    { id: 'why', label: 'Why', v: r => causeOf(r).text,
      html: r => { const c = causeOf(r); return `<span class="pill ${c.good === true ? 'ok' : c.good === false ? 'bad' : ''}" title="${esc(c.tip)}">${esc(c.text)}</span>`; } },
    { id: 'margin', label: 'Margin', num: true, v: r => r.cur.margin,
      html: r => `<span title="Last year ${r.prev ? r.prev.margin.toFixed(1) + '%' : '-'}">${r.cur.margin.toFixed(1)}%</span>` +
        (r.cur.zeroCostPct > 10 ? ` <span class="pill warn" title="${r.cur.zeroCostPct.toFixed(0)}% of these sales are stock with no cost price recorded, so this margin is overstated.">no cost</span>` : '') },
    { id: 'units', label: 'Pieces', num: true, v: r => r.cur.units, html: r => fmtNum(r.cur.units) },
    { id: 'disc', label: 'Discount', num: true, v: r => r.cur.disc,
      html: r => (r.cur.disc ? `${fmtShort(r.cur.disc)} <span class="muted">${r.cur.discRate.toFixed(1)}%</span>` : '<span class="muted">-</span>') },
    { id: 'share', label: 'Share of profit', num: true, v: r => r.gpShare,
      html: r => `<span class="share"><span style="width:${Math.max(0, Math.min(100, r.gpShare))}%"></span></span>${r.gpShare.toFixed(1)}%` }
  ];
  const defaultSort = EX_TIME.has(x.by) || EX_ORDERED.has(x.by) ? { col: 'label', dir: 1 } : { col: 'gp', dir: -1 };

  const drawTable = () => {
    const sort = ex.sort || defaultSort;
    const col = cols.find(c => c.id === sort.col) || cols[3];
    const sorted = rows.slice().sort((a, b) => {
      // Rows with no supplier or size recorded always sink to the bottom.
      if ((a.key === '') !== (b.key === '') && (x.by === 'supplier' || x.by === 'size')) return a.key === '' ? 1 : -1;
      const va = col.v(a), vb = col.v(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
    const limit = EX_TIME.has(x.by) || ex.showAll ? sorted.length : 40;
    const shown = sorted.slice(0, limit);
    const drillable = !!EX_DRILL[x.by];
    $('exTable').innerHTML = `<div class="table-wrap"><table class="explore">
      <thead><tr>${cols.map(c => `<th class="sort ${c.num ? 'num' : ''} ${c.id === sort.col ? (sort.dir > 0 ? 'asc' : 'desc') : ''}" data-col="${c.id}">${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${shown.map((r, i) => `<tr data-i="${i}" class="${drillable ? 'drill' : ''}">${cols.map(c =>
        `<td class="${c.num ? 'num' : ''}">${c.html(r)}</td>`).join('')}</tr>`).join('')}
      <tr class="total"><td><strong>Total</strong></td><td class="num"><strong>${fmtMoney(T.cur.revenue)}</strong></td>
        <td class="num">${pctTag(pctOf(T.cur.revenue, T.prev.revenue))}</td><td class="num"><strong>${fmtMoney(T.cur.gp)}</strong></td>
        <td class="num"><span class="${T.cur.gp - T.prev.gp >= 0 ? 'pos' : 'neg'}">${signedShort(T.cur.gp - T.prev.gp)}</span></td><td></td>
        <td class="num">${T.cur.margin.toFixed(1)}%</td><td class="num">${fmtNum(T.cur.units)}</td>
        <td class="num">${fmtShort(T.cur.disc)}</td><td></td></tr>
      </tbody></table></div>
      ${sorted.length > limit ? `<button class="btn sm" id="exMore" style="margin-top:10px">Show all ${sorted.length} ${EX_NOUN[x.by][1]}</button>` : ''}
      <p class="sowhat"><strong>Why</strong> splits each row's change in gross profit into selling more or less, and earning more or
        less on each rupee sold - hover a pill for the two amounts. "Thinner margin" points at buying rates and discount;
        "sold less" points at stock, sizes and display.</p>`;
    $('exTable').querySelectorAll('th.sort').forEach(th => th.onclick = () => {
      const id = th.dataset.col;
      const cur = ex.sort || defaultSort;
      const numeric = (cols.find(c => c.id === id) || {}).num;
      ex.sort = { col: id, dir: cur.col === id ? -cur.dir : numeric ? -1 : 1 };
      saveEx();
      drawTable();
    });
    if (drillable) {
      $('exTable').querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = () => drill(shown[Number(tr.dataset.i)]));
    }
    const more = $('exMore');
    if (more) more.onclick = () => { ex.showAll = true; saveEx(); drawTable(); };
  };
  drawTable();
}

function fatalInline(el, msg) {
  let m = el.querySelector('.inline-err');
  if (!m) { m = document.createElement('span'); m.className = 'inline-err'; el.appendChild(m); }
  m.textContent = ' ' + msg;
}

function expensesTable(exp, cov) {
  if (!exp || !exp.length) {
    return `<div class="notice bad"><strong>No expenses recorded at all.</strong><br>
      Every profit figure in this app is gross profit only. Start entering rent, salary, electricity,
      transport and daily shop expenses in the POS - it is the single change that makes this page honest.</div>`;
  }
  const total = exp.reduce((a, e) => a + e.amount, 0);
  return `${cov ? `<p class="sowhat" style="margin-top:0;border:0;padding-top:0">
      Recorded on <strong>${cov.daysWithExpense} of ${cov.tradingDays}</strong> recent trading days.
      ${cov.missingDays.length ? `Most recent days with nothing entered: ${cov.missingDays.slice(0, 5).map(esc).join(', ')}.` : ''}
    </p>` : ''}
    <div class="table-wrap"><table>
      <thead><tr><th>Expense head</th><th>Group</th><th class="num">Amount</th><th class="num">Entries</th><th>Last entry</th></tr></thead>
      <tbody>${exp.map(e => `<tr>
        <td class="name">${esc(e.name)}</td><td class="muted">${esc(e.group)}</td>
        <td class="num">${fmtMoney(e.amount)}</td><td class="num">${e.entries}</td>
        <td class="muted">${esc(e.lastEntry || '-')}</td></tr>`).join('')}
        <tr><td colspan="2"><strong>Total</strong></td><td class="num"><strong>${fmtMoney(total)}</strong></td><td colspan="2"></td></tr>
      </tbody></table></div>`;
}

/* ============================================================ PAGE: STOCK */

async function renderStock(host) {
  const [ageing, summary, dead, fast] = await Promise.all([
    get('ageing', () => window.gb.stockAgeing(), 300000),
    get('stockSum', () => window.gb.stockSummary(), 300000),
    get('dead', () => window.gb.deadStock(365, 40), 300000),
    get('fast', () => window.gb.fastMovers(60, 30), 300000)
  ]);

  const bands = ageing ? ageing.bands : [];
  const oldVal = bands.filter(b => b.band === 'Over 2 years' || b.band === '1 to 2 years')
    .reduce((a, b) => a + b.costValue, 0);
  const totalPos = ageing ? ageing.positiveCostValue : 0;
  const oldShare = totalPos ? (oldVal / totalPos) * 100 : 0;
  const urgent = (fast || []).filter(f => !f.oversold && f.coverDays !== null && f.coverDays < 10);

  host.innerHTML = `
    ${verdict(oldShare > 40 ? 'critical' : oldShare > 20 ? 'serious' : 'good',
      `${fmtMoney(oldVal)} of stock has not moved in over a year`,
      `That is <strong>${oldShare.toFixed(0)}%</strong> of everything on your shelves. It was bought with cash
       and it is earning nothing. Clearing even half of it funds the fast sellers below.`)}

    <div class="grid g4" style="margin-bottom:14px">
      ${statTile('Stock at cost', fmtMoney(summary ? summary.costValue : 0), `${fmtNum(summary ? summary.items : 0)} items`)}
      ${statTile('Stock at retail', fmtMoney(summary ? summary.retailValue : 0), 'if every piece sold at full price')}
      ${statTile('Sitting over a year', fmtMoney(oldVal), `${oldShare.toFixed(0)}% of stock value`)}
      ${statTile('Running out soon', fmtNum(urgent.length), 'fast sellers under 10 days cover')}
    </div>

    <div class="grid g2">
      ${card('How long stock has been sitting', '<div id="sAge"></div>' + sowhat(
        'Every bar to the right of the middle is cash you have already spent that has not come back. Healthy shops keep most of their value in the first two bars.'))}
      ${card('Stock value by age', '<div id="sAgeBar"></div>' + sowhat(
        ageing && ageing.oversoldTags
          ? `Note: ${fmtNum(ageing.oversoldTags)} lots show negative stock (${fmtMoney(Math.abs(ageing.oversoldCostValue))}), which is why this total is higher than the net figure above. See Data Health.`
          : 'Totals here count only lots with stock remaining.'))}
    </div>

    <div class="section-title">Clear these first - most cash locked up, longest idle</div>
    ${card('Dead stock', deadTable(dead))}

    <div class="section-title">Reorder these - proven sellers about to run out</div>
    ${card('Fast movers with thin cover', fastTable(fast))}
  `;

  const cols = { 'Under 3 months': C.s3, '3 to 6 months': C.s3, '6 to 12 months': C.s4,
                 '1 to 2 years': C.s2, 'Over 2 years': C.crit, 'Opening (undated)': C.muted };
  stackBar($('sAge'), bands.map(b => ({ label: b.band, value: b.costValue, color: cols[b.band] || C.s1 })));
  barChart($('sAgeBar'), {
    height: 210,
    data: bands.map(b => ({
      label: b.band.replace('Opening (undated)', 'Opening').replace(' months', 'm').replace(' years', 'y').replace('Under 3m', '<3m').replace(' to ', '-'),
      value: b.costValue, color: cols[b.band] || C.s1,
      note: `${fmtNum(b.tags)} lots, ${fmtNum(b.qty)} units`
    })),
    valueName: 'Cost value'
  });
}

function deadTable(dead) {
  if (!dead || !dead.length) return '<p class="empty">Nothing has been idle for over a year. Well run.</p>';
  return `<div class="table-wrap"><table class="sortable">
    <thead><tr><th>Item</th><th>Category</th><th class="num">Qty</th><th class="num">Cost tied up</th>
    <th class="num">At retail</th><th class="num">Idle</th><th class="num">Clear at</th></tr></thead>
    <tbody>${dead.map(d => `<tr>
      <td class="name">${esc(d.name)}</td>
      <td class="muted">${esc(d.category)}</td>
      <td class="num">${fmtNum(d.qty)}</td>
      <td class="num">${fmtMoney(d.costValue)}</td>
      <td class="num muted">${fmtMoney(d.retailValue)}</td>
      <td class="num"><span class="pill ${d.idleDays > 730 ? 'bad' : 'warn'}">${fmtNum(d.idleDays)}d</span></td>
      <td class="num">${fmtMoney(Math.max(d.cost, d.selRate * 0.7))}</td>
    </tr>`).join('')}</tbody></table></div>
    <p class="sowhat">"Clear at" is a suggested floor: the higher of your cost and 30% off the marked price,
    so you release cash without selling below what you paid.</p>`;
}

function fastTable(fast) {
  if (!fast || !fast.length) return '<p class="empty">Nothing is about to run out.</p>';
  const rows = fast.slice(0, 25);
  return `<div class="table-wrap"><table class="sortable">
    <thead><tr><th>Item</th><th>Category</th><th class="num">Sold / day</th><th class="num">On hand</th>
    <th class="num">Days cover</th><th class="num">Buy at</th><th class="num">Margin</th></tr></thead>
    <tbody>${rows.map(f => `<tr>
      <td class="name">${esc(f.name)}</td>
      <td class="muted">${esc(f.category)}</td>
      <td class="num">${f.perDay.toFixed(1)}</td>
      <td class="num">${f.oversold ? `<span class="pill bad">${fmtNum(f.onHand)}</span>` : fmtNum(f.onHand)}</td>
      <td class="num">${f.oversold ? '<span class="pill bad">oversold</span>'
        : `<span class="pill ${f.coverDays < 7 ? 'bad' : f.coverDays < 14 ? 'warn' : 'ok'}">${f.coverDays.toFixed(0)}d</span>`}</td>
      <td class="num muted">${fmtMoney(f.purRate)}</td>
      <td class="num">${f.selRate ? (((f.selRate - f.purRate) / f.selRate) * 100).toFixed(0) + '%' : '-'}</td>
    </tr>`).join('')}</tbody></table></div>
    <p class="sowhat">"Oversold" means the POS shows less than zero in stock - the purchase was never entered.
    Fix those on the Data Health page before ordering, or you will buy blind.</p>`;
}

/* ======================================================== PAGE: SUPPLIERS */

async function renderSuppliers(host) {
  const [pay, sup, recv] = await Promise.all([
    get('pay', () => window.gb.payables(), 300000),
    get('sup', () => window.gb.suppliers(365), 600000),
    get('recv', () => window.gb.receivables(), 300000)
  ]);
  const total = (pay || []).reduce((a, p) => a + p.balance, 0);
  const stale = (pay || []).filter(p => p.daysSincePayment !== null && p.daysSincePayment > 180);
  const staleVal = stale.reduce((a, p) => a + p.balance, 0);
  const recvTotal = (recv || []).reduce((a, r) => a + r.balance, 0);
  const bought = (sup || []).reduce((a, s) => a + s.purchaseValue, 0);

  host.innerHTML = `
    ${verdict(staleVal > total * 0.4 ? 'serious' : 'warning',
      `${fmtMoney(total)} shown as owed to ${(pay || []).length} suppliers`,
      stale.length
        ? `<strong>${fmtMoney(staleVal)}</strong> of that sits with ${stale.length} suppliers who have had no payment
           recorded for over six months. Either those payments happened and were never entered, or they are genuinely
           overdue. Until each one is confirmed against the supplier's own statement, this number cannot be trusted.`
        : `This is the running purchase-ledger balance. Confirm each against the supplier's statement.`)}

    <div class="grid g4" style="margin-bottom:14px">
      ${statTile('Owed to suppliers', fmtMoney(total), `${(pay || []).length} accounts`)}
      ${statTile('Unconfirmed 6 months+', fmtMoney(staleVal), `${stale.length} accounts`)}
      ${statTile('Owed to you', fmtMoney(recvTotal), `${(recv || []).length} customers on credit`)}
      ${statTile('Bought, last 12 months', fmtMoney(bought), `${(sup || []).length} active suppliers`)}
    </div>

    ${card('Who you owe', payTable(pay))}

    <div class="section-title">Which suppliers earn their shelf space</div>
    ${card('Supplier scorecard, last 12 months', supTable(sup) + sowhat(
      'Margin is what their goods actually earn when sold. Sell-through compares what you have sold against what you bought - a low number means stock is still sitting. Supplier can be identified on about 88% of sales, so treat these as strong indicators rather than exact totals.'))}

    ${recvTotal > 0 ? `<div class="section-title">Money customers owe you</div>${card('Receivables', recvTable(recv))}` : ''}
  `;
}

function payTable(pay) {
  if (!pay || !pay.length) return '<p class="empty">Nothing outstanding.</p>';
  return `<div class="table-wrap"><table class="sortable">
    <thead><tr><th>Supplier</th><th class="num">Balance</th><th class="num">Last payment</th>
    <th>Oldest open bill</th><th>Mobile</th></tr></thead>
    <tbody>${pay.slice(0, 40).map(p => `<tr>
      <td class="name">${esc(p.name)}</td>
      <td class="num">${fmtMoney(p.balance)}</td>
      <td class="num">${p.daysSincePayment === null ? '-'
        : `<span class="pill ${p.daysSincePayment > 180 ? 'bad' : p.daysSincePayment > 90 ? 'warn' : 'ok'}">${p.daysSincePayment}d ago</span>`}</td>
      <td class="muted">${esc(p.oldestBill || '-')}</td>
      <td class="muted">${esc(p.mobile || '-')}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="sowhat">Balances run from 2021 and include anything never marked as paid.
    Work down the red rows first - those are the ones most likely to be wrong.</p>`;
}

function supTable(sup) {
  if (!sup || !sup.length) return '<p class="empty">No purchases recorded in this period.</p>';
  return `<div class="table-wrap"><table class="sortable">
    <thead><tr><th>Supplier</th><th class="num">Bought</th><th class="num">Invoices</th>
    <th class="num">Sold (after discount)</th><th class="num">Gross profit</th><th class="num">Margin</th>
    <th class="num">Sell-through</th></tr></thead>
    <tbody>${sup.slice(0, 30).map(s => `<tr>
      <td class="name">${esc(s.name)}</td>
      <td class="num">${fmtMoney(s.purchaseValue)}</td>
      <td class="num muted">${s.invoices}</td>
      <td class="num">${fmtMoney(s.revenue)}</td>
      <td class="num">${fmtMoney(s.grossProfit)}</td>
      <td class="num">${s.marginPct ? `<span class="pill ${s.marginPct < 20 ? 'bad' : s.marginPct < 30 ? 'warn' : 'ok'}">${s.marginPct.toFixed(0)}%</span>` : '-'}</td>
      <td class="num muted">${s.sellThroughPct ? s.sellThroughPct.toFixed(0) + '%' : '-'}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function recvTable(recv) {
  return `<div class="table-wrap"><table class="sortable">
    <thead><tr><th>Customer</th><th class="num">Owes</th><th class="num">Last movement</th><th>Mobile</th></tr></thead>
    <tbody>${recv.slice(0, 25).map(r => `<tr>
      <td class="name">${esc(r.name)}</td>
      <td class="num">${fmtMoney(r.balance)}</td>
      <td class="num">${r.daysSince === null ? '-' : `<span class="pill ${r.daysSince > 90 ? 'bad' : 'warn'}">${r.daysSince}d ago</span>`}</td>
      <td class="muted">${esc(r.mobile || '-')}</td></tr>`).join('')}
    </tbody></table></div>`;
}

/* ======================================================== PAGE: CUSTOMERS */

async function renderCustomers(host) {
  const [cap, recv] = await Promise.all([
    get('cap', () => window.gb.customerCapture(30), 300000),
    get('recv', () => window.gb.receivables(), 300000)
  ]);
  const pct = cap ? cap.pct : 0;

  host.innerHTML = `
    ${verdict(pct < 25 ? 'serious' : 'good',
      pct < 25 ? 'You cannot yet answer who your customers are' : `${pct.toFixed(0)}% of bills have a customer attached`,
      `Only <strong>${cap ? cap.withCustomer : 0} of ${cap ? cap.bills : 0}</strong> bills in the last 30 days recorded
       who bought. Without a name and number you cannot invite anyone back, run a festival offer, or find out who your
       best buyers are. This is the biggest single unlock available to the shop, and it costs nothing but the habit of asking.`)}

    <div class="grid g3" style="margin-bottom:14px">
      ${statTile('Bills with a customer', `${cap ? cap.withCustomer : 0} / ${cap ? cap.bills : 0}`, `${pct.toFixed(1)}% of the last 30 days`)}
      ${statTile('Customers on credit', fmtNum((recv || []).length), 'the only ones you can currently contact')}
      ${statTile('Owed by customers', fmtMoney((recv || []).reduce((a, r) => a + r.balance, 0)), 'across all credit accounts')}
    </div>

    ${card('What to do about it', `
      <div class="action-do">${DO_ICON}<div>
        <strong>Ask for a mobile number on every bill and type it into the POS.</strong>
        It adds about five seconds per sale. At your current rate of roughly
        ${cap && cap.bills ? Math.round(cap.bills / 30) : 25} bills a day, two months of asking builds a list of
        well over a thousand contactable customers.
      </div></div>
      <p class="sowhat">Once the list exists this page becomes genuinely useful: repeat rate, who has not
      visited in 90 days, who spends the most, and which offer brought people back. None of that can be
      calculated from anonymous bills.</p>`)}

    ${(recv && recv.length) ? `<div class="section-title">Customers you can already reach</div>
      ${card('Credit customers', recvTable(recv))}` : ''}
  `;
}

/* =========================================================== PAGE: HEALTH */

async function renderHealth(host) {
  const [h, ageing, cap, cov] = await Promise.all([
    get('health', () => window.gb.dataHealth(), 300000),
    get('ageing', () => window.gb.stockAgeing(), 300000),
    get('cap', () => window.gb.customerCapture(30), 300000),
    get('cov30', () => window.gb.expenseCoverage(30), 300000)
  ]);
  if (!h) throw new Error('Health checks did not return.');
  const expCoverage = cov && cov.tradingDays ? (cov.daysWithExpense / cov.tradingDays) * 100 : 0;

  const checks = [
    { name: 'Accounting ledger balances', value: h.ledgerUnbalancedDays,
      ok: h.ledgerUnbalancedDays === 0,
      good: 'Every day balances to the paisa. Your financial figures are internally consistent.',
      bad: `${h.ledgerUnbalancedDays} day(s) do not balance. Something was edited outside the POS - get this checked before trusting any money figure.`,
      severity: 'critical' },
    { name: 'Stock cache matches the stock ledger', value: h.stockCacheDrift,
      ok: h.stockCacheDrift === 0,
      good: 'The stock figures shown in the POS agree exactly with the movement history.',
      bad: `${h.stockCacheDrift} item(s) disagree. Stock reports are unreliable until the POS vendor rebuilds the cache.`,
      severity: 'critical' },
    { name: 'Purchases linked to stock receipts', value: h.purchaseStockMismatches,
      ok: h.purchaseStockMismatches === 0,
      good: 'Every purchase line has a matching stock receipt.',
      bad: `${h.purchaseStockMismatches} purchase line(s) have no matching stock. Goods were billed but never taken into stock.`,
      severity: 'serious' },
    { name: 'Items with negative stock', value: h.negativeStockItems,
      ok: h.negativeStockItems === 0,
      good: 'No item shows negative stock.',
      bad: `${h.negativeStockItems} items show negative stock, ${fmtNum(Math.abs(h.negativeStockQty))} units short in total. These were sold without a purchase or opening entry, so stock value and margin are understated.`,
      severity: 'warning' },
    { name: 'Duplicate bill records', value: h.duplicateBills,
      ok: h.duplicateBills === 0,
      good: 'No duplicated bills.',
      bad: `${h.duplicateBills} bills are stored twice in the POS bill header table. Grow Board reads money from the accounting ledger instead, so your figures here are unaffected - but POS reports that use the header will overstate.`,
      severity: 'warning' },
    { name: 'Expenses being recorded', value: Math.round(expCoverage),
      ok: expCoverage >= 60,
      good: `Expenses are recorded on ${cov ? cov.daysWithExpense : 0} of ${cov ? cov.tradingDays : 0} recent trading days. Net profit can be calculated.`,
      bad: `Expenses are recorded on only ${cov ? cov.daysWithExpense : 0} of ${cov ? cov.tradingDays : 0} recent trading days (${expCoverage.toFixed(0)}%). Net profit cannot be calculated - every profit figure in this app is gross profit only.`,
      severity: 'critical', link: 'profit' },
    { name: 'Customer captured on bills', value: cap ? Math.round(cap.pct) : 0,
      ok: cap ? cap.pct >= 25 : false,
      good: 'Most bills identify the customer.',
      bad: `Only ${cap ? cap.pct.toFixed(1) : 0}% of bills record who bought. No repeat-customer analysis is possible.`,
      severity: 'serious', link: 'customers' }
  ];

  const failing = checks.filter(c => !c.ok);
  const criticalFail = failing.filter(c => c.severity === 'critical').length;

  host.innerHTML = `
    ${verdict(criticalFail ? 'critical' : failing.length ? 'warning' : 'good',
      criticalFail ? `${criticalFail} serious data problem${criticalFail > 1 ? 's' : ''}`
                   : failing.length ? `${failing.length} things to tidy up` : 'All checks pass',
      h.ledgerUnbalancedDays === 0 && h.stockCacheDrift === 0
        ? 'The two checks that matter most - the accounting ledger and the stock cache - both pass. Sales, margin and stock figures in this app are sound.'
        : 'Core checks are failing. Treat the figures in this app as approximate until they are fixed.')}

    ${checks.map(c => `
      <div class="action ${c.ok ? 'good' : c.severity}">
        <div class="action-head">
          <div class="verdict-icon" style="width:20px;height:20px">${c.ok ? ICON.good : ICON[c.severity]}</div>
          <h3>${esc(c.name)}</h3>
          <span class="chip ${c.ok ? 'good' : c.severity}">${c.ok ? 'pass' : 'attention'}</span>
        </div>
        <p class="action-why">${c.ok ? esc(c.good) : esc(c.bad)}</p>
        ${!c.ok && c.link ? `<div class="action-foot"><button class="btn sm" data-goto="${c.link}">Show me</button></div>` : ''}
      </div>`).join('')}

    ${card('How Grow Board protects your data', `
      <p class="action-why" style="margin:0">
        This application opens the POS database with a <strong>read-only</strong> login and issues only SELECT
        statements. It cannot add, change or delete anything in your POS, by design. Every figure you see is
        calculated live from your data at the moment you look at it - nothing is copied or stored elsewhere.
      </p>
      ${ageing && ageing.oversoldTags ? `<p class="sowhat">
        ${fmtNum(ageing.oversoldTags)} stock lots currently show a negative balance
        (${fmtMoney(Math.abs(ageing.oversoldCostValue))} at cost). That is the gap between stock value counted by lot
        and stock value counted net.</p>` : ''}`)}
  `;
}

/* ========================================================= PAGE: SETTINGS */

async function renderSettings(host) {
  const [cfg, health, ver, hist, upd, hasPw] = await Promise.all([
    window.gb.config().then(unwrap),
    window.gb.health().then(unwrap).catch(() => null),
    window.gb.version().then(unwrap),
    window.gb.notifications().then(unwrap),
    window.gb.updateState().then(unwrap).catch(() => null),
    window.gb.hasPassword().then(unwrap).catch(() => ({ hasPassword: false }))
  ]);
  S.config = cfg;
  const n = cfg.notifications || {};
  const g = cfg.goal || {};
  const a = cfg.app || {};

  host.innerHTML = `
    ${health
      ? `<div class="notice good"><strong>Connected.</strong> ${esc(health.server)} &middot;
         reading financial year <strong>${esc(health.yearDb)}</strong> &middot;
         server time ${new Date(health.serverTime).toLocaleString('en-IN')}</div>`
      : `<div class="notice bad"><strong>Not connected to the POS database.</strong>
         Check that SQL Server is running on ${esc(cfg.sql.server)} and that TCP/IP is enabled.</div>`}

    <div class="grid g2">
      ${card('Daily goal', `
        <div class="field">
          <label for="growthPct">Growth stretch (%)</label>
          <input type="number" id="growthPct" value="${g.growthTargetPct ?? 5}" min="-20" max="50" step="1">
          <div class="help">Added on top of what the same weekday normally brings. 5% is a steady, reachable stretch.</div>
        </div>
        <div class="field">
          <label for="lookback">Weeks of history to use</label>
          <input type="number" id="lookback" value="${g.lookbackWeeks ?? 6}" min="2" max="26" step="1">
          <div class="help">How many recent same-weekdays feed the median. More weeks is steadier, fewer reacts faster.</div>
        </div>
        <div class="field">
          <label for="minGoal">Minimum goal</label>
          <input type="number" id="minGoal" value="${g.minGoal ?? 0}" min="0" step="500">
        </div>`)}

      ${card('Notifications', `
        <div class="field switch">
          <input type="checkbox" id="notifOn" ${n.enabled ? 'checked' : ''}>
          <label for="notifOn" style="margin:0">Send me notifications through the day</label>
        </div>
        <div class="field"><label for="tMorning">Morning goal</label><input type="time" id="tMorning" value="${esc(n.morningGoal || '09:30')}"></div>
        <div class="field"><label for="tMidday">Midday pace check</label><input type="time" id="tMidday" value="${esc(n.middayCheck || '14:00')}"></div>
        <div class="field"><label for="tEvening">Evening push</label><input type="time" id="tEvening" value="${esc(n.eveningPush || '18:00')}"></div>
        <div class="field"><label for="tClosing">Closing result</label><input type="time" id="tClosing" value="${esc(n.closingResult || '21:30')}"></div>
        <button class="btn sm" id="testNotif">Send a test notification</button>`)}
    </div>

    <div class="spacer-16"></div>
    <div class="grid g2">
      ${card('Application', `
        <div class="field switch">
          <input type="checkbox" id="autoStart" ${a.autoStart ? 'checked' : ''}>
          <label for="autoStart" style="margin:0">Start automatically with Windows</label>
        </div>
        <div class="field switch">
          <input type="checkbox" id="startMin" ${a.startMinimised ? 'checked' : ''}>
          <label for="startMin" style="margin:0">Start hidden in the system tray</label>
        </div>
        <div class="field">
          <label for="refreshSec">Refresh every (seconds)</label>
          <input type="number" id="refreshSec" value="${a.refreshSeconds ?? 60}" min="15" max="600" step="15">
        </div>
        <div class="help">Closing the window keeps Grow Board running in the tray so notifications still reach you.
        Quit fully from the tray icon.</div>`)}

      ${card('Connection (read-only)', `
        <div class="field"><label>Server</label><input value="${esc(cfg.sql.server)}" disabled></div>
        <div class="field"><label>Admin database</label><input value="${esc(cfg.sql.adminDb)}" disabled></div>
        <div class="field"><label>Login</label><input value="${esc(cfg.sql.user)}" disabled></div>
        <div class="field">
          <label for="sqlPw">Database password</label>
          <input type="password" id="sqlPw" placeholder="${hasPw && hasPw.hasPassword ? 'Saved on this computer' : 'Not set - enter it to connect'}">
          <div class="help">Kept on this computer only, never in the installer or on GitHub.
          Leave blank to keep the saved one.</div>
        </div>
        <button class="btn sm" id="savePw">Save password and reconnect</button>
        <span id="pwMsg" class="muted" style="margin-left:8px"></span>
        <div class="help" style="margin-top:10px">Grow Board only ever reads - it issues SELECT statements and nothing else.</div>
        <div class="help" style="margin-top:6px">Grow Board ${esc(ver ? ver.version : '')} &middot; Electron ${esc(ver ? ver.electron : '')}</div>`)}
    </div>

    <div class="spacer-16"></div>
    ${card('Updates', updateCard(upd, ver))}

    <div class="spacer-16"></div>
    ${card('Festival dates', festivalCard(cfg), 'used to compare a season with last year\'s season')}

    <div class="spacer-16"></div>
    <button class="btn primary" id="saveSettings">Save settings</button>
    <span id="saveMsg" class="muted" style="margin-left:10px"></span>

    ${hist && hist.length ? `<div class="section-title">Recent notifications</div>
      ${card('Sent', `<div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Message</th></tr></thead>
        <tbody>${hist.slice(0, 20).map(x => `<tr>
          <td class="muted" style="white-space:nowrap">${new Date(x.at).toLocaleString('en-IN')}</td>
          <td><strong>${esc(x.title)}</strong><br><span class="muted">${esc(x.body)}</span></td>
        </tr>`).join('')}</tbody></table></div>`)}` : ''}
  `;

  $('testNotif').onclick = () => window.gb.notifyTest();

  $('savePw').onclick = async () => {
    const pw = $('sqlPw').value;
    if (!pw) { $('pwMsg').textContent = 'Enter a password first.'; return; }
    $('pwMsg').textContent = 'Connecting...';
    const r = await window.gb.setPassword(pw);
    if (r && r.ok) {
      $('pwMsg').textContent = 'Connected.';
      $('sqlPw').value = '';
      clearCache(); updateConnection();
    } else {
      $('pwMsg').textContent = 'Could not connect: ' + ((r && r.error) || 'unknown error');
    }
  };

  const chk = $('checkUpd');
  if (chk) chk.onclick = async () => {
    $('updMsg').textContent = 'Checking...';
    const r = unwrap(await window.gb.updateCheck());
    renderUpdateBar(r);
    $('updMsg').textContent = !r ? 'Check failed.'
      : r.error ? r.error
      : r.downloaded ? `Version ${r.downloaded.version} is ready to install.`
      : r.available ? `Version ${r.available.version} found - downloading.`
      : 'You are on the latest version.';
  };
  const inst = $('installUpd');
  if (inst) inst.onclick = () => window.gb.updateInstall();
  $('saveSettings').onclick = async () => {
    const patch = {
      goal: {
        growthTargetPct: Number($('growthPct').value),
        lookbackWeeks: Number($('lookback').value),
        minGoal: Number($('minGoal').value)
      },
      notifications: {
        enabled: $('notifOn').checked,
        morningGoal: $('tMorning').value,
        middayCheck: $('tMidday').value,
        eveningPush: $('tEvening').value,
        closingResult: $('tClosing').value
      },
      app: {
        autoStart: $('autoStart').checked,
        startMinimised: $('startMin').checked,
        refreshSeconds: Number($('refreshSec').value)
      }
    };
    await window.gb.saveSettings(patch);
    clearCache();
    $('saveMsg').textContent = 'Saved.';
    setTimeout(() => { $('saveMsg').textContent = ''; }, 2500);
    startAutoRefresh();
  };
}

/* =========================================================== app plumbing */

const RENDER = {
  today: renderToday, actions: renderActions, growth: renderGrowth,
  profit: renderProfit, stock: renderStock, suppliers: renderSuppliers,
  customers: renderCustomers, health: renderHealth, settings: renderSettings
};

async function show(page) {
  if (!RENDER[page]) page = 'today';
  S.page = page;
  hideTip();

  document.querySelectorAll('.nav-item').forEach(b =>
    b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const host = $('page-' + page);
  host.classList.add('active');
  $('pageTitle').textContent = PAGES[page].title;
  $('pageSub').textContent = PAGES[page].sub;
  $('scroll').scrollTop = 0;

  host.innerHTML = '<div class="loading">Loading...</div>';
  try { await RENDER[page](host); } catch (e) { fail(host, e); }
  host.querySelectorAll('table.sortable').forEach(makeSortable);
}

async function updateBadges() {
  try {
    const actions = unwrap(await window.gb.actions());
    if (!actions) return;
    S.actions = actions;
    const crit = actions.filter(a => a.severity === 'critical' || a.severity === 'serious').length;
    setBadge('actionBadge', crit, false);
    setBadge('stockBadge', actions.filter(a => a.theme === 'stock').length, true);
    setBadge('healthBadge', actions.filter(a => a.theme === 'data').length, false);
  } catch { /* offline; badges stay hidden */ }
}
function setBadge(id, n, warn) {
  const b = $(id);
  if (!b) return;
  if (n > 0) { b.textContent = n; b.hidden = false; b.classList.toggle('warn', !!warn); }
  else b.hidden = true;
}

async function updateConnection() {
  const h = unwrap(await window.gb.health().catch(() => null));
  const dot = $('connDot'), txt = $('connText');
  if (h) {
    dot.classList.remove('bad');
    txt.textContent = `Live · ${h.yearDb}`;
  } else {
    dot.classList.add('bad');
    txt.textContent = 'Not connected';
  }
}

function startAutoRefresh() {
  if (S.refreshTimer) clearInterval(S.refreshTimer);
  const sec = Math.max(15, (S.config?.app?.refreshSeconds) || 60);
  S.refreshTimer = setInterval(async () => {
    if (S.page === 'today' || S.page === 'actions') {
      clearCache();
      await window.gb.refresh();
      await show(S.page);
    }
    updateConnection();
    updateBadges();
  }, sec * 1000);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('themeBtn').textContent = theme === 'dark' ? 'Light' : 'Dark';
  try { localStorage.setItem('gb-theme', theme); } catch { /* private mode */ }
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('.nav-item');
  if (nav) { show(nav.dataset.page); return; }
  const go = e.target.closest('[data-goto]');
  if (go) { show(go.dataset.goto); }
});

$('refreshBtn').onclick = async () => {
  clearCache();
  await window.gb.refresh();
  await show(S.page);
  updateBadges();
};
$('themeBtn').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
  show(S.page);
};

window.gb.onUpdateState(st => renderUpdateBar(st));
window.gb.onNavigate(page => show(page));
window.gb.onRefresh(async () => { clearCache(); await show(S.page); });

(async function boot() {
  let saved = null;
  try { saved = localStorage.getItem('gb-theme'); } catch { /* ignore */ }
  S.config = unwrap(await window.gb.config().catch(() => null)) || {};
  applyTheme(saved || S.config?.app?.theme || 'dark');
  if (S.config?.business) {
    const c = S.config.business;
    if (c.companyName) $('brandSub').textContent = c.companyName;
  }
  await show('today');
  window.gb.updateState().then(r => renderUpdateBar(unwrap(r))).catch(() => {});
  updateConnection();
  updateBadges();
  startAutoRefresh();
})();

})();
