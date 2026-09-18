/**
 * Grow Board - automatic daily goal.
 *
 * The goal must be *explainable*, not a black box. Every goal carries the
 * working that produced it, so the shop can see why today's number is what
 * it is and argue with it.
 *
 * Method:
 *   1. Base   - median revenue of the same weekday over the last N weeks.
 *               Median, not mean, so one festival day does not set the bar.
 *   2. Trend  - ratio of the last 4 weeks to the 4 weeks before that.
 *               Capped to +/-25% so a quiet fortnight cannot collapse the goal.
 *   3. Growth - the configured stretch (default +5%).
 *   4. Floor  - never below config.goal.minGoal.
 */
'use strict';

const M = require('./metrics');

const median = arr => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sum = arr => arr.reduce((a, b) => a + b, 0);

/**
 * Compute today's goal from history.
 * @returns {{goal:number, base:number, trendPct:number, growthPct:number,
 *            explain:string[], sampleDays:number, weekday:string, confidence:string}}
 */
async function dailyGoal(config, forDate = new Date()) {
  const cfg = config.goal || {};
  const lookbackWeeks = cfg.lookbackWeeks || 6;
  const growthPct = cfg.growthTargetPct === undefined ? 5 : cfg.growthTargetPct;
  const minGoal = cfg.minGoal || 0;

  const target = new Date(forDate); target.setHours(0, 0, 0, 0);
  const weekday = target.getDay();
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Pull a wide window once; everything below is derived from it.
  const from = M.iso(M.daysAgo(70));
  const to = M.iso(new Date(target.getTime() - 86400000));
  const series = await M.dailySeries(from, to);

  const sameWeekday = series
    .filter(d => new Date(d.date + 'T00:00:00').getDay() === weekday)
    .slice(-lookbackWeeks);

  const explain = [];
  let base;

  if (sameWeekday.length >= 3) {
    base = median(sameWeekday.map(d => d.revenue));
    explain.push(`Your last ${sameWeekday.length} ${names[weekday]}s averaged around ${Math.round(base).toLocaleString('en-IN')} (median).`);
  } else {
    const recent = series.slice(-14);
    base = median(recent.map(d => d.revenue));
    explain.push(`Not enough ${names[weekday]} history yet, so this uses the median of the last ${recent.length} trading days.`);
  }

  // Trend: last 4 weeks vs the 4 before.
  const last28 = series.slice(-28);
  const prev28 = series.slice(-56, -28);
  let trendPct = 0;
  if (last28.length >= 10 && prev28.length >= 10) {
    const a = sum(last28.map(d => d.revenue)) / last28.length;
    const b = sum(prev28.map(d => d.revenue)) / prev28.length;
    if (b > 0) {
      trendPct = ((a - b) / b) * 100;
      trendPct = Math.max(-25, Math.min(25, trendPct));
      if (Math.abs(trendPct) >= 2) {
        explain.push(trendPct > 0
          ? `The last 4 weeks are running ${trendPct.toFixed(0)}% ahead of the 4 before, so the goal is lifted to match.`
          : `The last 4 weeks are running ${Math.abs(trendPct).toFixed(0)}% behind the 4 before, so the goal is eased to stay realistic.`);
      }
    }
  }

  const afterTrend = base * (1 + trendPct / 100);
  const raw = afterTrend * (1 + growthPct / 100);
  if (growthPct) explain.push(`Then a ${growthPct}% stretch on top - that is the growth you are aiming for.`);

  let goal = Math.max(minGoal, Math.round(raw / 50) * 50);
  if (goal === minGoal && raw < minGoal) explain.push(`Held at the minimum goal of ${minGoal.toLocaleString('en-IN')}.`);

  const confidence = sameWeekday.length >= 5 ? 'high' : sameWeekday.length >= 3 ? 'medium' : 'low';

  return {
    goal,
    base: Math.round(base),
    trendPct: Number(trendPct.toFixed(1)),
    growthPct,
    explain,
    sampleDays: sameWeekday.length,
    weekday: names[weekday],
    confidence,
    history: sameWeekday.map(d => ({ date: d.date, revenue: d.revenue }))
  };
}

/**
 * Where the day *should* be by now, using the shop's own hourly shape.
 * This is what turns a goal into a live pace indicator.
 */
function expectedByNow(goal, hourlyProfile, now = new Date()) {
  if (!hourlyProfile || !hourlyProfile.length) return null;
  const total = hourlyProfile.reduce((a, b) => a + b.avgAmount, 0);
  if (!total) return null;
  const hr = now.getHours();
  const mins = now.getMinutes();
  let cum = 0;
  for (const h of hourlyProfile) {
    if (h.hour < hr) cum += h.avgAmount;
    else if (h.hour === hr) cum += h.avgAmount * (mins / 60);
  }
  const pct = cum / total;
  return { expected: goal * pct, sharePct: pct * 100 };
}

/** Pace verdict in plain language - the thing the shop actually reads. */
function paceVerdict(actual, goal, expected) {
  if (!goal) return { state: 'unknown', line: 'No goal set for today.' };
  const pctOfGoal = (actual / goal) * 100;
  if (expected === null || expected === undefined) {
    return {
      state: pctOfGoal >= 100 ? 'good' : 'warning',
      line: `${Math.round(pctOfGoal)}% of today's goal.`
    };
  }
  const gap = actual - expected;
  const gapPct = expected > 0 ? (gap / expected) * 100 : 0;
  if (pctOfGoal >= 100) {
    return { state: 'good', line: `Goal reached - ${Math.round(pctOfGoal)}% of target with the day still running.` };
  }
  if (gapPct >= 10) {
    return { state: 'good', line: `Ahead of pace by ${Math.round(Math.abs(gapPct))}%. On track to beat the goal.` };
  }
  if (gapPct >= -10) {
    return { state: 'good', line: `On pace. ${Math.round(pctOfGoal)}% of goal banked so far.` };
  }
  if (gapPct >= -30) {
    return { state: 'warning', line: `Behind pace by ${Math.round(Math.abs(gapPct))}%. Needs a push to reach the goal.` };
  }
  return { state: 'critical', line: `Well behind pace - ${Math.round(Math.abs(gapPct))}% under where the day usually is by now.` };
}

/** Rolling goal performance, so the shop can see whether goals are being met. */
async function goalHistory(config, days = 14) {
  const from = M.iso(M.daysAgo(days));
  const to = M.iso(M.daysAgo(1));
  const series = await M.dailySeries(from, to);
  const out = [];
  for (const d of series) {
    const g = await dailyGoal(config, new Date(d.date + 'T12:00:00'));
    out.push({
      date: d.date, revenue: d.revenue, goal: g.goal,
      hit: d.revenue >= g.goal,
      pct: g.goal ? (d.revenue / g.goal) * 100 : 0
    });
  }
  return out;
}

module.exports = { dailyGoal, expectedByNow, paceVerdict, goalHistory };
