#!/usr/bin/env node
// Build the installers into dist/:
//
//   dist/CrewOffice-<version>.zip     the app itself (what both installers unpack)
//   dist/CrewOfficeSetup.exe          Windows: a self-extracting setup (made with IExpress,
//                                     which ships with Windows — nothing to install)
//
// Only what the app needs at runtime goes in: no tests, no docs sources, no dev tooling,
// no dependencies (the installer runs `npm install --omit=dev` on the user's machine).
//
//   npm run installer

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const version = require('../package.json').version;

// Runtime paths, relative to the repository. Directories are taken whole.
const INCLUDE = [
  'server.cjs', 'index.html', 'home.html', 'styles.css', 'favicon.ico', 'package.json', 'package-lock.json',
  'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'README.md', '.env.example',
  'assets', 'crew', 'lib', 'src', 'vendor', 'admin', 'agent-setup', 'docs/images', 'docs/site', 'docs/examples',
  'bin/crew-app.cjs', 'bin/crew-host.cjs', 'bin/crew-worker.cjs', 'bin/crew-relay.cjs', 'bin/crew-demo.cjs', 'bin/crew-demo-bot.cjs', 'bin/lib/cli-flags.cjs',
  'installer/windows/install.ps1', 'installer/windows/uninstall.ps1', 'installer/windows/register-protocol.ps1', 'installer/windows/open-invitation.vbs', 'installer/unix/install.sh',
];
for (const f of fs.readdirSync(path.join(ROOT, 'docs'))) if (f.endsWith('.html')) INCLUDE.push(`docs/${f}`);

function copy(rel, stage) {
  const from = path.join(ROOT, rel);
  if (!fs.existsSync(from)) throw new Error(`missing ${rel}`);
  fs.cpSync(from, path.join(stage, rel), { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
}

// What the app's updater reads (lib/crew/update.cjs). In the release workflow GitHub supplies
// the run number and repository; a build by hand is build 0 of whatever `origin` points at,
// so any release counts as newer than it. With no GitHub remote the updater uses package.json.
function buildStamp() {
  const git = (...args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const origin = /github\.com[/:]([^/]+\/[^/]+?)(\.git)?$/.exec(git('remote', 'get-url', 'origin'))?.[1];
  // The internet service this build finds by itself (lib/crew/relay-client.cjs). No address here
  // means no internet hosting out of the box, and the app says so rather than pretending.
  const service = (process.env.CREW_CONNECTIVITY_URL || '').trim();
  if (service && !/^https:\/\//.test(service)) throw new Error('CREW_CONNECTIVITY_URL has to be an https:// address.');
  if (!service) console.log('No CREW_CONNECTIVITY_URL: this build has no automatic internet service.');
  return { version, build: Number(process.env.GITHUB_RUN_NUMBER) || 0, commit: process.env.GITHUB_SHA || git('rev-parse', 'HEAD') || null, repo: process.env.GITHUB_REPOSITORY || origin || null, ...(service ? { connectivity: { url: service } } : {}) };
}

function main() {
  fs.mkdirSync(DIST, { recursive: true });
  // IExpress and makecab cannot cope with non-ASCII or very long paths, so build in a short
  // ASCII temp folder and copy the results back.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crewpkg-'));
  const stage = path.join(work, 'app');
  for (const rel of INCLUDE) copy(rel, stage);
  fs.writeFileSync(path.join(stage, 'build.json'), `${JSON.stringify(buildStamp(), null, 2)}\n`);

  const zip = path.join(work, 'app.zip');
  // bsdtar ships with Windows 10+ and every Unix; -a picks the zip format from the name.
  execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar', ['-a', '-cf', zip, '-C', stage, '.'], { stdio: 'inherit' });
  const zipOut = path.join(DIST, `CrewOffice-${version}.zip`);
  fs.copyFileSync(zip, zipOut);
  console.log(`wrote ${path.relative(ROOT, zipOut)} (${(fs.statSync(zip).size / 1e6).toFixed(1)} MB)`);

  if (process.platform !== 'win32') {
    console.log('CrewOfficeSetup.exe is built on Windows only (IExpress). On macOS/Linux use installer/unix/install.sh with the zip.');
    return;
  }

  const pkg = path.join(work, 'pkg');
  fs.mkdirSync(pkg);
  fs.copyFileSync(zip, path.join(pkg, 'app.zip'));
  fs.copyFileSync(path.join(ROOT, 'installer/windows/install.ps1'), path.join(pkg, 'install.ps1'));
  const exe = path.join(work, 'CrewOfficeSetup.exe');
  const sed = [
    '[Version]', 'Class=IEXPRESS', 'SEDVersion=3',
    '[Options]', 'PackagePurpose=InstallApp', 'ShowInstallProgramWindow=0', 'HideExtractAnimation=1', 'UseLongFileName=1',
    'InsideCompressed=0', 'CAB_FixedSize=0', 'CAB_ResvCodeSigning=0', 'RebootMode=N',
    'InstallPrompt=%InstallPrompt%', 'DisplayLicense=%DisplayLicense%', 'FinishMessage=%FinishMessage%', 'TargetName=%TargetName%',
    'FriendlyName=%FriendlyName%', 'AppLaunched=%AppLaunched%', 'PostInstallCmd=%PostInstallCmd%',
    'AdminQuietInstCmd=%AdminQuietInstCmd%', 'UserQuietInstCmd=%UserQuietInstCmd%', 'SourceFiles=SourceFiles',
    '[Strings]', 'InstallPrompt=', 'DisplayLicense=', 'FinishMessage=', `TargetName=${exe}`,
    // PowerShell directly: a batch file launched from the package silently never ran, and the
    // setup then exited 0 having installed nothing. install.ps1 finds app.zip beside itself.
    `FriendlyName=Crew Office ${version} Setup`, 'AppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1', 'PostInstallCmd=<None>',
    'AdminQuietInstCmd=', 'UserQuietInstCmd=', 'FILE0="install.ps1"', 'FILE1="app.zip"',
    '[SourceFiles]', `SourceFiles0=${pkg}\\`, '[SourceFiles0]', '%FILE0%=', '%FILE1%=',
  ].join('\r\n');
  const sedFile = path.join(work, 'setup.sed');
  fs.writeFileSync(sedFile, sed);
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'iexpress.exe'), ['/N', '/Q', sedFile], { stdio: 'inherit' });
  if (!fs.existsSync(exe)) throw new Error('IExpress did not produce the setup program');
  const exeOut = path.join(DIST, 'CrewOfficeSetup.exe');
  fs.copyFileSync(exe, exeOut);
  console.log(`wrote ${path.relative(ROOT, exeOut)} (${(fs.statSync(exe).size / 1e6).toFixed(1)} MB)`);
  fs.rmSync(work, { recursive: true, force: true });
}

main();
