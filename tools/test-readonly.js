/* Proves the database layer refuses writes. */
'use strict';
const path=require('path'),fs=require('fs');
const db=require('../src/db');
const cfg = require('./load-config').load();
const attempts=[
  "UPDATE {{ADMIN}}.itemStock SET Qty = 0",
  "DELETE FROM {{YEAR}}.sales",
  "INSERT INTO {{YEAR}}.saleshead (ENTREFNO) VALUES ('x')",
  "DROP TABLE {{YEAR}}.sales",
  "TRUNCATE TABLE {{YEAR}}.ItemTag",
  "EXEC sp_who",
  "SELECT 1; UPDATE {{ADMIN}}.itemmast SET SELRATE=0"
];
(async()=>{
  await db.connect(cfg);
  let blocked=0;
  for(const a of attempts){
    try { await db.query(a,{},{ttlMs:0}); console.log(`  [LEAKED] ${a.slice(0,50)}`); }
    catch(e){
      const guard = /read-only/.test(e.message);
      console.log(`  [${guard?'blocked':'sql-error'}] ${a.slice(0,48).padEnd(50)} ${guard?'':e.message.slice(0,40)}`);
      if(guard) blocked++;
    }
  }
  // and prove a legitimate read still works
  const r = await db.query("SELECT COUNT(*) AS c FROM {{YEAR}}.sales",{},{ttlMs:0});
  console.log(`\n  ${blocked}/${attempts.length} write attempts blocked by the guard`);
  console.log(`  reads still work: sales has ${r[0].c} rows`);
  await db.close();
  process.exit(blocked===attempts.length?0:1);
})();
