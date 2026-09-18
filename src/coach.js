/**
 * Grow Board - the coach.
 *
 * This is what separates a dashboard from a report. Each rule looks at the
 * real numbers and, when something is worth acting on, returns an action with
 * four parts:
 *
 *   why    - the evidence, with the actual figures
 *   do     - a concrete next step, not "improve margins"
 *   impact - rupees on the table, estimated conservatively and labelled as an estimate
 *   where  - the page that shows the detail
 *
 * Actions are scored and ranked so the app can say "do this one first".
 * Score = impact weight x confidence x urgency. Anything scoring 0 is dropped.
 */
'use strict';

const M = require('./metrics');
const G = require('./goals');

const money = v => '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN');
const pct = v => `${(Number(v) || 0).toFixed(1)}%`;

function action(a) {
  return {
    id: a.id,
    title: a.title,
    severity: a.severity || 'info',      // critical | serious | warning | good | info
    theme: a.theme || 'growth',          // growth | cash | stock | margin | data | customer
    why: a.why,
    todo: a.todo,
    impact: a.impact || null,
    impactLabel: a.impactLabel || null,
    where: a.where || null,
    score: a.score || 0
  };
}

/**
 * Build the full ranked action list.
 * Every rule is defensive - a failing metric must not take the page down.
 */
