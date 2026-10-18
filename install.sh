#!/usr/bin/env bash
# Naiwa Motion Lab: one-click install for Linux (and macOS). No sudo needed.
#
#   ./install.sh [--yes] [--skip-node] [--force]
#
#   --yes        non-interactive: install Node.js LTS with nvm without asking (also NAIWA_YES=1)
#   --skip-node  never install Node.js (fail with a message instead)
#   --force      run npm ci even when node_modules is already up to date
#
# Steps: Node.js >= 18.19 and npm (installs nvm + Node.js LTS into your home if needed) -> npm ci -> summary.
# Safe to rerun.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1
# shellcheck source=scripts/lib.sh
. "$REPO/scripts/lib.sh"

NVM_VERSION="v0.40.3"
YES="${NAIWA_YES:-0}"
SKIP_NODE=0
FORCE=0
for a in "$@"; do
  case "$a" in
    -y | --yes) YES=1 ;;
    --skip-node) SKIP_NODE=1 ;;
    -f | --force) FORCE=1 ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) naiwa_warn "未知选项 / unknown option: $a"; exit 2 ;;
  esac
done

fail() {
  printf '\n\033[31m[naiwa] 安装失败 / install failed:\033[0m %s\n' "$*" >&2
  exit 1
}

echo
naiwa_say "Naiwa Motion Lab 安装 / install  ($REPO)"

# ---- 1. Node.js + npm ----
if naiwa_find_node; then
  naiwa_say "Node.js $("$NAIWA_NODE" -v) 可用 / found ($NAIWA_NODE)"
else
  old="$(command -v node 2>/dev/null || true)"
  case "$old" in /mnt/*) old="" ;; esac
  if [ -n "$old" ]; then naiwa_warn "Node.js $("$old" -v 2>/dev/null) 太旧，需要 >= $NAIWA_MIN_NODE / too old, >= $NAIWA_MIN_NODE needed"
  else naiwa_warn "没有找到 Node.js / Node.js not found (需要 / needed: >= $NAIWA_MIN_NODE)"; fi
  [ "$SKIP_NODE" = 1 ] && fail "请先安装 Node.js LTS / install Node.js LTS first (https://nodejs.org/ or https://github.com/nvm-sh/nvm)"
  if [ "$YES" != 1 ]; then
    echo
    echo "  将用 nvm 把 Node.js LTS 安装到你的主目录 (~/.nvm)，不需要 sudo；nvm 会在 ~/.bashrc 里加几行加载代码。"
    echo "  Node.js LTS will be installed with nvm into your home (~/.nvm), no sudo; nvm adds a few lines to ~/.bashrc."
    if [ -r /dev/tty ]; then
      printf '  继续吗 / continue? [Y/n] '
      read -r answer </dev/tty || answer=""
    else
      fail "没有终端可以确认 / no terminal to confirm: rerun with --yes to install Node.js LTS via nvm"
    fi
    case "$answer" in [nN]*) fail "已跳过 Node.js 安装 / skipped installing Node.js: install it (https://nodejs.org/) and rerun ./install.sh" ;; esac
  fi
  if ! naiwa_load_nvm; then
    naiwa_say "安装 nvm $NVM_VERSION / installing nvm $NVM_VERSION …"
    url="https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh"
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" | bash
    elif command -v wget >/dev/null 2>&1; then wget -qO- "$url" | bash
    else fail "需要 curl 或 wget 来下载 nvm / curl or wget is needed to download nvm"; fi
    naiwa_load_nvm || fail "nvm 安装失败 / nvm install failed (see the messages above)"
  fi
  naiwa_say "nvm install --lts …"
  nvm install --lts || fail "nvm install --lts 失败 / failed (check the network)"
  nvm alias default 'lts/*' >/dev/null 2>&1 || true
  naiwa_find_node || fail "Node.js 安装后仍不可用 / Node.js still unavailable after nvm install"
  naiwa_say "Node.js $("$NAIWA_NODE" -v) 已安装 / installed ($NAIWA_NODE)"
  naiwa_say "新开的终端里 node/npm 才会自动可用 / open a new terminal to use node/npm directly (start.sh finds it either way)"
fi
[ -n "$NAIWA_NPM" ] || fail "没有找到 npm / npm not found (它随 Node.js 一起安装 / it comes with Node.js)"
naiwa_say "npm $("$NAIWA_NPM" --version) 可用 / found"

# ---- 2. dependencies ----
cd "$REPO" || fail "cannot cd to $REPO"
if [ "$FORCE" != 1 ] && "$NAIWA_NODE" scripts/doctor.mjs deps >/dev/null 2>&1; then
  naiwa_say "依赖已是最新，跳过 npm ci / dependencies already up to date, skipping npm ci (--force to reinstall)"
else
  if [ -f package-lock.json ]; then cmd=ci; else cmd=install; fi
  naiwa_say "npm $cmd …（第一次可能要几分钟 / may take a few minutes the first time）"
  "$NAIWA_NPM" "$cmd" --no-audit --no-fund || fail "npm $cmd 失败 / failed. 检查网络后重新运行 ./install.sh / check the network (or npm registry/proxy settings) and rerun ./install.sh"
  "$NAIWA_NODE" scripts/doctor.mjs deps || fail "安装后依赖仍不完整 / dependencies still incomplete after npm $cmd"
fi

# ---- 3. summary ----
"$NAIWA_NODE" scripts/doctor.mjs summary || fail "环境检查没有通过 / the environment check failed"
naiwa_say "安装完成 / install complete. 运行 / run: ./start.sh"
