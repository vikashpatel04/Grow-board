/**
 * Grow Board - charts.
 *
 * Hand-rolled SVG so the app has no chart dependency and follows the house
 * mark specs exactly: 2px lines, 4px rounded data-ends anchored to the
 * baseline, >=8px markers, a 2px surface gap between adjacent fills,
 * recessive grid and axes, selective direct labels (never one per point),
 * and a hover layer on every plotted form.
 *
 * Colours come from CSS custom properties so light/dark swap in one place.
 * Text always wears text tokens, never a series colour.
 */
'use strict';

(function () {

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  return e;
};

const fmtMoney = v => '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN');
const fmtShort = v => {
  const x = Math.abs(Number(v) || 0);
  const s = Number(v) < 0 ? '-' : '';
  if (x >= 10000000) return `${s}₹${(x / 10000000).toFixed(x >= 100000000 ? 0 : 1)}Cr`;
  if (x >= 100000) return `${s}₹${(x / 100000).toFixed(x >= 1000000 ? 0 : 1)}L`;
  if (x >= 1000) return `${s}₹${(x / 1000).toFixed(x >= 100000 ? 0 : 1)}k`;
  return `${s}₹${Math.round(x)}`;
};
const fmtNum = v => Math.round(Number(v) || 0).toLocaleString('en-IN');

/* ---------------------------------------------------------------- tooltip */

