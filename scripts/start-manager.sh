#!/bin/bash
#
# Launcher for the "BeTenshi Manager" launchd agent on B5 (macOS).
#
# The manager is not optional furniture. Without it on :8099 the console still
# renders, but /api/resources answers "Manager error: fetch failed" and the whole
# top of the Home page degrades at once: Machine capacity reads "Telemetry
# unavailable" at 0.0 / 128.0 GB, the ready/on-demand counts sit at zero, and
# every workstream shows "On demand" however resident its model actually is.
# None of that looks like a missing supervisor — it looks like an empty box.
#
# Same three reasons as start-console.sh: a log that outlives the terminal, an
# owner that is not an agent session, and an interpreter resolved explicitly
# because launchd runs no login shell and never sources nvm.
#
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

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

mkdir -p var
log="var/manager.log"
if [ -f "$log" ] && [ "$(stat -f%z "$log")" -gt 5242880 ]; then
  mv -f "$log" "$log.1"
fi

echo "=== manager starting $(date '+%Y-%m-%d %H:%M:%S') on $(node --version) ===" >> "$log"

# Foreground, so launchd watches the real server.
exec node scripts/manager.cjs >> "$log" 2>&1
