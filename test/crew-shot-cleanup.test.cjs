// A job's screenshots go when its session ends, the kept ones stay, and a worker that stopped
// mid-job sweeps what it left behind when it starts again.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createShots } = require('../lib/crew/shots.cjs');
const { captureScreenshots } = require('../bin/lib/shot-capture.cjs');
const { forgetJobShots, sweepOrphanShots, shotsDataDir } = require('../lib/crew-worker/shot-cleanup.cjs');
const { shotTags } = require('../lib/crew-worker/native.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-shot-cleanup-'));
const payload = {
  hook_event_name: 'PostToolUse', cwd: '/home/me/space-game',
  tool_name: 'mcp__Claude_Browser__computer', tool_input: { action: 'screenshot' },
  tool_response: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }],
};
const ctx = (job, agent = { id: 'ag_1', name: 'Ada' }) => ({ job: { id: job }, agent });
const shoot = (dataDir, env) => captureScreenshots({ harness: 'claude-code', event: 'PostToolUse', payload, folder: path.join(dataDir, 'shots'), env })[0];

test('the runner tags its Claude Code run, and the hook writes the tag beside the screenshot', () => {
  const dataDir = tmp();
  const env = shotTags(ctx('job_1'));
  assert.deepEqual(env, { ROVING_OFFICE_JOB: 'job_1', ROVING_OFFICE_AGENT_ID: 'ag_1', ROVING_OFFICE_AGENT: 'Ada' });
  shoot(dataDir, env);
  const [s] = createShots({ dataDir }).list().shots;
  assert.equal(s.job, 'job_1');
  assert.equal(s.agent, 'Ada');
  assert.equal(s.agentId, 'ag_1');
});

test('a tag that is not a plain id is not written', () => {
  const dataDir = tmp();
  shoot(dataDir, { ROVING_OFFICE_JOB: '../../etc', ROVING_OFFICE_AGENT: 'Ada\u0007' });
  const [s] = createShots({ dataDir }).list().shots;
  assert.equal(s.job, null);
  assert.equal(s.agent, null, 'no name without a job');
});

test('a job ending deletes its own screenshots, not kept ones, not another job’s, not hand-taken ones', () => {
  const dataDir = tmp();
  const shots = createShots({ dataDir });
  const mine = shoot(dataDir, shotTags(ctx('job_1')));
  const keptOne = shoot(dataDir, shotTags(ctx('job_1')));
  const other = shoot(dataDir, shotTags(ctx('job_2')));
  const byHand = shoot(dataDir, {});
  shots.keep(keptOne);

  assert.equal(forgetJobShots('job_1', { dataDir }), 1);
  const left = shots.list().shots.map((s) => s.name).sort();
  assert.deepEqual(left, [keptOne, other, byHand].sort());
  assert.equal(fs.existsSync(path.join(shots.folder, `${mine}.json`)), false, 'its notes go with it');
});

test('starting the worker sweeps every ended job’s screenshots and leaves the rest', () => {
  const dataDir = tmp();
  const shots = createShots({ dataDir });
  shoot(dataDir, shotTags(ctx('job_1')));
  const running = shoot(dataDir, shotTags(ctx('job_9')));
  const keptOne = shoot(dataDir, shotTags(ctx('job_2')));
  const byHand = shoot(dataDir, {});
  shots.keep(keptOne);

  assert.equal(sweepOrphanShots({ dataDir, isRunning: (job) => job === 'job_9' }), 1);
  assert.deepEqual(shots.list().shots.map((s) => s.name).sort(), [running, keptOne, byHand].sort());
  assert.equal(sweepOrphanShots({ dataDir }), 1, 'once job_9 is over too');
});

test('clean-up never throws, with no folder or an unreadable one', () => {
  assert.equal(forgetJobShots('job_1', { dataDir: path.join(tmp(), 'nothing-here') }), 0);
  assert.equal(sweepOrphanShots({ dataDir: path.join(tmp(), 'nothing-here') }), 0);
});

test('the worker looks where the hook writes', () => {
  assert.equal(shotsDataDir({ CREW_DATA_DIR: '/x/crew' }), '/x/crew');
  assert.equal(shotsDataDir({}), path.join(os.homedir(), '.roving-office', 'crew'));
});