let tipEl = null;
function tooltip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'chart-tip';
    tipEl.setAttribute('role', 'status');
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function showTip(html, x, y) {
  const t = tooltip();
  t.innerHTML = html;
  t.style.display = 'block';
  const r = t.getBoundingClientRect();
  let left = x + 14, top = y - r.height - 12;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (top < 8) top = y + 18;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${top}px`;
}
function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

/* --------------------------------------------------------------- niceScale */

function niceMax(v) {
  if (v <= 0) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function gridLines(g, x0, x1, y, value, label) {
  g.appendChild(el('line', { x1: x0, x2: x1, y1: y, y2: y, class: 'grid' }));
  if (label !== false) {
    const t = el('text', { x: x0 - 8, y: y + 4, class: 'axis-label', 'text-anchor': 'end' });
    t.textContent = label;
    g.appendChild(t);
  }
}

/* ------------------------------------------------------------- line chart */

/**
 * Time-series line / area with a crosshair and shared tooltip.
 * @param {HTMLElement} host
 * @param {{labels:string[], series:{name:string,values:number[],color:string,area?:boolean,dashed?:boolean}[],
 *          height?:number, format?:function, yLabel?:string}} opt
 */
function lineChart(host, opt) {
  host.innerHTML = '';
  const labels = opt.labels || [];
  const series = (opt.series || []).filter(s => s && s.values);
  if (!labels.length || !series.length) { host.innerHTML = '<p class="empty">No data for this period.</p>'; return; }

  const H = opt.height || 260;
  const W = Math.max(host.clientWidth || 640, 320);
  const pad = { t: 16, r: 16, b: 28, l: 56 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const fmt = opt.format || fmtShort;

  const allVals = series.flatMap(s => s.values.filter(v => v !== null && !isNaN(v)));
  const max = niceMax(Math.max(...allVals, 0) * 1.08);
  const min = Math.min(0, ...allVals);
  const yOf = v => pad.t + ih - ((v - min) / (max - min || 1)) * ih;
  const xOf = i => pad.l + (labels.length === 1 ? iw / 2 : (i / (labels.length - 1)) * iw);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'none', role: 'img' });
  const g = el('g');
  svg.appendChild(g);

  for (let k = 0; k <= 4; k++) {
    const v = min + ((max - min) * k) / 4;
    gridLines(g, pad.l, W - pad.r, yOf(v), v, fmt(v));
  }

  // x labels: first, middle, last only - never one per point
  const xi = labels.length <= 3 ? labels.map((_, i) => i) : [0, Math.floor(labels.length / 2), labels.length - 1];
  for (const i of xi) {
    const t = el('text', { x: xOf(i), y: H - 8, class: 'axis-label', 'text-anchor': i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle' });
    t.textContent = labels[i];
    g.appendChild(t);
  }

  for (const s of series) {
    const pts = s.values.map((v, i) => [xOf(i), yOf(v === null || isNaN(v) ? min : v)]);
    if (s.area) {
      const d = `M ${pts[0][0]} ${yOf(min)} ` + pts.map(p => `L ${p[0]} ${p[1]}`).join(' ') +
                ` L ${pts[pts.length - 1][0]} ${yOf(min)} Z`;
      g.appendChild(el('path', { d, fill: s.color, 'fill-opacity': 0.12, stroke: 'none' }));
    }
    const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0]} ${p[1]}`).join(' ');
    g.appendChild(el('path', {
      d, fill: 'none', stroke: s.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      'stroke-dasharray': s.dashed ? '5 4' : null
    }));
    // direct label at the final point (selective labelling)
    const last = pts[pts.length - 1];
    if (series.length > 1) {
      const t = el('text', { x: last[0] - 4, y: last[1] - 9, class: 'series-label', 'text-anchor': 'end' });
      t.textContent = s.name;
      g.appendChild(t);
    }
  }

  // hover layer
  const cross = el('line', { class: 'crosshair', y1: pad.t, y2: pad.t + ih, x1: 0, x2: 0, style: 'display:none' });
  g.appendChild(cross);
  const dots = series.map(s => {
    const c = el('circle', { r: 4.5, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2, style: 'display:none' });
    g.appendChild(c); return c;
  });
  const hit = el('rect', { x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent' });
  g.appendChild(hit);

  hit.addEventListener('mousemove', (ev) => {
    const box = svg.getBoundingClientRect();
    const rel = ((ev.clientX - box.left) / box.width) * W;
    let i = Math.round(((rel - pad.l) / iw) * (labels.length - 1));
    i = Math.max(0, Math.min(labels.length - 1, i));
    cross.setAttribute('x1', xOf(i)); cross.setAttribute('x2', xOf(i));
    cross.style.display = '';
    series.forEach((s, k) => {
      dots[k].setAttribute('cx', xOf(i));
      dots[k].setAttribute('cy', yOf(s.values[i] || 0));
      dots[k].style.display = '';
    });
    const rows = series.map(s =>
      `<div class="tip-row"><span class="tip-dot" style="background:${s.color}"></span>
       <span class="tip-name">${s.name}</span><span class="tip-val">${fmt(s.values[i])}</span></div>`).join('');
    showTip(`<div class="tip-title">${labels[i]}</div>${rows}`, ev.clientX, ev.clientY);
  });
  hit.addEventListener('mouseleave', () => {
    cross.style.display = 'none'; dots.forEach(d => d.style.display = 'none'); hideTip();
  });

  host.appendChild(svg);
  if (series.length > 1) host.appendChild(legend(series));
}

/* -------------------------------------------------------------- bar chart */

/** Vertical bars. 4px rounded top, anchored to the baseline, 2px gap. */
function barChart(host, opt) {
  host.innerHTML = '';
  const data = opt.data || [];
  if (!data.length) { host.innerHTML = '<p class="empty">No data for this period.</p>'; return; }

  const H = opt.height || 240;
  const W = Math.max(host.clientWidth || 640, 320);
  const pad = { t: 18, r: 12, b: 30, l: 56 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const fmt = opt.format || fmtShort;
  const color = opt.color || 'var(--series-1)';

  const max = niceMax(Math.max(...data.map(d => d.value), 0) * 1.1);
  const yOf = v => pad.t + ih - (v / (max || 1)) * ih;
  const slot = iw / data.length;
  const bw = Math.max(4, Math.min(opt.maxBarWidth || 46, slot - 2)); // 2px surface gap

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'none', role: 'img' });
  const g = el('g'); svg.appendChild(g);

  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4;
    gridLines(g, pad.l, W - pad.r, yOf(v), v, fmt(v));
  }

  data.forEach((d, i) => {
    const x = pad.l + slot * i + (slot - bw) / 2;
    const y = yOf(d.value);
    const h = Math.max(0, pad.t + ih - y);
    const c = d.color || color;
    const rect = el('rect', { x, y, width: bw, height: h, rx: 4, ry: 4, fill: c, class: 'bar' });
    g.appendChild(rect);
    rect.addEventListener('mousemove', ev =>
      showTip(`<div class="tip-title">${d.label}</div>
               <div class="tip-row"><span class="tip-dot" style="background:${c}"></span>
               <span class="tip-name">${opt.valueName || 'Value'}</span>
               <span class="tip-val">${fmt(d.value)}</span></div>${d.note ? `<div class="tip-note">${d.note}</div>` : ''}`,
        ev.clientX, ev.clientY));
    rect.addEventListener('mouseleave', hideTip);

    if (data.length <= 14) {
      const t = el('text', { x: x + bw / 2, y: H - 10, class: 'axis-label', 'text-anchor': 'middle' });
      t.textContent = d.label;
      g.appendChild(t);
    }
  });

  // direct-label the peak only (selective labelling, and the relief rule for
  // low-contrast fills on light surfaces)
  const peak = data.reduce((a, b, i) => (b.value > data[a].value ? i : a), 0);
  if (data[peak].value > 0) {
    const x = pad.l + slot * peak + slot / 2;
    const t = el('text', { x, y: yOf(data[peak].value) - 7, class: 'series-label', 'text-anchor': 'middle' });
    t.textContent = fmt(data[peak].value);
    g.appendChild(t);
  }

  host.appendChild(svg);
}

