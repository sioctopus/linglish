#!/usr/bin/env node
'use strict';

// Refresh only reviewed sources; the shared fetcher preserves author and license.
const { main } = require('./fetch-theme-photos-ps');
if (require.main === module) main(['home', ...process.argv.slice(2)]).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
