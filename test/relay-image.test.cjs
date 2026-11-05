// The self-hosting recipe, actually run: nothing else notices when it cannot build. Its first version
// could not, because the root .dockerignore leaves out bin, and that would have surfaced on someone's
// new server as the first step of deploying it.
//
// Needs Docker running Linux containers and skips without it, so CI on Linux is what runs it. What it
// cannot show is real DNS or a real certificate.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { dockerAvailable } = require('../lib/crew-worker/sandbox.cjs');

const ROOT = path.join(__dirname, '..');
const RELAY = path.join(ROOT, 'deploy', 'relay');
const DOMAIN = 'relay.example.org';
const skip = dockerAvailable() ? false : 'needs Docker running Linux containers';

function docker(args, env = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  assert.strictEqual(r.status, 0, `docker ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}

function ask(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: url, headers: { Host: DOMAIN } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('no answer')));
  });
}

test('the relay image builds, holds only the service, and runs under the limits compose gives it', { skip, timeout: 300_000 }, async (t) => {
  const tag = `crew-relay-test-${crypto.randomBytes(4).toString('hex')}`;
  docker(['build', '-f', 'deploy/relay/Dockerfile', '-t', tag, '.']);
  t.after(() => { spawnSync('docker', ['rmi', '-f', tag], { stdio: 'ignore' }); });

  const files = docker(['run', '--rm', '--entrypoint', 'find', tag, '/relay', '-type', 'f']).split('\n').sort();
  assert.ok(files.includes('/relay/bin/crew-relay.cjs'), files.join('\n'));
  assert.ok(files.includes('/relay/lib/relay/frames.cjs'), files.join('\n'));
  assert.deepStrictEqual(files.filter((f) => !f.startsWith('/relay/lib/relay/') && f !== '/relay/bin/crew-relay.cjs'), [], 'and nothing else');

  docker(['run', '-d', '--name', tag, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '256m',
    '-e', 'CREW_RELAY_OPEN=1', '-e', `CREW_RELAY_DOMAIN=${DOMAIN}`, '-e', 'CREW_RELAY_TRUST_PROXY=1', '-p', '127.0.0.1::8443', tag]);
  t.after(() => { spawnSync('docker', ['rm', '-f', tag], { stdio: 'ignore' }); });

  const port = Number(docker(['port', tag, '8443']).split('\n')[0].split(':').pop());
  let health = null;
  for (let i = 0; i < 60 && !health; i++) {
    health = await ask(port, '/_relay/health').catch(() => null);
    if (!health) await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(health, `the service never answered:\n${docker(['logs', tag])}`);
  assert.strictEqual(health.status, 200, health.body);
  assert.strictEqual(JSON.parse(health.body).ok, true);
  assert.strictEqual((await ask(port, '/_relay/info')).status, 200);
});

test('the compose file and Caddy configuration are valid', { skip, timeout: 120_000 }, () => {
  const env = { CREW_RELAY_DOMAIN: DOMAIN, ACME_EMAIL: 'you@example.org' };
  docker(['compose', '-f', 'deploy/relay/docker-compose.yml', 'config', '-q'], env);
  docker(['run', '--rm', '-e', `CREW_RELAY_DOMAIN=${DOMAIN}`, '-e', `ACME_EMAIL=${env.ACME_EMAIL}`, '-v', `${path.join(RELAY, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`,
    'caddy:2-alpine', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
});