/* ------------------------------------------------- horizontal bar (ranked) */

function hbarChart(host, opt) {
  host.innerHTML = '';
  const data = (opt.data || []).slice(0, opt.limit || 10);
  if (!data.length) { host.innerHTML = '<p class="empty">Nothing to show.</p>'; return; }
  const fmt = opt.format || fmtShort;
  const max = Math.max(...data.map(d => Math.abs(d.value)), 1);

  const wrap = document.createElement('div');
  wrap.className = 'hbar-wrap';
  for (const d of data) {
    const row = document.createElement('div');
    row.className = 'hbar-row';
    const c = d.color || opt.color || 'var(--series-1)';
    row.innerHTML = `
      <div class="hbar-label" title="${esc(d.label)}">${esc(d.label)}</div>
      <div class="hbar-track">
        <div class="hbar-fill" style="width:${(Math.abs(d.value) / max) * 100}%;background:${c}"></div>
      </div>
      <div class="hbar-value">${fmt(d.value)}</div>`;
    if (d.note) {
      row.title = d.note;
      row.addEventListener('mousemove', ev => showTip(
        `<div class="tip-title">${esc(d.label)}</div><div class="tip-note">${esc(d.note)}</div>`, ev.clientX, ev.clientY));
      row.addEventListener('mouseleave', hideTip);
    }
    wrap.appendChild(row);
  }
  host.appendChild(wrap);
}

/* ----------------------------------------------------------------- legend */

function legend(series) {
  const d = document.createElement('div');
  d.className = 'legend';
  d.innerHTML = series.map(s =>
    `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${esc(s.name)}</span>`
  ).join('');
  return d;
}

/* --------------------------------------------------------------- sparkline */

function sparkline(host, values, color) {
  host.innerHTML = '';
  const v = (values || []).filter(x => x !== null && !isNaN(x));
  if (v.length < 2) return;
  const W = 120, H = 30;
  const max = Math.max(...v), min = Math.min(...v);
  const xOf = i => (i / (v.length - 1)) * W;
  const yOf = x => H - 2 - ((x - min) / (max - min || 1)) * (H - 4);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spark' });
  svg.appendChild(el('path', {
    d: v.map((x, i) => `${i ? 'L' : 'M'} ${xOf(i)} ${yOf(x)}`).join(' '),
    fill: 'none', stroke: color || 'var(--series-1)', 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round'
  }));
  host.appendChild(svg);
}

