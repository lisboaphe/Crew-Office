# Crew Office installer for Windows. Run by CrewOfficeSetup.exe, or by hand:
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Source app.zip
#
# Installs for the current user only (no administrator rights): the app goes to
# %LOCALAPPDATA%\Programs\CrewOffice, shortcuts go to the Start menu and the Desktop, and it
# is listed in Settings > Apps for uninstalling. Your offices (~\.roving-office) and your
# worker's keys (~\.crew-worker) live outside the app folder, so updating or uninstalling
# never touches them.

param(
  [string]$Source = (Join-Path $PSScriptRoot 'app.zip'),
  [string]$Target = (Join-Path $env:LOCALAPPDATA 'Programs\CrewOffice'),
  [switch]$NoShortcuts,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$MinNode = [version]'22.5.0'   # node:sqlite, the office's database, arrived in 22.5

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Ask($question) {
  if ($Quiet) { return $true }
  $answer = Read-Host "$question [Y/n]"
  return ($answer -eq '' -or $answer -match '^[Yy]')
}
function Fail($text) {
  Say $text 'Red'
  if (-not $Quiet) { Read-Host 'Press Enter to close' | Out-Null }
  exit 1
}

Say ''
Say '  Crew Office setup' 'Cyan'
Say '  A multiplayer office where every player brings their own AI team.' 'Cyan'
Say ''

# --- Node.js -----------------------------------------------------------------
function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) {
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
      if (Test-Path $p) { return $p }
    }
    return $null
  }
  return $cmd.Source
}

$node = Find-Node
$version = $null
if ($node) { try { $version = [version]((& $node --version).TrimStart('v')) } catch { $version = $null } }
if (-not $node -or -not $version -or $version -lt $MinNode) {
  if ($version) { Say "Node.js $version is installed, but Crew Office needs $MinNode or newer." 'Yellow' }
  else { Say 'Crew Office needs Node.js, which is not installed.' 'Yellow' }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget -and (Ask 'Install Node.js LTS now with winget?')) {
    & winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Find-Node
    if (-not $node) { Fail 'Node.js was installed but cannot be found yet. Sign out and in again, then run this setup once more.' }
  } else {
    Start-Process 'https://nodejs.org/en/download'
    Fail 'Install Node.js LTS from the page that just opened, then run this setup again.'
  }
}
$nodeDir = Split-Path $node -Parent
Say "Using Node.js $(& $node --version) at $node"

# --- Files ---------------------------------------------------------------------
if (-not (Test-Path $Source)) { Fail "Cannot find the app package: $Source" }
Say "Installing to $Target"
if (Test-Path $Target) {
  # An update: replace the app, keep nothing of the old one but its .env settings.
  $envFile = Join-Path $Target '.env'
  $keep = if (Test-Path $envFile) { Get-Content $envFile -Raw } else { $null }
  Remove-Item -Recurse -Force $Target
}
New-Item -ItemType Directory -Force $Target | Out-Null
Expand-Archive -Path $Source -DestinationPath $Target -Force
if ($keep) { Set-Content -Path (Join-Path $Target '.env') -Value $keep -Encoding utf8 -NoNewline }

# --- Optional runtime dependency (the Claude API adapter) ------------------------
$npm = Join-Path $nodeDir 'npm.cmd'
if (Test-Path $npm) {
  Say 'Installing the Anthropic SDK (used only for agents on an Anthropic API key)...'
  Push-Location $Target
  try { & $npm install --omit=dev --no-audit --no-fund --loglevel=error | Out-Host } catch { Say 'Skipped: agents on an Anthropic API key will not work until you run "npm install" in the app folder.' 'Yellow' }
  Pop-Location
}

# --- Shortcuts -----------------------------------------------------------------
$version = (Get-Content (Join-Path $Target 'package.json') -Raw | ConvertFrom-Json).version
$icon = Join-Path $Target 'favicon.ico'
if (-not $NoShortcuts) {
  $shell = New-Object -ComObject WScript.Shell
  function Link($path, $file, $arguments, $description) {
    $l = $shell.CreateShortcut($path)
    $l.TargetPath = $file
    $l.Arguments = $arguments
    $l.WorkingDirectory = $Target
    $l.IconLocation = $icon
    $l.Description = $description
    $l.Save()
  }
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Crew Office'
  New-Item -ItemType Directory -Force $menu | Out-Null
  Link (Join-Path $menu 'Crew Office.lnk') $node "`"$Target\bin\crew-app.cjs`"" 'Host or join a multiplayer AI office'
  Link (Join-Path $menu 'Crew Office (this computer only).lnk') $node "`"$Target\bin\crew-app.cjs`" --private" 'Run the office for this computer only'
  Link (Join-Path $menu 'Crew Office Worker.lnk') $node "`"$Target\bin\crew-worker.cjs`"" 'Run your AI agents on this computer with your own keys or subscriptions'
  Link (Join-Path $menu 'Uninstall Crew Office.lnk') 'powershell.exe' "-ExecutionPolicy Bypass -File `"$Target\installer\windows\uninstall.ps1`"" 'Remove Crew Office'
  Link (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Crew Office.lnk') $node "`"$Target\bin\crew-app.cjs`"" 'Host or join a multiplayer AI office'

  # Settings > Apps, for this user.
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CrewOffice'
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty $key -Name DisplayName -Value 'Crew Office'
  Set-ItemProperty $key -Name DisplayVersion -Value $version
  Set-ItemProperty $key -Name Publisher -Value 'Crew Office (based on The Roving Office)'
  Set-ItemProperty $key -Name InstallLocation -Value $Target
  Set-ItemProperty $key -Name DisplayIcon -Value $icon
  Set-ItemProperty $key -Name UninstallString -Value "powershell.exe -ExecutionPolicy Bypass -File `"$Target\installer\windows\uninstall.ps1`""
  Set-ItemProperty $key -Name NoModify -Value 1 -Type DWord
  Set-ItemProperty $key -Name NoRepair -Value 1 -Type DWord
}

Say ''
Say "Crew Office $version is installed." 'Green'
Say '  - "Crew Office" on your Desktop and in the Start menu hosts an office and opens the lobby.'
Say '  - Windows may ask whether Node.js may use the network: allow it on private networks so friends can join.'
Say '  - "Crew Office Worker" runs your AI agents on this computer (connect it from Dashboard > My workers).'
Say ''
if (-not $Quiet -and -not $NoShortcuts -and (Ask 'Start Crew Office now?')) {
  Start-Process -FilePath $node -ArgumentList "`"$Target\bin\crew-app.cjs`"" -WorkingDirectory $Target
}
