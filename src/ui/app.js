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
  growth:    { title: 'Growth', sub: 'Where sales are going, and which days and hours carry them' },
  profit:    { title: 'Profit', sub: 'What you actually keep after cost, discount and expense' },
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
const isoToday = () => new Date().toISOString().slice(0, 10);
function isoDaysAgo(k) { const d = new Date(); d.setDate(d.getDate() - k); return d.toISOString().slice(0, 10); }

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

async function renderGrowth(host) {
  const [series, wd, monthly, profile] = await Promise.all([
    get('series90', () => window.gb.series(isoDaysAgo(90), isoToday()), 120000),
    get('weekday', () => window.gb.weekday(), 600000),
    get('monthly', () => window.gb.monthly(), 900000),
    get('hourProfile', () => window.gb.hourlyProfile(), 600000)
  ]);
  const s = series || [];
  const last30 = s.slice(-30).reduce((a, d) => a + d.revenue, 0);
  const prev30 = s.slice(-60, -30).reduce((a, d) => a + d.revenue, 0);
  const growth = prev30 ? ((last30 - prev30) / prev30) * 100 : 0;
  const state = growth > 3 ? 'good' : growth < -3 ? 'serious' : 'warning';

  const active = (wd || []).filter(w => w.days >= 3);
  const bestDay = active.slice().sort((a, b) => b.avgRevenue - a.avgRevenue)[0];
  const worstDay = active.slice().sort((a, b) => a.avgRevenue - b.avgRevenue)[0];
  const avgDay = active.length ? active.reduce((a, w) => a + w.avgRevenue, 0) / active.length : 0;

  host.innerHTML = `
    ${verdict(state,
      growth >= 0 ? `Sales are up ${growth.toFixed(0)}% on the previous month`
                  : `Sales are down ${Math.abs(growth).toFixed(0)}% on the previous month`,
      `Last 30 trading days brought <strong>${fmtMoney(last30)}</strong> against <strong>${fmtMoney(prev30)}</strong> in the 30 before.`)}

    <div class="grid g4" style="margin-bottom:14px">
      ${statTile('Last 30 days', fmtMoney(last30), deltaTag(last30, prev30) + ' vs previous 30')}
      ${statTile('Best day of week', bestDay ? bestDay.name : '-', bestDay ? `${fmtMoney(bestDay.avgRevenue)} on average` : '')}
      ${statTile('Weakest day', worstDay ? worstDay.name : '-', worstDay ? `${fmtMoney(worstDay.avgRevenue)} - ${(((avgDay - worstDay.avgRevenue) / (avgDay || 1)) * 100).toFixed(0)}% below normal` : '')}
      ${statTile('Busiest hour', profile && profile.length ? hourName(profile.slice().sort((a, b) => b.avgAmount - a.avgAmount)[0].hour) : '-', 'Staff and stock for it')}
    </div>

    ${card('Daily revenue, last 90 days', '<div id="g90"></div>' + sowhat(
      growth >= 0
        ? `The trend is upward. Protect what is working: the categories on the Profit page are where it is coming from.`
        : `The trend is downward. Before spending on promotion, check the Stock page - running out of fast sellers is the most common cause.`))}

    <div class="spacer-16"></div>
    <div class="grid g2">
      ${card('Which day of the week earns most', '<div id="gWeek"></div>' + sowhat(
        worstDay && bestDay
          ? `<strong>${esc(worstDay.name)}</strong> is worth about ${fmtMoney(bestDay.avgRevenue - worstDay.avgRevenue)} less than <strong>${esc(bestDay.name)}</strong>. Same rent, same staff - that gap is the cheapest growth you can buy.`
          : 'Not enough history yet.'))}
      ${card('Which hour earns most', '<div id="gHour"></div>' + sowhat(
        'The shop is open all day but earns in bursts. Make sure your best staff and freshest display are on the floor during the tall bars.'))}
    </div>

    <div class="spacer-16"></div>
    ${card('Month by month, across financial years', '<div id="gMonthly"></div>' + sowhat(
      'Use this for seasonality - festival months repeat every year, so plan buying against the same month last year, not against last month.'))}
  `;

  const d90 = s.slice(-90);
  lineChart($('g90'), {
    height: 250,
    labels: d90.map(d => dayLabel(d.date)),
    series: [{ name: 'Revenue', values: d90.map(d => d.revenue), color: C.s1, area: true }]
  });

  barChart($('gWeek'), {
    height: 210,
    data: active.map(w => ({
      label: w.name.slice(0, 3), value: w.avgRevenue,
      note: `${w.days} days recorded`,
      color: w.avgRevenue >= avgDay ? C.s3 : C.s2
    })),
    valueName: 'Average'
  });

  barChart($('gHour'), {
    height: 210,
    data: (profile || []).map(p => ({
      label: p.hour > 12 ? `${p.hour - 12}p` : p.hour === 12 ? '12p' : `${p.hour}a`,
      value: p.avgAmount, note: `${p.bills} bills`, color: C.s1
    })),
    valueName: 'Average'
  });

  const byFy = {};
  for (const m of (monthly || [])) (byFy[m.fy] = byFy[m.fy] || []).push(m);
  const fys = Object.keys(byFy).sort().slice(-3);
  const months = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
  const order = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
  const cols = [C.s1, C.s2, C.s3];
  lineChart($('gMonthly'), {
    height: 240,
    labels: months,
    series: fys.map((fy, i) => ({
      name: `FY ${fy}`, color: cols[i % cols.length],
      values: order.map(mo => { const r = byFy[fy].find(x => x.month === mo); return r ? r.revenue : null; })
    }))
  });
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

function statTile(label, value, foot) {
  return `<div class="card"><div class="stat">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value sm">${value}</div>
    <div class="stat-foot">${foot || ''}</div></div></div>`;
}

/* =========================================================== PAGE: PROFIT */

async function renderProfit(host) {
  const [cats, cogs, series, exp, cov, disc] = await Promise.all([
    get('cats90', () => window.gb.categories(90), 300000),
    get('cogs90', () => window.gb.cogs(isoDaysAgo(90), isoToday()), 300000),
    get('series90', () => window.gb.series(isoDaysAgo(90), isoToday()), 120000),
    get('exp90', () => window.gb.expenses(90), 300000),
    get('cov30', () => window.gb.expenseCoverage(30), 300000),
    get('disc90', () => window.gb.discounts(90), 300000)
  ]);

  const taxable = (cogs || []).reduce((a, d) => a + d.taxable, 0);
  const cost = (cogs || []).reduce((a, d) => a + d.cogs, 0);
  const gp = taxable - cost;
  const marginPct = taxable ? (gp / taxable) * 100 : 0;
  const discount = (series || []).reduce((a, d) => a + d.discount, 0);
  const expTotal = (exp || []).reduce((a, e) => a + e.amount, 0);
  const coverage = cov && cov.tradingDays ? (cov.daysWithExpense / cov.tradingDays) * 100 : 0;
  const expensesUnreliable = coverage < 60;

  host.innerHTML = `
    ${expensesUnreliable
      ? verdict('critical', 'Your real profit is unknown',
          `Gross profit over 90 days is <strong>${fmtMoney(gp)}</strong>, but expenses are recorded on only
           <strong>${cov ? cov.daysWithExpense : 0} of ${cov ? cov.tradingDays : 0}</strong> recent trading days
           (${fmtMoney(expTotal)} in total). Until every expense is entered in the POS, net profit cannot be calculated.`)
      : verdict(marginPct > 30 ? 'good' : 'warning', `Gross margin is ${marginPct.toFixed(1)}%`,
          `<strong>${fmtMoney(gp)}</strong> earned on <strong>${fmtMoney(taxable)}</strong> of goods over 90 days,
           before <strong>${fmtMoney(expTotal)}</strong> of recorded expenses.`)}

    <div class="grid g4" style="margin-bottom:14px">
      ${statTile('Goods sold (90d)', fmtMoney(taxable), 'excluding GST')}
      ${statTile('Cost of those goods', fmtMoney(cost), 'from the cost stamped on each sale')}
      ${statTile('Gross profit', fmtMoney(gp), `${marginPct.toFixed(1)}% margin`)}
      ${statTile('Discount given away', fmtMoney(discount),
        taxable ? `${((discount / (taxable + discount)) * 100).toFixed(1)}% of what you could have billed` : '')}
    </div>

    ${card('Profit by category, last 90 days', '<div id="pCat"></div>' + sowhat(
      'The long bars are where your profit actually comes from. A category with big sales but a short bar is doing work for very little reward.'))}

    <div class="spacer-16"></div>
    <div class="grid g2">
      ${card('Margin % by category', '<div id="pMargin"></div>' + sowhat(
        `Shop average is <strong>${marginPct.toFixed(1)}%</strong>. Anything well below it is either bought too dear or sold too cheap - both are fixable this week.`))}
      ${card('Where discount is leaking', '<div id="pDisc"></div>' + sowhat(
        discount > 0
          ? `Discount comes straight off profit. Halving this would add about <strong>${fmtMoney(discount / 2)}</strong> a quarter with no extra sales needed.`
          : 'No discount recorded in this period.'))}
    </div>

    <div class="spacer-16"></div>
    ${card('Recorded expenses', expensesTable(exp, cov), 'from the POS ledger')}
  `;

  const top = (cats || []).filter(c => c.revenue > 0).slice(0, 12);
  hbarChart($('pCat'), {
    data: top.map(c => ({
      label: c.category, value: c.grossProfit, color: C.s3,
      note: `${fmtMoney(c.revenue)} sales, ${c.marginPct.toFixed(1)}% margin, ${fmtNum(c.units)} units`
    })),
    limit: 12
  });

  hbarChart($('pMargin'), {
    data: top.slice(0, 10).map(c => ({
      label: c.category, value: c.marginPct,
      color: c.marginPct >= marginPct ? C.s3 : C.s2,
      note: `${fmtMoney(c.grossProfit)} gross profit on ${fmtMoney(c.revenue)}`
    })),
    format: v => `${v.toFixed(1)}%`, limit: 10
  });

  hbarChart($('pDisc'), {
    data: (disc || []).slice(0, 10).map(d => ({
      label: d.category, value: d.discount, color: C.s2,
      note: `${d.discountPct.toFixed(1)}% of billable value on ${fmtNum(d.discountedUnits)} discounted units`
    })),
    limit: 10
  });
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
      <thead><tr><th>Expense head</th><th>Group</th><th class="num">Amount (90d)</th><th class="num">Entries</th><th>Last entry</th></tr></thead>
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
  return `<div class="table-wrap"><table>
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
  return `<div class="table-wrap"><table>
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
      ${statTile('Bought this year', fmtMoney(bought), `${(sup || []).length} active suppliers`)}
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
  return `<div class="table-wrap"><table>
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
  return `<div class="table-wrap"><table>
    <thead><tr><th>Supplier</th><th class="num">Bought</th><th class="num">Invoices</th>
    <th class="num">Sold (revenue)</th><th class="num">Gross profit</th><th class="num">Margin</th>
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
  return `<div class="table-wrap"><table>
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
