'use strict';
const path=require('path'),fs=require('fs');
const db=require('../src/db'),C=require('../src/coach');
const cfg = require('./load-config').load();
(async()=>{
  await db.connect(cfg);
  let t=Date.now(); await C.briefing(cfg); console.log('briefing COLD  :', Date.now()-t,'ms');
  t=Date.now(); await C.briefing(cfg); console.log('briefing WARM  :', Date.now()-t,'ms');
  db.clearCache();
  t=Date.now(); await C.buildActions(cfg); console.log('actions  COLD  :', Date.now()-t,'ms');
  await db.close();
})().catch(e=>{console.error(e);process.exit(1);});
