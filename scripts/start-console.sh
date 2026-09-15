#!/bin/bash
#
# Launcher for the "BeTenshi Console" launchd agent on B5 (macOS).
#
# The Mac sibling of start-console.ps1, and it exists for the same two reasons
# that one does, plus one this platform adds.
#
#   1) NO LOG. A console started by hand writes to a terminal that is closed by
#      the time anything goes wrong. Everything is redirected here instead, and
#      rotated, so there is something to read.
#
#   2) SESSION-OWNED LIFETIME. Agent sessions kept starting the console
#      themselves, which puts the server inside that session's process tree --
#      it dies when the session does. Worse on this box than on BeTenshi: three
#      orphaned next-servers were found listening on 8013, 8014 and 8015, none
#      of them on the port anyone was looking at, each serving whatever the code
#      said when it started. That is how a stale UI gets mistaken for a missing
#      feature. launchd owns this process, so KeepAlive actually applies.
#
#        Start it with:  launchctl kickstart -k gui/$UID/com.betenshi.console
#        Never with:     npm run dev
#
#   3) NODE VERSION. node:sqlite is a Node 22 builtin and /api/scout imports it;
#      under the Node 20 that is first on PATH here the build dies with
#      ERR_UNKNOWN_BUILTIN_MODULE. launchd does not run a login shell, so nvm is
#      never sourced and PATH would be the bare system one. The interpreter is
#      therefore resolved explicitly below rather than inherited.
#
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Highest installed Node >= 22, or whatever is on PATH if nvm is not present.
node_bin=""
if [ -d "$HOME/.nvm/versions/node" ]; then
  for d in $(ls -1 "$HOME/.nvm/versions/node" | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n -r); do
    major="${d%%.*}"
    if [ "$major" -ge 22 ] 2>/dev/null; then
      node_bin="$HOME/.nvm/versions/node/v$d/bin"
      break
    fi
  done
fi
[ -n "$node_bin" ] && export PATH="$node_bin:$PATH"

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo "FATAL: need Node >= 22, found $(node --version 2>/dev/null || echo none)." >&2
  echo "       /api/scout imports node:sqlite, a 22 builtin. Install it: nvm install 22" >&2
  exit 1
fi

mkdir -p var
log="var/console.log"
# Rotate rather than grow without bound: the ad-hoc redirect on BeTenshi reached
# 6.4 MB before anyone noticed.
if [ -f "$log" ] && [ "$(stat -f%z "$log")" -gt 5242880 ]; then
  mv -f "$log" "$log.1"
fi

if [ ! -d ".next" ]; then
  echo "FATAL: no .next build. Run: npm run build" >&2
  exit 1
fi

echo "=== console starting $(date '+%Y-%m-%d %H:%M:%S') on $(node --version) ===" >> "$log"

# Foreground, so launchd watches the real server and not a launcher that exits
# immediately. Port comes from package.json's start script -- 8003, the same
# address as BeTenshi, because it is the same product.
exec npm start >> "$log" 2>&1
