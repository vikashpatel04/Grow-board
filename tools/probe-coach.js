'use strict';
const path=require('path'), fs=require('fs');
const db=require('../src/db'), C=require('../src/coach'), G=require('../src/goals');
const cfg = require('./load-config').load();
const money=v=>'₹'+Math.round(Number(v)||0).toLocaleString('en-IN');
(async()=>{
  await db.connect(cfg);
  const b=await C.briefing(cfg);
  console.log('\n=== GOAL ===');
  console.log(`  goal ${money(b.goal.goal)}  base ${money(b.goal.base)}  trend ${b.goal.trendPct}%  confidence ${b.goal.confidence} (${b.goal.sampleDays} ${b.goal.weekday}s)`);
  b.goal.explain.forEach(e=>console.log('   - '+e));
  console.log('\n=== PACE ===');
  console.log(`  actual ${money(b.today.revenue)}  expected-by-now ${b.expected?money(b.expected.expected):'n/a'} (${b.expected?b.expected.sharePct.toFixed(0)+'% of day':''})`);
  console.log(`  [${b.verdict.state}] ${b.verdict.line}`);
  console.log(`  bills ${b.today.bills}  ABV ${money(b.today.abv)}  margin ${b.today.marginPct.toFixed(1)}%  cash ${money(b.today.cash)} digital ${money(b.today.digital)}`);
  console.log(`\n=== ACTIONS (${b.allActions.length}) ===`);
  b.allActions.forEach((a,i)=>{
    console.log(`\n ${i+1}. [${a.severity}/${a.theme}] ${a.title}   (score ${a.score.toFixed(0)})`);
    console.log(`    why : ${a.why}`);
    console.log(`    do  : ${a.todo}`);
    if(a.impact) console.log(`    impact: ${money(a.impact)} - ${a.impactLabel}`);
    else if(a.impactLabel) console.log(`    impact: ${a.impactLabel}`);
  });
  await db.close();
})().catch(e=>{console.error('FATAL',e); process.exit(1);});
