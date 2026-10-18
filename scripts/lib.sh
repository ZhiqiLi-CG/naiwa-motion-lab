# Shared by install.sh and start.sh (bash). Finds a usable Node.js (>= 18.19): the one on PATH, else nvm's.
# Inside WSL, Windows programs on PATH (/mnt/c/...) never count.

NAIWA_MIN_NODE="18.19"

naiwa_say() { printf '\033[36m[naiwa]\033[0m %s\n' "$*"; }
naiwa_warn() { printf '\033[33m[naiwa]\033[0m %s\n' "$*" >&2; }

# naiwa_node_ok <node>: is it a Linux/macOS node >= 18.19?
naiwa_node_ok() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  case "$1" in /mnt/*) return 1 ;; esac
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>18||(a===18&&b>=19)?0:1)' >/dev/null 2>&1
}

# naiwa_load_nvm: source nvm if it is installed (no-op otherwise). Returns 1 when there is no nvm.
naiwa_load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] || return 1
  if ! command -v nvm >/dev/null 2>&1; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" --no-use
  fi
  return 0
}

# naiwa_find_node: sets NAIWA_NODE and NAIWA_NPM (and puts node's dir first on PATH). Returns 1 when none is usable.
naiwa_find_node() {
  NAIWA_NODE=""
  NAIWA_NPM=""
  local n
  n="$(command -v node 2>/dev/null || true)"
  if ! naiwa_node_ok "$n" && naiwa_load_nvm; then
    nvm use --silent default >/dev/null 2>&1 || nvm use --silent 'lts/*' >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true
    n="$(command -v node 2>/dev/null || true)"
  fi
  naiwa_node_ok "$n" || return 1
  NAIWA_NODE="$n"
  local dir
  dir="$(dirname "$n")"
  export PATH="$dir:$PATH"
  if [ -x "$dir/npm" ]; then NAIWA_NPM="$dir/npm"; else NAIWA_NPM="$(command -v npm 2>/dev/null || true)"; fi
  case "$NAIWA_NPM" in /mnt/*) NAIWA_NPM="" ;; esac
  return 0
}
