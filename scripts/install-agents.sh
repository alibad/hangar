#!/bin/bash
#
# Install the launchd agents that keep the console and the manager running.
# macOS only. On Windows the equivalents are Scheduled Tasks; see
# scripts/start-console.ps1.
#
#   ./scripts/install-agents.sh            install (or reinstall) both
#   ./scripts/install-agents.sh --uninstall remove both
#
# WHY A SCRIPT AND NOT A COMMITTED PLIST: launchd requires absolute paths, and
# will not expand ~ or read an environment variable. A committed plist would
# therefore have to hardcode one person's checkout directory — which is what
# these files used to do, in eight places across two files, all of them wrong
# for anyone else. The templates carry __CONSOLE_DIR__ and this substitutes the
# real path at install time.
#
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agents_dir="$HOME/Library/LaunchAgents"
labels=(com.hangar.manager com.hangar.console)

if [ "$(uname)" != "Darwin" ]; then
  echo "This installs launchd agents and only works on macOS (found: $(uname))." >&2
  exit 1
fi

# Agents installed before the project was renamed from betenshi-console. Left in
# the uninstall list so a machine that upgrades does not end up running BOTH the
# old and the new agent on the same ports, which looks like a port conflict.
legacy=(com.betenshi.manager com.betenshi.console)

if [ "${1:-}" = "--uninstall" ]; then
  for label in "${legacy[@]}"; do
    launchctl bootout "gui/$UID/$label" 2>/dev/null || true
    rm -f "$agents_dir/$label.plist"
  done
  for label in "${labels[@]}"; do
    launchctl bootout "gui/$UID/$label" 2>/dev/null || true
    rm -f "$agents_dir/$label.plist"
    echo "removed $label"
  done
  exit 0
fi

# Retire any pre-rename agent first, for the same reason.
for label in "${legacy[@]}"; do
  if launchctl list | grep -q "$label"; then
    echo "retiring $label (pre-rename agent)"
    launchctl bootout "gui/$UID/$label" 2>/dev/null || true
    rm -f "$agents_dir/$label.plist"
  fi
done

mkdir -p "$agents_dir"

# The manager first: the console is usable without it but reports an empty
# machine, so starting them the other way round shows a misleading console for
# however long the manager takes to come up.
for label in "${labels[@]}"; do
  template="$root/scripts/$label.plist.template"
  target="$agents_dir/$label.plist"

  [ -f "$template" ] || { echo "missing template: $template" >&2; exit 1; }

  # The substitution this whole script exists for.
  sed "s|__CONSOLE_DIR__|$root|g" "$template" > "$target"

  if grep -q "__CONSOLE_DIR__" "$target"; then
    echo "FATAL: placeholder survived substitution in $target" >&2
    exit 1
  fi

  # bootout first so a reinstall picks up a changed path rather than silently
  # keeping the old one.
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$target"
  echo "installed $label  →  $target"
done

echo
echo "Both agents are RunAtLoad + KeepAlive: they start now, start at login,"
echo "and restart if they die."
echo
echo "  status    launchctl list | grep betenshi"
echo "  restart   launchctl kickstart -k gui/\$UID/com.hangar.console"
echo "  logs      tail -f $root/var/console.log"
echo
echo "The console needs a build before it will start: npm run build"
