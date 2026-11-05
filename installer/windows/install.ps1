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
  [switch]$Quiet,
  [int]$WaitPid = 0,        # an update from inside the app: wait for it to stop first
  [switch]$Relaunch,        # ...and start it again afterwards, whether or not this worked
  [string]$AppArgs = ''
)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Crew Office setup'
$MinNode = [version]'22.5.0'   # node:sqlite, the office's database, arrived in 22.5

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Ask($question) {
  if ($Quiet) { return $true }
  $answer = Read-Host "$question [Y/n]"
  return ($answer -eq '' -or $answer -match '^[Yy]')
}
function StartApp {
  $app = Join-Path $Target 'bin\crew-app.cjs'
  if (-not $node -or -not (Test-Path $app)) { return }
  $arguments = "`"$app`" $AppArgs".Trim()
  Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $Target -WindowStyle Minimized
}
function Fail($text) {
  Say $text 'Red'
  if ($Relaunch) { StartApp }
  if (-not $Quiet) { Read-Host 'Press Enter to close' | Out-Null }
  exit 1
}
trap { Fail "Setup stopped: $_" }

if ($WaitPid) { Wait-Process -Id $WaitPid -Timeout 30 -ErrorAction SilentlyContinue }

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
# The new copy is built beside the old one and swapped in at the end, so a failure at any
# point leaves the installed app whole. Of the old copy only its .env settings are kept.
$stage = "$Target.new"
$old = "$Target.old"
foreach ($leftover in @($stage, $old)) { if (Test-Path $leftover) { Remove-Item -Recurse -Force $leftover } }
New-Item -ItemType Directory -Force $stage | Out-Null
Expand-Archive -Path $Source -DestinationPath $stage -Force
$envFile = Join-Path $Target '.env'
if (Test-Path $envFile) { Copy-Item $envFile (Join-Path $stage '.env') }

# --- Optional runtime dependency (the Claude API adapter) ------------------------
$npm = Join-Path $nodeDir 'npm.cmd'
if (Test-Path $npm) {
  Say 'Installing the Anthropic SDK (used only for agents on an Anthropic API key)...'
  Push-Location $stage
  try { & $npm install --omit=dev --no-audit --no-fund --loglevel=error | Out-Host } catch { Say 'Skipped: agents on an Anthropic API key will not work until you run "npm install" in the app folder.' 'Yellow' }
  Pop-Location
}

# --- The swap ------------------------------------------------------------------
if (Test-Path $Target) {
  try { Rename-Item -Path $Target -NewName (Split-Path $old -Leaf) }
  catch {
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
    Fail 'Something is using the Crew Office folder, so nothing was changed. Close any Crew Office Worker window, or any terminal open in that folder, and try again.'
  }
}
Rename-Item -Path $stage -NewName (Split-Path $Target -Leaf)
if (Test-Path $old) { Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue }

# --- Shortcuts -----------------------------------------------------------------
$version = (Get-Content (Join-Path $Target 'package.json') -Raw | ConvertFrom-Json).version
$icon = Join-Path $Target 'favicon.ico'
if (-not $NoShortcuts) {
  $shell = New-Object -ComObject WScript.Shell
  # $style 7 starts minimized: the app's launcher only lives for a moment, then its window opens.
  function Link($path, $file, $arguments, $description, $style = 1) {
    $l = $shell.CreateShortcut($path)
    $l.TargetPath = $file
    $l.Arguments = $arguments
    $l.WorkingDirectory = $Target
    $l.IconLocation = $icon
    $l.Description = $description
    $l.WindowStyle = $style
    $l.Save()
  }
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Crew Office'
  New-Item -ItemType Directory -Force $menu | Out-Null
  Link (Join-Path $menu 'Crew Office.lnk') $node "`"$Target\bin\crew-app.cjs`"" 'Host or join a multiplayer AI office' 7
  Link (Join-Path $menu 'Crew Office (this computer only).lnk') $node "`"$Target\bin\crew-app.cjs`" --private" 'Run the office for this computer only' 7
  Link (Join-Path $menu 'Crew Office Worker.lnk') $node "`"$Target\bin\crew-worker.cjs`"" 'Run your AI agents on this computer with your own keys or subscriptions'
  Link (Join-Path $menu 'Uninstall Crew Office.lnk') 'powershell.exe' "-ExecutionPolicy Bypass -File `"$Target\installer\windows\uninstall.ps1`"" 'Remove Crew Office'
  Link (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Crew Office.lnk') $node "`"$Target\bin\crew-app.cjs`"" 'Host or join a multiplayer AI office' 7

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
Say '  - "Crew Office Worker" runs your AI agents on this computer (add it from Dashboard > My Crew).'
Say ''
if ($Relaunch -or (-not $Quiet -and -not $NoShortcuts -and (Ask 'Start Crew Office now?'))) { StartApp }