/* ---------------------------------------------------------- progress ring */

/** The goal ring on the Today page - a single hero figure, not a chart. */
function progressRing(host, pctValue, opt = {}) {
  host.innerHTML = '';
  const size = opt.size || 168, sw = opt.stroke || 13;
  const r = (size - sw) / 2, c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1.5, (pctValue || 0) / 100));
  const shown = Math.min(1, p);
  const color = opt.color || (p >= 1 ? 'var(--status-good)' : p >= 0.7 ? 'var(--series-1)' : 'var(--status-warning)');

  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, class: 'ring', width: size, height: size });
  svg.appendChild(el('circle', {
    cx: size / 2, cy: size / 2, r, fill: 'none',
    stroke: 'var(--ring-track)', 'stroke-width': sw
  }));
  svg.appendChild(el('circle', {
    cx: size / 2, cy: size / 2, r, fill: 'none', stroke: color, 'stroke-width': sw,
    'stroke-dasharray': `${c * shown} ${c}`, 'stroke-linecap': 'round',
    transform: `rotate(-90 ${size / 2} ${size / 2})`
  }));
  if (p > 1) {
    svg.appendChild(el('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--status-good)',
      'stroke-width': sw, 'stroke-dasharray': `${c * (p - 1)} ${c}`, 'stroke-linecap': 'round',
      transform: `rotate(-90 ${size / 2} ${size / 2})`, opacity: 0.55
    }));
  }
  host.appendChild(svg);

  const lab = document.createElement('div');
  lab.className = 'ring-label';
  lab.innerHTML = `<div class="ring-pct">${Math.round(pctValue || 0)}%</div>
                   <div class="ring-sub">${esc(opt.sub || 'of goal')}</div>`;
  host.appendChild(lab);
}

/* ------------------------------------------------------------ stacked bar */

/** One-row composition bar (tender mix, ageing). 2px gap between segments. */
function stackBar(host, parts, opt = {}) {
  host.innerHTML = '';
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0);
  if (!total) { host.innerHTML = '<p class="empty">Nothing recorded.</p>'; return; }
  const fmt = opt.format || fmtShort;

  const bar = document.createElement('div');
  bar.className = 'stack-bar';
  for (const p of parts) {
    if (p.value <= 0) continue;
    const seg = document.createElement('div');
    seg.className = 'stack-seg';
    seg.style.width = `${(p.value / total) * 100}%`;
    seg.style.background = p.color;
    seg.addEventListener('mousemove', ev => showTip(
      `<div class="tip-title">${esc(p.label)}</div>
       <div class="tip-row"><span class="tip-dot" style="background:${p.color}"></span>
       <span class="tip-name">${fmt(p.value)}</span>
       <span class="tip-val">${((p.value / total) * 100).toFixed(0)}%</span></div>`, ev.clientX, ev.clientY));
    seg.addEventListener('mouseleave', hideTip);
    bar.appendChild(seg);
  }
  host.appendChild(bar);

  const key = document.createElement('div');
  key.className = 'stack-key';
  key.innerHTML = parts.filter(p => p.value > 0).map(p =>
    `<span class="legend-item"><span class="legend-dot" style="background:${p.color}"></span>
     ${esc(p.label)} <strong>${fmt(p.value)}</strong></span>`).join('');
  host.appendChild(key);
}

/* ------------------------------------------------------------------ utils */

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.GBCharts = {
  lineChart, barChart, hbarChart, sparkline, progressRing, stackBar,
  fmtMoney, fmtShort, fmtNum, esc, hideTip
};

})();
