/**
 * Grow Board - periods and festivals.
 *
 * A textile shop's year is shaped by festivals, and the big ones move:
 * Deepavali was 20 Oct in 2025 and falls on 8 Nov in 2026. Comparing the same
 * dates a year apart then sets a festival rush against an ordinary fortnight,
 * and the growth figure says more about the calendar than about the shop.
 *
 * Every comparison window in the app is chosen here, so the rule lives in one
 * place:
 *   - long windows (a whole year so far) compare the same dates last year, and
 *     say so when a festival season sits inside one window but not the other
 *   - short windows near a festival are aligned on the festival, so this year's
 *     run-up is compared with last year's run-up
 *
 * Dates are local calendar dates as 'YYYY-MM-DD' strings throughout.
 */
'use strict';

const DAY = 86400000;

const parse = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => iso(new Date());
const addDays = (s, k) => { const d = parse(s); d.setDate(d.getDate() + k); return iso(d); };
/** Same calendar date k years on; 29 Feb falls back to 28 Feb. */
function addYears(s, k) {
  const d = parse(s);
  const day = d.getDate();
  d.setDate(1);
  d.setFullYear(d.getFullYear() + k);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return iso(d);
}
/** Whole days from a to b (positive when b is later). */
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / DAY);
const isIso = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Indian financial year: 1 April to 31 March. */
function fyStart(s) {
  const d = parse(s);
  return `${d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1}-04-01`;
}
function fyLabel(s) {
  const a = Number(fyStart(s).slice(2, 4));
  return `${String(a).padStart(2, '0')}-${String((a + 1) % 100).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = s => { const d = parse(s); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const fmtShort = s => { const d = parse(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const fmtRange = (a, b) => (a.slice(0, 4) === b.slice(0, 4) ? `${fmtShort(a)} – ${fmt(b)}` : `${fmt(a)} – ${fmt(b)}`);

/* -------------------------------------------------------------- festivals */

/** Every festival occurrence in config, oldest first. */
function festivals(config) {
  const list = (config && config.festivals && config.festivals.list) || [];
  const out = [];
  for (const f of list) {
    for (const d of (f.dates || [])) {
      if (isIso(d)) out.push({ name: f.name, date: d, leadDays: Math.max(1, Number(f.leadDays) || 21) });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** The season: the shopping run-up to a festival, festival day included. */
const seasonOf = occ => ({ from: addDays(occ.date, -(occ.leadDays - 1)), to: occ.date });

/** The same festival a year earlier - the occurrence within six weeks of the anniversary. */
function previousOccurrence(occ, config) {
  const target = addYears(occ.date, -1);
  return festivals(config).find(f => f.name === occ.name && Math.abs(daysBetween(target, f.date)) <= 45) || null;
}

/** Season days that fall inside [from,to], by festival name. */
function seasonDaysIn(from, to, config) {
  const out = {};
  for (const f of festivals(config)) {
    const s = seasonOf(f);
    const a = from > s.from ? from : s.from;
    const b = to < s.to ? to : s.to;
    if (a <= b) out[f.name] = (out[f.name] || 0) + daysBetween(a, b) + 1;
  }
  return out;
}

/** Every season range that overlaps [from,to]. */
function seasonsOverlapping(from, to, config) {
  return festivals(config).map(f => ({ ...seasonOf(f), name: f.name, date: f.date }))
    .filter(s => s.from <= to && s.to >= from);
}

/** Returns date => festival name, or null when the date is an ordinary trading day. */
function seasonLookup(config) {
  const seasons = festivals(config).map(f => ({ ...seasonOf(f), name: f.name }));
  return date => { const s = seasons.find(x => date >= x.from && date <= x.to); return s ? s.name : null; };
}

/**
 * Where two windows hold different amounts of festival season. A gap of a few
 * days is noise; a gap of a week or more is enough to swing the comparison.
 */
function seasonGap(cur, cmp, config, minDays = 3) {
  const a = seasonDaysIn(cur.from, cur.to, config);
  const b = seasonDaysIn(cmp.from, cmp.to, config);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .map(name => ({ name, curDays: a[name] || 0, cmpDays: b[name] || 0 }))
    .filter(g => Math.abs(g.curDays - g.cmpDays) >= minDays);
}

/** `ongoing` is true when the window runs up to today, so "so far" reads right. */
function gapNote(gaps, ongoing = true) {
  if (!gaps.length) return null;
  const dd = k => `${k} day${k === 1 ? '' : 's'}`;
  return gaps.map(g => {
    if (!ongoing) {
      return `The comparison period has ${g.cmpDays ? dd(g.cmpDays) : 'no days'} of the ${g.name} run-up; this one has ${g.curDays ? dd(g.curDays) : 'none'}.`;
    }
    return g.cmpDays > g.curDays
      ? `Last year's dates include ${dd(g.cmpDays)} of the ${g.name} run-up; this year's include ${g.curDays ? dd(g.curDays) + ' so far' : 'none yet'}.`
      : `This year's dates include ${dd(g.curDays)} of the ${g.name} run-up; last year's include ${g.cmpDays ? dd(g.cmpDays) : 'none'}.`;
  }).join(' ');
}

/* -------------------------------------------------------- compare windows */

/**
 * The window to compare [from,to] against.
 * A window of up to 120 days with a festival in it, or within 75 days after
 * it, is aligned on that festival. Everything else is the same dates last year.
 */
function compareWindow(from, to, config, opts = {}) {
  const len = daysBetween(from, to) + 1;
  const cal = { from: addYears(from, -1), to: addYears(to, -1), basis: 'calendar' };
  const finish = c => {
    const note = c.basis === 'festival'
      ? `Aligned on ${c.festival}: ${fmt(c.festivalDate)} this year, ${fmt(c.prevFestivalDate)} last year.`
      : gapNote(seasonGap({ from, to }, c, config), to >= addDays(today(), -1));
    return { ...c, days: daysBetween(c.from, c.to) + 1, label: fmtRange(c.from, c.to), note };
  };
  if (opts.calendar || len > 120) return finish(cal);

  const near = festivals(config)
    .filter(f => f.date >= from && daysBetween(to, f.date) <= 75)
    .sort((a, b) => Math.abs(daysBetween(to, a.date)) - Math.abs(daysBetween(to, b.date)))[0];
  if (!near) return finish(cal);
  const prev = previousOccurrence(near, config);
  if (!prev) return finish(cal);
  const shift = daysBetween(prev.date, near.date);
  // Within a few days of the anniversary the calendar already lines the seasons up.
  if (Math.abs(shift - daysBetween(cal.from, from)) <= 3) return finish(cal);
  return finish({
    from: addDays(from, -shift), to: addDays(to, -shift), basis: 'festival',
    festival: near.name, festivalDate: near.date, prevFestivalDate: prev.date
  });
}

/** A ready-made period for the Profit page, with its comparison. */
function windowFor(from, to, config, opts = {}) {
  return { from, to, label: fmtRange(from, to), days: daysBetween(from, to) + 1, cmp: compareWindow(from, to, config, opts) };
}

/**
 * The period presets the Profit page offers. Everything ends yesterday, so a
 * part-day never sits against a full day last year.
 */
function presets(config, now = new Date()) {
  const t = iso(now);
  const end = addDays(t, -1);
  const fy = fyStart(t);
  const list = [];
  const push = (id, name, group, from, to, opts) => {
    if (from > to) return;
    list.push({ id, name, group, ...windowFor(from, to, config, opts) });
  };

  push('fytd', `This year so far (FY ${fyLabel(t)})`, 'period', fy, fy > end ? t : end, { calendar: true });
  push('last30', 'Last 30 days', 'period', addDays(end, -29), end);
  push('last90', 'Last 90 days', 'period', addDays(end, -89), end);
  const m0 = `${t.slice(0, 7)}-01`;
  push('thisMonth', 'This month so far', 'period', m0, end < m0 ? t : end, { calendar: true });
  const lm = addDays(m0, -1);
  push('lastMonth', 'Last month', 'period', `${lm.slice(0, 7)}-01`, lm, { calendar: true });
  push('lastFy', `Last year (FY ${fyLabel(addDays(fy, -1))})`, 'period', addYears(fy, -1), addDays(fy, -1), { calendar: true });

  // Festival seasons from the last two years, newest first, each against the
  // same festival's season a year earlier - day for day into the run-up.
  for (const f of festivals(config).slice().reverse()) {
    const s = seasonOf(f);
    if (s.from > end || daysBetween(s.to, end) > 760) continue;
    const to = s.to < end ? s.to : end;
    const prev = previousOccurrence(f, config);
    const going = to < s.to;
    const item = {
      id: `season:${f.name}:${f.date}`,
      name: `${f.name} ${f.date.slice(0, 4)} season${going ? ' so far' : ''}`,
      group: 'season', from: s.from, to, label: fmtRange(s.from, to), days: daysBetween(s.from, to) + 1,
      festival: f.name, festivalDate: f.date
    };
    if (prev) {
      const ps = seasonOf(prev);
      const pto = addDays(ps.from, daysBetween(s.from, to));
      item.cmp = {
        from: ps.from, to: pto, basis: 'festival', festival: f.name, festivalDate: f.date, prevFestivalDate: prev.date,
        days: daysBetween(ps.from, pto) + 1, label: fmtRange(ps.from, pto),
        note: `Compared with the ${f.name} ${prev.date.slice(0, 4)} season, day for day into the run-up.`
      };
    } else {
      item.cmp = compareWindow(s.from, to, config, { calendar: true });
    }
    list.push(item);
  }
  return list;
}

/** The next festival whose season has not finished, within `aheadDays`. */
function upcoming(config, aheadDays = 75, now = new Date()) {
  const t = iso(now);
  return festivals(config).find(f => f.date >= t && daysBetween(t, f.date) <= aheadDays) || null;
}

module.exports = {
  parse, iso, today, addDays, addYears, daysBetween, isIso, fyStart, fyLabel,
  fmt, fmtShort, fmtRange, MONTHS,
  festivals, seasonOf, previousOccurrence, seasonDaysIn, seasonsOverlapping, seasonLookup,
  seasonGap, gapNote, compareWindow, windowFor, presets, upcoming
};
