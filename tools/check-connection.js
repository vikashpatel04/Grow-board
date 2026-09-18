/* Quick connection check: `npm run check` */
'use strict';
const path = require('path'), fs = require('fs');
const db = require('../src/db');
const cfg = require('./load-config').load();
(async () => {
  process.stdout.write(`Connecting to ${cfg.sql.server} as ${cfg.sql.user} ... `);
  try {
    await db.connect(cfg);
    const h = await db.health();
    console.log('ok');
    console.log(`  server        ${h.server}`);
    console.log(`  server time   ${new Date(h.serverTime).toLocaleString('en-IN')}`);
    console.log(`  year database ${h.yearDb}`);
    const years = await db.allYearDbs();
    console.log(`  financial years available: ${years.map(y => y.label).join(', ')}`);
    await db.close();
  } catch (e) {
    console.log('FAILED');
    console.log(`  ${e.message}`);
    console.log('\n  Check that SQL Server is running and that TCP/IP is enabled');
    console.log('  in SQL Server Configuration Manager.');
    process.exit(1);
  }
})();
