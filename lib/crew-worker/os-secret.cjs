// Keeps the vault's key in what the operating system offers for this, so that copying the data
// folder to another computer or account gets nothing that can be opened.
//
//   Windows  DPAPI, scoped to the signed-in user
//   macOS    the login Keychain
//   Linux    the Secret Service, through secret-tool, where a desktop provides one
//
// Each of these holds a 32-byte random key, never an API key, and the value only ever travels over
// stdin or stdout. If none is available the caller falls back to a user-only file and says so.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SERVICE = 'Crew Office worker vault';
const quiet = (input) => ({ input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 30_000, windowsHide: true });
const powershell = (script, input) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], quiet(input)).trim();

const DPAPI = (method) => `Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}($b, $null, 'CurrentUser'))`;

function createOsSecret(dir, { platform = process.platform } = {}) {
  const blob = path.join(dir, 'vault.key.protected');
  // Which account's entry, so two data folders on one computer never share a key.
  const account = () => require('crypto').createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 24);

  const stores = {
    win32: {
      name: 'Windows DPAPI',
      read: () => (fs.existsSync(blob) ? Buffer.from(powershell(DPAPI('Unprotect'), fs.readFileSync(blob, 'utf8').trim()), 'base64') : null),
      write: (key) => fs.writeFileSync(blob, powershell(DPAPI('Protect'), key.toString('base64')), { mode: 0o600 }),
    },
    darwin: {
      name: 'macOS Keychain',
      read: () => { try { return Buffer.from(execFileSync('security', ['find-generic-password', '-a', account(), '-s', SERVICE, '-w'], quiet()).trim(), 'hex'); } catch { return null; } },
      // `security` takes the value only as an argument, or on a prompt it reads from the terminal.
      write: (key) => execFileSync('security', ['-i'], quiet(`add-generic-password -U -a ${account()} -s "${SERVICE}" -w ${key.toString('hex')}\n`)),
    },
    linux: {
      name: 'Secret Service',
      read: () => { try { const v = execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', account()], quiet()).trim(); return v ? Buffer.from(v, 'hex') : null; } catch { return null; } },
      write: (key) => execFileSync('secret-tool', ['store', `--label=${SERVICE}`, 'service', SERVICE, 'account', account()], quiet(key.toString('hex'))),
    },
  };
  const store = stores[platform] ?? null;

  /** Whether something is already kept here, without opening it. */
  const exists = () => {
    if (platform === 'win32') return fs.existsSync(blob);
    try { return Boolean(store?.read()); } catch { return false; }
  };

  return {
    name: store?.name ?? null,
    exists,
    read: () => store?.read() ?? null,
    /** Store, and read back to prove it. False when this computer has no working store. */
    write(key) {
      if (!store) return false;
      try {
        store.write(key);
        const back = store.read();
        return Boolean(back) && back.equals(key);
      } catch { return false; }
    },
  };
}

module.exports = { createOsSecret };
