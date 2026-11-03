#!/usr/bin/env node
// Host an office on this computer for friends on your network: the ordinary server,
// bound to every interface, on port 8080 unless you name another.
//
//   npm run host                 # Mode A: host on my PC
//   npm run dedicated            # Mode B: same server, marked dedicated (rooms outlive you)
//
// Equivalent to `HOST=0.0.0.0 node server.cjs 8080`, spelled so it also works in
// Windows shells. Anything in the environment still wins.

'use strict';

// Settings from a .env beside the app, if there is one (see .env.example). Values
// already in the environment win.
try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* no .env */ }

process.env.HOST = process.env.HOST || '0.0.0.0';
if (process.argv.includes('--dedicated')) {
  process.env.CREW_MODE = 'dedicated';
  process.argv.splice(process.argv.indexOf('--dedicated'), 1);
}
if (!process.argv.slice(2).some((a) => /^\d+$/.test(a)) && !process.env.PORT) process.argv.push('8080');
require('../server.cjs');
