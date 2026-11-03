#!/usr/bin/env node
// The agent worker. Everything is in lib/crew-worker/main.cjs, so the Docker image —
// which carries lib/ but not bin/ — can run the same program.
'use strict';
require('../lib/crew-worker/main.cjs');
