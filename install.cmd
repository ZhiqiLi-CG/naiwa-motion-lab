@echo off
rem Naiwa Motion Lab: one-click install for Windows. Double-click it, or run: install.cmd [-Yes] [-SkipNode] [-Force]
rem Checks Node.js (installs Node.js LTS with winget if needed), runs npm ci, prints a summary.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
set "NAIWA_CODE=%ERRORLEVEL%"
endlocal & exit /b %NAIWA_CODE%
