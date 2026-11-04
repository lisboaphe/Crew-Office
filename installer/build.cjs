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
  'bin/crew-app.cjs', 'bin/crew-host.cjs', 'bin/crew-worker.cjs', 'bin/crew-demo.cjs', 'bin/crew-demo-bot.cjs', 'bin/lib/cli-flags.cjs',
  'installer/windows/install.ps1', 'installer/windows/uninstall.ps1', 'installer/unix/install.sh',
];
for (const f of fs.readdirSync(path.join(ROOT, 'docs'))) if (f.endsWith('.html')) INCLUDE.push(`docs/${f}`);

function copy(rel, stage) {
  const from = path.join(ROOT, rel);
  if (!fs.existsSync(from)) throw new Error(`missing ${rel}`);
  fs.cpSync(from, path.join(stage, rel), { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
}

function main() {
  fs.mkdirSync(DIST, { recursive: true });
  // IExpress and makecab cannot cope with non-ASCII or very long paths, so build in a short
  // ASCII temp folder and copy the results back.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crewpkg-'));
  const stage = path.join(work, 'app');
  for (const rel of INCLUDE) copy(rel, stage);

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
  fs.copyFileSync(path.join(ROOT, 'installer/windows/setup.cmd'), path.join(pkg, 'setup.cmd'));
  const exe = path.join(work, 'CrewOfficeSetup.exe');
  const sed = [
    '[Version]', 'Class=IEXPRESS', 'SEDVersion=3',
    '[Options]', 'PackagePurpose=InstallApp', 'ShowInstallProgramWindow=0', 'HideExtractAnimation=1', 'UseLongFileName=1',
    'InsideCompressed=0', 'CAB_FixedSize=0', 'CAB_ResvCodeSigning=0', 'RebootMode=N',
    'InstallPrompt=%InstallPrompt%', 'DisplayLicense=%DisplayLicense%', 'FinishMessage=%FinishMessage%', 'TargetName=%TargetName%',
    'FriendlyName=%FriendlyName%', 'AppLaunched=%AppLaunched%', 'PostInstallCmd=%PostInstallCmd%',
    'AdminQuietInstCmd=%AdminQuietInstCmd%', 'UserQuietInstCmd=%UserQuietInstCmd%', 'SourceFiles=SourceFiles',
    '[Strings]', 'InstallPrompt=', 'DisplayLicense=', 'FinishMessage=', `TargetName=${exe}`,
    `FriendlyName=Crew Office ${version} Setup`, 'AppLaunched=cmd /c setup.cmd', 'PostInstallCmd=<None>',
    'AdminQuietInstCmd=', 'UserQuietInstCmd=', 'FILE0="setup.cmd"', 'FILE1="install.ps1"', 'FILE2="app.zip"',
    '[SourceFiles]', `SourceFiles0=${pkg}\\`, '[SourceFiles0]', '%FILE0%=', '%FILE1%=', '%FILE2%=',
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
