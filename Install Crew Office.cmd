@echo off
rem Double-click to install Crew Office from this folder: a source download or a checkout.
rem It does what CrewOfficeSetup.exe does - checks for Node.js (offering to install it),
rem packages the app, installs it for this user, adds the shortcuts and starts it.
rem No terminal, npm or PowerShell settings needed: the script runs with its own policy.
title Crew Office setup
if not exist "%~dp0installer\windows\install.ps1" (
  echo This file has to stay in the Crew Office folder it came in. Unzip the whole download, then run it from there.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\windows\install.ps1" -FromCheckout "%~dp0."
