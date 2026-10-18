#!/usr/bin/env bash
# Naiwa Motion Lab: one-click run for Linux (and macOS).
#
#   ./start.sh [--no-lab] [--no-open] [--port N] [--host [addr]] [--prod]
#
# Installs what is missing first (./install.sh), starts the page (and the local Lab when Codex CLI is logged in),
# opens the browser when there is a display. Ctrl+C stops everything.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1
# shellcheck source=scripts/lib.sh
. "$REPO/scripts/lib.sh"

if ! naiwa_find_node; then
  naiwa_say "没有可用的 Node.js，先运行安装 / no usable Node.js: running ./install.sh first"
  bash "$REPO/install.sh" || exit 1
  naiwa_find_node || { naiwa_warn "Node.js 仍不可用 / Node.js still unavailable"; exit 1; }
fi
exec "$NAIWA_NODE" "$REPO/scripts/start.mjs" "$@"
