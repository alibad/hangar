<#
  Launcher for the "BeTenshi Console" scheduled task (runs at logon).

  Two problems this solves.

  1) NO LOG. The task ran `npm run dev` with no redirection, so the dev server's
     output went nowhere. When the console disappeared there was nothing to read
     and the cause could only be inferred from process ancestry.

  2) SESSION-OWNED LIFETIME. The console kept dying because agent sessions
     started it with `npm run dev`, which puts the dev server inside that
     session's process tree -- it exits when the session does. The scheduled task
     already has restart-on-failure (RestartCount 999 / 1 min), but that only
     covers the process the TASK started. Route every start through here and the
     scheduler is the owner, so those settings actually apply.

     Start it with:  Start-ScheduledTask -TaskName "BeTenshi Console"
     Never with:     npm run dev

  Runs npm in the foreground so Task Scheduler watches the real process rather
  than a launcher that exits immediately.

  Keep this file pure ASCII: Windows PowerShell 5.1 reads a BOM-less script as
  ANSI, and a UTF-8 dash decodes into a run containing a curly quote, which
  silently terminates a string literal. (Same trap as start-qwen-watchdog.ps1.)
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$varDir = Join-Path $root 'var'
if (-not (Test-Path $varDir)) { New-Item -ItemType Directory -Path $varDir | Out-Null }
$log = Join-Path $varDir 'console.log'

# Rotate rather than grow without bound. The previous ad-hoc redirect reached
# 6.4 MB with no rotation at all.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
  Move-Item $log "$log.1" -Force
}

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  try { Add-Content -Path $log -Value $line -Encoding utf8 -ErrorAction Stop } catch { }
}

# If something already holds :8003 the dev server would exit with EADDRINUSE and
# Task Scheduler would restart it every minute, forever, logging nothing useful.
# Say so once and stop -- a port held by a session-started server is the case
# this launcher exists to replace, and it needs a human to clear it.
$busy = Get-NetTCPConnection -LocalPort 8003 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $owner = Get-Process -Id $busy[0].OwningProcess -ErrorAction SilentlyContinue
  Write-Log ("port 8003 already held by pid {0} ({1}) - not starting a second console" -f `
             $busy[0].OwningProcess, $(if ($owner) { $owner.Name } else { 'unknown' }))
  exit 0
}

Write-Log 'starting console (npm run dev)'
# cmd.exe owns the redirection so PowerShell never turns npm's stderr into a
# terminating NativeCommandError -- next dev writes ordinary warnings there.
& cmd.exe /c "`"$env:ProgramFiles\nodejs\npm.cmd`" run dev >> `"$log`" 2>&1"
$code = $LASTEXITCODE
Write-Log "console exited with $code"
exit $code
