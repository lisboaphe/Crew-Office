// The pre-receive hook every hosted repository runs (installed by git.cjs). Git calls it with
// "<old> <new> <ref>" lines on stdin before any pushed ref is updated; a non-zero exit
// rejects the whole push, and what we print reaches the pusher as "remote: …".
//
// It enforces what the host decided about this pusher (CREW_ALLOWED_PREFIXES, set by the
// authenticated HTTP handler — never by the client) and scans what is arriving.

'use strict';

const { execFileSync } = require('child_process');
const { SECRET_FILES, SECRET_TEXT, ALLOWED_EXAMPLE } = require('./git.cjs');

const ZERO = /^0+$/;
const allowed = String(process.env.CREW_ALLOWED_PREFIXES ?? '').split(' ').filter(Boolean);
const protectedRef = process.env.CREW_PROTECTED || 'refs/heads/main';
const git = (args) => execFileSync(process.env.CREW_GIT || 'git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function fail(msg) {
  process.stderr.write(`\n*** Crew Office refused this push: ${msg}\n\n`);
  process.exit(1);
}

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  for (const line of input.split('\n').filter(Boolean)) {
    const [oldSha, newSha, ref] = line.trim().split(/\s+/);
    if (ref === protectedRef) fail(`${ref} is protected. Push your own branch and request a merge; the host merges after review and approval.`);
    if (ZERO.test(newSha)) fail('branches cannot be deleted here.');
    if (ref.startsWith('refs/tags/')) fail('tags are made by the host (snapshots).');
    if (!allowed.some((p) => ref.startsWith(p))) fail(`you may push only to ${allowed.join(', ') || 'no branches'} — ${ref} belongs to someone else.`);
    let base = ZERO.test(oldSha) ? '' : oldSha;
    if (!base) { try { base = git(['rev-parse', '--verify', '--quiet', protectedRef]).trim(); } catch { base = ''; } }
    const names = (base ? git(['diff', '--name-only', '--diff-filter=AM', base, newSha]) : git(['ls-tree', '-r', '--name-only', newSha])).split('\n').filter(Boolean);
    for (const name of names) {
      if (SECRET_FILES.test(name) && !ALLOWED_EXAMPLE.test(name)) fail(`${name} looks like a secrets file. Keep it out of Git (it is in .gitignore).`);
      let text = '';
      try {
        const size = Number(git(['cat-file', '-s', `${newSha}:${name}`]).trim());
        if (size > 2 * 1024 * 1024) continue;
        text = git(['show', `${newSha}:${name}`]);
      } catch { continue; }
      if (SECRET_TEXT.test(text)) fail(`${name} contains something that looks like a credential (an API key, token or private key). Remove it and push again.`);
    }
  }
  process.exit(0);
});
