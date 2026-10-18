@echo off
rem Naiwa Motion Lab: one-click run for Windows. Double-click it, or run: start.cmd [--no-lab] [--no-open] [--port N] [--host] [--prod]
rem Installs what is missing first, starts the page (and the local Lab when Codex CLI is logged in), opens the browser.
rem Ctrl+C stops everything.
setlocal
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo [naiwa] Node.js not found: running install.cmd first ...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -NoPause
  if errorlevel 1 goto failed
  if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
node "%~dp0scripts\start.mjs" %*
if errorlevel 1 goto failed
endlocal & exit /b 0

:failed
set "NAIWA_CODE=%ERRORLEVEL%"
if not defined NAIWA_NO_PAUSE pause
endlocal & exit /b %NAIWA_CODE%
