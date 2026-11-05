# Makes crewoffice:// links open Crew Office, for this user only. No administrator rights.
#
# The link goes to open-invitation.vbs rather than to node.exe, which would flash a console window
# on every click. %1 is whatever the link said, from anywhere on the internet: it is quoted here,
# stripped of quotes there, and crew-app.cjs only acts on it if it parses as an invitation.

param(
  [Parameter(Mandatory = $true)][string]$Node,
  [string]$Scheme = 'crewoffice',
  [string]$App = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
)

$ErrorActionPreference = 'Stop'
$key = "HKCU:\Software\Classes\$Scheme"
$launcher = Join-Path $App 'installer\windows\open-invitation.vbs'

New-Item -Path "$key\shell\open\command" -Force | Out-Null
New-Item -Path "$key\DefaultIcon" -Force | Out-Null
Set-Item -Path $key -Value 'URL:Crew Office invitation'
New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-Item -Path "$key\DefaultIcon" -Value (Join-Path $App 'favicon.ico')
Set-Item -Path "$key\shell\open\command" -Value "wscript.exe //nologo `"$launcher`" `"$Node`" `"%1`""
