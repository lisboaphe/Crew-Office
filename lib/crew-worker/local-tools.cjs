// Tools that run on the agent owner's own machine: sandboxed code, web fetches, and the
// agent's private memory. Each one has already been authorised by the room host.

'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const sandbox = require('./sandbox.cjs');
const { createRepoTools } = require('./git-local.cjs');

const FETCH_CAP = 200 * 1024;

function createLocalTools({ dataDir, host }) {
  const memDir = path.join(dataDir, 'agent-memory');
  fs.mkdirSync(memDir, { recursive: true });

  // Private agent memory: a file per agent, on the owner's disk, never sent to the room
  // except as what the agent itself chooses to say.
  const memFile = (agentId) => path.join(memDir, `${String(agentId).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
  const readMem = (agentId) => { try { return JSON.parse(fs.readFileSync(memFile(agentId), 'utf8')); } catch { return {}; } };

  async function privateHost(hostname) {
    const addrs = net.isIP(hostname) ? [hostname] : (await dns.lookup(hostname, { all: true })).map((a) => a.address);
    return addrs.some((a) => /^(::ffff:)?(127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(a) || /^(::1$|::$|fc|fd|fe[89ab])/i.test(a) || /^(::ffff:)?172\.(1[6-9]|2\d|3[01])\./i.test(a) || /^(::ffff:)?100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./i.test(a));
  }

  const repoTools = host.token ? createRepoTools({ dataDir, host, token: host.token }) : {};

  function worktreeFiles(dir, base = dir, out = {}) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules' || e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) worktreeFiles(p, base, out);
      else if (fs.statSync(p).size <= 1024 * 1024) out[path.relative(base, p).replace(/\\/g, '/')] = fs.readFileSync(p);
    }
    return out;
  }

  return {
    ...repoTools,

    async run_command(ctx, { command, repo }) {
      // In a Git project the sandbox starts from this agent's own clone, uncommitted work included.
      let files;
      if (ctx.project?.repos?.length && repoTools.ensure) files = worktreeFiles((await repoTools.ensure(ctx, repo)).dir);
      else ({ files } = await host.get(`/api/crew/worker/files?jobId=${encodeURIComponent(ctx.job.id)}`).catch(() => ({ files: {} })));
      const out = await sandbox.forContext(ctx, { hostBase: host.base, dataDir })(command, files);
      return { exitCode: out.exitCode, output: out.output, isolation: out.isolation, note: 'Files changed by the command were not saved. Use write_file for deliverables.' };
    },

    async fetch_url(ctx, { url }) {
      let u;
      try { u = new URL(url); } catch { throw new Error('Not a URL.'); }
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https.');
      // An agent that can be talked into fetching anything is a way into its owner's LAN.
      if (await privateHost(u.hostname)) throw new Error('Private and local network addresses are blocked.');
      const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'crew-office-agent/1' } });
      const type = res.headers.get('content-type') ?? '';
      if (!/^text\/|json|xml/.test(type)) return { status: res.status, contentType: type, note: 'Not a text document; content not returned.' };
      const text = (await res.text()).slice(0, FETCH_CAP);
      return { status: res.status, contentType: type, content: type.includes('html') ? text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 60_000) : text };
    },

    remember(ctx, { key, value }) {
      const mem = readMem(ctx.agent.id);
      mem[String(key).slice(0, 80)] = { value: String(value).slice(0, 4000), at: new Date().toISOString() };
      const keys = Object.keys(mem);
      for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete mem[k];
      fs.writeFileSync(memFile(ctx.agent.id), JSON.stringify(mem, null, 2));
      return { saved: key };
    },

    recall(ctx, { query = '' } = {}) {
      const mem = readMem(ctx.agent.id);
      const q = String(query).toLowerCase();
      return { memory: Object.entries(mem).filter(([k, v]) => !q || k.toLowerCase().includes(q) || v.value.toLowerCase().includes(q)).slice(-30).map(([k, v]) => ({ key: k, value: v.value })) };
    },
  };
}

module.exports = { createLocalTools };
