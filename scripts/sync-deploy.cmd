@echo off
setlocal
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-deploy.ps1" %*
if errorlevel 1 pause