async function buildActions(config) {
  const out = [];
  const safe = async (fn) => { try { return await fn(); } catch { return null; } };

  const [
    ageing, dead, fast, stock, pay, sup, exp, cov, health, cust, disc, cats, series, wd
  ] = await Promise.all([
    safe(() => M.stockAgeing()),
    safe(() => M.deadStock(365, 200)),
    safe(() => M.fastMovers(60, 60)),
    safe(() => M.stockSummary()),
    safe(() => M.payables()),
    safe(() => M.supplierScorecard(365)),
    safe(() => M.expenses(90)),
    safe(() => M.expenseCoverage(30)),
    safe(() => M.dataHealth()),
    safe(() => M.customerCapture(30)),
    safe(() => M.discountLeakage(90)),
    safe(() => M.categoryPerformance(90)),
    safe(() => M.dailySeries(M.iso(M.daysAgo(60)), M.iso(new Date()))),
    safe(() => M.weekdayProfile())
  ]);

  /* ---------------------------------------------------------- dead stock */
  if (ageing && stock) {
    const old = ageing.bands.filter(b => b.band === 'Over 2 years' || b.band === '1 to 2 years');
    const oldValue = old.reduce((a, b) => a + b.costValue, 0);
    const oldTags = old.reduce((a, b) => a + b.tags, 0);
    const shareOfStock = stock.costValue ? (oldValue / stock.costValue) * 100 : 0;
    if (oldValue > 0 && shareOfStock > 15) {
      // Conservative: assume half the aged lots can be moved at cost.
      const recover = oldValue * 0.5;
      out.push(action({
        id: 'dead-stock',
        title: 'Turn old stock back into cash',
        severity: shareOfStock > 40 ? 'critical' : 'serious',
        theme: 'stock',
        why: `${money(oldValue)} of stock cost (${oldTags.toLocaleString('en-IN')} lots) has been sitting for over a year. That is ${pct(shareOfStock)} of your total stock value doing nothing.`,
        todo: 'Open the Stock page, take the top 20 idle items, and run a clearance rack at 25-40% off. Set a 30-day deadline and re-check the list.',
        impact: recover,
        impactLabel: 'cash that could be freed (estimate, assumes half clears at cost)',
        where: 'stock',
        score: 100 * Math.min(1, shareOfStock / 50)
      }));
    }
  }

  if (dead && dead.length) {
    const top = dead.slice(0, 5);
    const v = top.reduce((a, b) => a + b.costValue, 0);
    if (v > 0) {
      out.push(action({
        id: 'dead-stock-top',
        title: `Clear these ${top.length} items first`,
        severity: 'warning',
        theme: 'stock',
        why: `${top.map(t => `${t.name} (${money(t.costValue)}, idle ${t.idleDays} days)`).join('; ')}.`,
        todo: 'Price these to move this week. Even at cost they release cash you can put into fast sellers.',
        impact: v,
        impactLabel: 'locked up in just these items',
        where: 'stock',
        score: 70
      }));
    }
  }

  /* --------------------------------------------------------- fast movers */
  if (fast && fast.length) {
    const urgent = fast.filter(f => !f.oversold && f.coverDays !== null && f.coverDays < 10);
    if (urgent.length) {
      const lost = urgent.reduce((a, f) => a + (f.selRate - f.purRate) * f.perDay * 14, 0);
      out.push(action({
        id: 'restock',
        title: `Reorder ${urgent.length} fast ${urgent.length === 1 ? 'seller' : 'sellers'} before ${urgent.length === 1 ? 'it runs' : 'they run'} out`,
        severity: 'serious',
        theme: 'growth',
        why: `${urgent.slice(0, 4).map(f => `${f.name} (${f.coverDays.toFixed(0)} days left)`).join(', ')}${urgent.length > 4 ? ` and ${urgent.length - 4} more` : ''} will be out of stock within days at the current rate.`,
        todo: 'Open Stock > Reorder now, and place the order with the usual supplier today. These are proven sellers - an empty peg is lost margin.',
        impact: lost > 500 ? lost : null,
        impactLabel: 'margin at risk over the next fortnight if they go empty (estimate)',
        where: 'stock',
        score: 85
      }));
    }
    const oversold = fast.filter(f => f.oversold);
    if (oversold.length >= 3) {
      out.push(action({
        id: 'oversold',
        title: `${oversold.length} selling items show negative stock`,
        severity: 'warning',
        theme: 'data',
        why: 'These items are being sold but show less than zero on hand, which means a purchase or opening entry was never made. Every report that uses stock is wrong for these items.',
        todo: 'Do a physical count on these items and get the missing purchase entries into the POS.',
        where: 'health',
        score: 55
      }));
    }
  }

  /* ------------------------------------------------------------- expenses */
  if (cov && cov.tradingDays > 5) {
    const coverage = cov.tradingDays ? (cov.daysWithExpense / cov.tradingDays) * 100 : 0;
    if (coverage < 60) {
      const totalExp = exp ? exp.reduce((a, b) => a + b.amount, 0) : 0;
      out.push(action({
        id: 'expense-tracking',
        title: 'Expenses are barely being recorded',
        severity: 'critical',
        theme: 'cash',
        why: `Only ${cov.daysWithExpense} of the last ${cov.tradingDays} trading days have any expense entry${totalExp ? `, totalling just ${money(totalExp)} over 90 days` : ''}. Your real profit is lower than every profit figure in this app, and nobody knows by how much.`,
        todo: 'Enter every expense in the POS daily - rent, salary, electricity, transport, tea, repairs. Ten days of honest entries will show the true number.',
        impactLabel: 'profit figures stay unreliable until this is fixed',
        where: 'profit',
        score: 95
      }));
    }
  }

  /* ------------------------------------------------------------- payables */
  if (pay && pay.length) {
    const total = pay.reduce((a, b) => a + b.balance, 0);
    const stale = pay.filter(p => p.daysSincePayment !== null && p.daysSincePayment > 180);
    const staleValue = stale.reduce((a, b) => a + b.balance, 0);
    if (total > 0) {
      out.push(action({
        id: 'payables',
        title: `${money(total)} shown as owed to ${pay.length} suppliers`,
        severity: staleValue > total * 0.4 ? 'serious' : 'warning',
        theme: 'cash',
        why: stale.length
          ? `${stale.length} suppliers (${money(staleValue)}) have had no payment recorded for over 6 months. Either the payments were made and never entered, or these are genuinely overdue.`
          : 'This is the running balance from the purchase ledger since 2021.',
        todo: 'Go down the Suppliers list and confirm each balance against the supplier\'s own statement. Enter any missing payments in the POS so this number becomes trustworthy.',
        impact: staleValue > 0 ? staleValue : null,
        impactLabel: 'in balances that need confirming',
        where: 'suppliers',
        score: 80
      }));
    }
  }

  /* --------------------------------------------------------------- margin */
  if (cats && cats.length) {
    const sized = cats.filter(c => c.revenue > 20000);
    if (sized.length >= 3) {
      const totalGP = sized.reduce((a, c) => a + c.grossProfit, 0);
      const totalTax = sized.reduce((a, c) => a + c.taxable, 0);
      const avg = totalTax ? (totalGP / totalTax) * 100 : 0;
      const weak = sized.filter(c => c.marginPct < avg - 8).sort((a, b) => b.revenue - a.revenue);
      if (weak.length) {
        const lift = weak.reduce((a, c) => a + c.taxable * ((avg - c.marginPct) / 100), 0);
        out.push(action({
          id: 'weak-margin',
          title: `${weak.length} categories earn well below your average margin`,
          severity: 'warning',
          theme: 'margin',
          why: `Your overall margin is ${pct(avg)}. ${weak.slice(0, 3).map(c => `${c.category} runs at ${pct(c.marginPct)} on ${money(c.revenue)}`).join(', ')}.`,
          todo: 'Check the buying price and the selling price on these categories. Either negotiate the purchase rate or lift the retail price - a 2% move on the biggest one is worth more than a week of extra footfall.',
          impact: lift > 0 ? lift : null,
          impactLabel: 'extra gross profit per quarter if brought to average (estimate)',
          where: 'profit',
          score: 75
        }));
      }
      const best = sized.slice().sort((a, b) => b.marginPct - a.marginPct)[0];
      if (best && best.marginPct > avg + 5) {
        out.push(action({
          id: 'push-best-margin',
          title: `Push ${best.category} - it earns the most per rupee sold`,
          severity: 'good',
          theme: 'growth',
          why: `${best.category} runs at ${pct(best.marginPct)} margin against a shop average of ${pct(avg)}, on ${money(best.revenue)} of sales in 90 days.`,
          todo: 'Give it the front display and the counter pitch. Selling the same rupees here earns noticeably more than selling them elsewhere.',
          where: 'profit',
          score: 60
        }));
      }
    }
  }

  /* ------------------------------------------------------------ discounts */
  if (disc && disc.length) {
    const total = disc.reduce((a, d) => a + d.discount, 0);
    const rev = disc.reduce((a, d) => a + d.revenue, 0);
    const overall = rev ? (total / (rev + total)) * 100 : 0;
    if (overall > 3) {
      out.push(action({
        id: 'discount-leak',
        title: `Discounts are costing ${money(total)} a quarter`,
        severity: overall > 6 ? 'serious' : 'warning',
        theme: 'margin',
        why: `That is ${pct(overall)} of what you could have billed. Heaviest: ${disc.slice(0, 3).map(d => `${d.category} ${money(d.discount)}`).join(', ')}.`,
        todo: 'Set a maximum discount per bill in the POS user settings and hold the counter to it. Halving this drops straight to profit.',
        impact: total * 0.5,
        impactLabel: 'quarterly profit if discounting is halved (estimate)',
        where: 'profit',
        score: 78
      }));
    }
  }

  /* ------------------------------------------------------------- customer */
  if (cust && cust.bills > 30 && cust.pct < 25) {
    out.push(action({
      id: 'customer-capture',
      title: 'You do not know who your customers are',
      severity: 'serious',
      theme: 'customer',
      why: `Only ${cust.withCustomer} of the last ${cust.bills} bills (${pct(cust.pct)}) have a customer attached. Without this you cannot bring anyone back, run an offer, or know who your best buyers are.`,
      todo: 'Ask for a mobile number on every bill and enter it in the POS. Even 50% capture over two months gives you a list worth messaging before a festival.',
      impactLabel: 'the single biggest unlock for repeat business',
      where: 'customers',
      score: 88
    }));
  }

  /* ------------------------------------------------------------- weekdays */
  if (wd && wd.length >= 6 && series && series.length > 20) {
    const active = wd.filter(w => w.days >= 4 && w.avgRevenue > 0);
    if (active.length >= 5) {
      const avg = active.reduce((a, w) => a + w.avgRevenue, 0) / active.length;
      const weak = active.slice().sort((a, b) => a.avgRevenue - b.avgRevenue)[0];
      if (weak && weak.avgRevenue < avg * 0.75) {
        const gap = (avg - weak.avgRevenue) * 4;
        out.push(action({
          id: 'weak-weekday',
          title: `${weak.name} is your weakest day`,
          severity: 'info',
          theme: 'growth',
          why: `${weak.name} averages ${money(weak.avgRevenue)} against ${money(avg)} on a normal day - about ${pct(((avg - weak.avgRevenue) / avg) * 100)} below.`,
          todo: `Run something only on ${weak.name} - a combo price, a category offer, or a message to your customer list. It is the cheapest growth available because the shop is already open and staffed.`,
          impact: gap,
          impactLabel: 'extra revenue per month if it reached an average day (estimate)',
          where: 'growth',
          score: 65
        }));
      }
    }
  }

  /* --------------------------------------------------------- data health */
  if (health) {
    if (health.ledgerUnbalancedDays > 0) {
      out.push(action({
        id: 'ledger-broken',
        title: 'The accounting ledger does not balance',
        severity: 'critical', theme: 'data',
        why: `${health.ledgerUnbalancedDays} ${health.ledgerUnbalancedDays === 1 ? 'day has' : 'days have'} debits that do not equal credits. Something has been edited directly in the database.`,
        todo: 'Stop and get this checked before trusting any financial figure. Restore from a backup if the cause is not obvious.',
        where: 'health', score: 120
      }));
    }
    if (health.stockCacheDrift > 0) {
      out.push(action({
        id: 'stock-drift',
        title: 'Stock cache no longer matches the stock ledger',
        severity: 'critical', theme: 'data',
        why: `${health.stockCacheDrift} ${health.stockCacheDrift === 1 ? 'item differs' : 'items differ'} between itemStock and the ItemTag movements. Usually caused by a bulk edit made outside the POS.`,
        todo: 'Have the POS vendor rebuild the stock cache. Until then treat all stock figures as approximate.',
        where: 'health', score: 115
      }));
    }
    if (health.negativeStockItems > 20) {
      out.push(action({
        id: 'negative-stock',
        title: `${health.negativeStockItems} items show negative stock`,
        severity: 'warning', theme: 'data',
        why: `Together they are ${Math.abs(health.negativeStockQty).toFixed(0)} units short. These were sold without a matching purchase or opening entry, so stock value and margin are understated.`,
        todo: 'Work through the list on the Data Health page, count each item physically, and enter the missing purchases in the POS.',
        where: 'health', score: 50
      }));
    }
  }

  /* ------------------------------------------------ supplier concentration */
  if (sup && sup.length >= 3) {
    const total = sup.reduce((a, s) => a + s.purchaseValue, 0);
    const top = sup[0];
    if (total > 0 && top.purchaseValue / total > 0.3) {
      out.push(action({
        id: 'supplier-concentration',
        title: `${top.name} is ${pct((top.purchaseValue / total) * 100)} of your buying`,
        severity: 'info', theme: 'cash',
        why: `${money(top.purchaseValue)} of ${money(total)} bought in the last year came from one supplier. That is leverage you are not using, and a risk if they stop supplying.`,
        todo: 'Use the volume to ask for a better rate or longer credit. At the same time, find a second source for their top lines.',
        where: 'suppliers', score: 45
      }));
    }
    const poor = sup.filter(s => s.purchaseValue > 50000 && s.marginPct > 0 && s.marginPct < 20);
    if (poor.length) {
      out.push(action({
        id: 'supplier-margin',
        title: `${poor.length} ${poor.length === 1 ? 'supplier brings' : 'suppliers bring'} in low-margin goods`,
        severity: 'warning', theme: 'margin',
        why: `${poor.slice(0, 3).map(s => `${s.name} at ${pct(s.marginPct)}`).join(', ')} - well under what the rest of the shop earns.`,
        todo: 'Renegotiate the buying rate, or shift that shelf space to a supplier whose goods earn more.',
        where: 'suppliers', score: 58
      }));
    }
  }

  return out.sort((a, b) => b.score - a.score);
}

/** The single thing to do right now. Used by the tray, the Today page and notifications. */
async function focusNow(config) {
  const actions = await buildActions(config);
  return actions.length ? actions[0] : null;
}

/**
 * A short daily briefing - goal, pace and the top action - as plain sentences.
 * This is what the notifications speak.
 */
async function briefing(config) {
  const [t, goal, profile] = await Promise.all([
    M.today(),
    G.dailyGoal(config),
    M.hourlyProfile()
  ]);
  const exp = G.expectedByNow(goal.goal, profile);
  const verdict = G.paceVerdict(t.revenue, goal.goal, exp ? exp.expected : null);
  const actions = await buildActions(config);
  return {
    today: t,
    goal,
    expected: exp,
    verdict,
    topActions: actions.slice(0, 3),
    allActions: actions
  };
}

module.exports = { buildActions, focusNow, briefing };
