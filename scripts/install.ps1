<#
  Naiwa Motion Lab: one-click install for Windows (run by install.cmd).

    install.cmd [-Yes] [-SkipNode] [-Force]

    -Yes       non-interactive: install Node.js LTS with winget without asking, no pause at the end (also NAIWA_YES=1)
    -SkipNode  never install Node.js (fail with a message instead)
    -Force     run npm ci even when node_modules is already up to date
    -NoPause   never wait for Enter at the end (install.cmd pauses only when double-clicked)

  Steps: Node.js >= 18.19 and npm (installs Node.js LTS via winget if needed) -> npm ci -> summary. Safe to rerun.
#>
param([switch]$Yes, [switch]$SkipNode, [switch]$Force, [switch]$NoPause)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
if ($env:NAIWA_YES -eq '1') { $Yes = $true }

$Repo = Split-Path -Parent $PSScriptRoot
$MinNode = [version]'18.19.0'

function Say([string]$msg) { Write-Host "[naiwa] $msg" -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host "[naiwa] $msg" -ForegroundColor Yellow }

# Pause before the window closes when the script was started by double-clicking install.cmd in Explorer.
function Test-FromExplorer {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
    $cmd = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
    $gp = Get-CimInstance Win32_Process -Filter "ProcessId=$($cmd.ParentProcessId)"
    return ($gp.Name -ieq 'explorer.exe')
  } catch { return $false }
}
$Pause = (-not $Yes) -and (-not $NoPause) -and (Test-FromExplorer)
function Done([int]$code) {
  if ($Pause) { Read-Host '按回车键关闭 / press Enter to close' | Out-Null }
  exit $code
}
function Fail([string]$msg) {
  Write-Host ""
  Write-Host "[naiwa] 安装失败 / install failed: $msg" -ForegroundColor Red
  Done 1
}

function Update-PathFromRegistry {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
  $nodeDir = Join-Path $env:ProgramFiles 'nodejs'
  if ((Test-Path (Join-Path $nodeDir 'node.exe')) -and ($env:Path -notlike "*$nodeDir*")) { $env:Path = "$nodeDir;$env:Path" }
}

function Get-NodeVersion {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { return $null }
  try {
    $v = (& $node.Source -p 'process.versions.node' 2>$null | Select-Object -First 1)
    return [version]($v.Trim())
  } catch { return $null }
}

Write-Host ""
Say "Naiwa Motion Lab 安装 / install  ($Repo)"

# ---- 1. Node.js + npm ----
$v = Get-NodeVersion
if (-not $v) { Update-PathFromRegistry; $v = Get-NodeVersion }
if ($v -and $v -ge $MinNode) {
  Say "Node.js $v 可用 / found"
} else {
  if ($v) { Warn "Node.js $v 太旧，需要 >= $MinNode / too old, >= $MinNode needed" }
  else { Warn "没有找到 Node.js / Node.js not found (需要 / needed: >= $MinNode)" }
  if ($SkipNode) { Fail "请先安装 Node.js LTS / install Node.js LTS first: https://nodejs.org/ (or: winget install OpenJS.NodeJS.LTS)" }
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) { Fail "没有 winget，请手动安装 Node.js LTS 后重新运行 / winget not available: install Node.js LTS from https://nodejs.org/ and rerun install.cmd" }
  if (-not $Yes) {
    Write-Host ""
    Write-Host "  将用 winget 安装 Node.js LTS（可能弹出管理员权限确认）。" -ForegroundColor White
    Write-Host "  Node.js LTS will be installed with winget (Windows may ask for administrator approval)." -ForegroundColor White
    $answer = Read-Host '  继续吗 / continue? [Y/n]'
    if ($answer -match '^\s*[nN]') { Fail "已跳过 Node.js 安装 / skipped installing Node.js: install it from https://nodejs.org/ and rerun install.cmd" }
  }
  Say "winget install OpenJS.NodeJS.LTS …"
  & $winget.Source install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
  $wingetCode = $LASTEXITCODE
  Update-PathFromRegistry
  $v = Get-NodeVersion
  if ((-not $v -or $v -lt $MinNode)) {
    Say "winget upgrade OpenJS.NodeJS.LTS …"
    & $winget.Source upgrade --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
    Update-PathFromRegistry
    $v = Get-NodeVersion
  }
  if (-not $v -or $v -lt $MinNode) { Fail "Node.js 安装后仍不可用 (winget exit $wingetCode) / Node.js still unavailable after winget. 关闭窗口重新运行，或从 https://nodejs.org/ 安装 / reopen the window and rerun, or install from https://nodejs.org/" }
  Say "Node.js $v 已安装 / installed"
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { Fail "没有找到 npm / npm not found (它随 Node.js 一起安装 / it comes with Node.js: reinstall Node.js LTS)" }
$npmVersion = (& $npm.Source --version 2>$null | Select-Object -First 1)
Say "npm $npmVersion 可用 / found"

# ---- 2. dependencies ----
Set-Location -LiteralPath $Repo
$ready = $false
if (-not $Force) {
  & node scripts/doctor.mjs deps *> $null
  $ready = ($LASTEXITCODE -eq 0)
}
if ($ready) {
  Say "依赖已是最新，跳过 npm ci / dependencies already up to date, skipping npm ci (-Force to reinstall)"
} else {
  $hasLock = Test-Path -LiteralPath (Join-Path $Repo 'package-lock.json')
  $npmArgs = if ($hasLock) { @('ci', '--no-audit', '--no-fund') } else { @('install', '--no-audit', '--no-fund') }
  Say "npm $($npmArgs[0]) …（第一次可能要几分钟 / may take a few minutes the first time）"
  & $npm.Source @npmArgs
  if ($LASTEXITCODE -ne 0) { Fail "npm $($npmArgs[0]) 失败 (exit $LASTEXITCODE)。检查网络后重新运行 install.cmd / check the network (or npm registry/proxy settings) and rerun install.cmd" }
  & node scripts/doctor.mjs deps
  if ($LASTEXITCODE -ne 0) { Fail "安装后依赖仍不完整 / dependencies still incomplete after npm $($npmArgs[0])" }
}

# ---- 3. summary ----
& node scripts/doctor.mjs summary
if ($LASTEXITCODE -ne 0) { Fail "环境检查没有通过 / the environment check failed" }
Say "安装完成 / install complete. 双击 start.cmd 启动 / double-click start.cmd to run."
Done 0
