@echo off
rem Started by CrewOfficeSetup.exe from the folder it unpacked into.
title Crew Office setup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Source "%~dp0app.zip"
