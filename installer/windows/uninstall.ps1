# Removes Crew Office for the current user: the app folder, its shortcuts and its entry in
# Settings > Apps. Your offices and your worker's keys are kept unless you say otherwise.

param([switch]$Quiet, [switch]$RemoveData)

$Target = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
function Ask($q) { if ($Quiet) { return $false } $a = Read-Host "$q [y/N]"; return ($a -match '^[Yy]') }

Write-Host "Removing Crew Office from $Target" -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$Target*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Remove-Item -Recurse -Force (Join-Path ([Environment]::GetFolderPath('Programs')) 'Crew Office') -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Crew Office.lnk') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CrewOffice' -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'HKCU:\Software\Classes\crewoffice' -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA 'CrewOffice') -ErrorAction SilentlyContinue   # the app window's profile

if ($RemoveData -or (Ask 'Also delete your offices, projects and worker keys (~\.roving-office\crew, ~\.crew-worker)?')) {
  Remove-Item -Recurse -Force (Join-Path $HOME '.roving-office\crew') -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force (Join-Path $HOME '.crew-worker') -ErrorAction SilentlyContinue
}

Set-Location $env:TEMP
Remove-Item -Recurse -Force $Target -ErrorAction SilentlyContinue
Write-Host 'Crew Office has been removed.' -ForegroundColor Green
if (-not $Quiet) { Read-Host 'Press Enter to close' | Out-Null }
