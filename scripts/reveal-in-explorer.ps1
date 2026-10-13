# Show a folder (or select a file) in Explorer, IN FRONT of whatever has focus.
#
#   powershell -File scripts/reveal-in-explorer.ps1 -Path <dir>
#   powershell -File scripts/reveal-in-explorer.ps1 -Path <file> -Select
#
# The console's server is a background process, and Windows refuses focus to a
# background process: a bare `explorer.exe <path>` opens the window BEHIND the
# browser, which looks exactly like the button doing nothing (and every retry
# stacks up another hidden window). So this script:
#   1. reuses an Explorer window already showing the folder, if there is one;
#   2. otherwise opens one and waits for it to appear;
#   3. brings it to the front with SwitchToThisWindow (what Alt+Tab uses). The
#      textbook route, SetForegroundWindow after attaching to the foreground
#      thread's input, returned true here while the browser kept focus, so it
#      is only the fallback, and "focused" is read back, not assumed.
# Prints one line of JSON for the caller.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$Select
)
$ErrorActionPreference = 'Stop'

Add-Type -Namespace Reveal -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
'@

try {
  $target = (Resolve-Path -LiteralPath $Path).ProviderPath
  $folder = if ($Select) { Split-Path -Parent $target } else { $target }
  $folder = $folder.TrimEnd('\')
  $shell = New-Object -ComObject Shell.Application

  function Find-Window {
    foreach ($w in @($shell.Windows())) {
      try { if ($w.Document.Folder.Self.Path.TrimEnd('\') -ieq $folder) { return $w } } catch { }
    }
    return $null
  }

  $win = Find-Window
  $reused = [bool]$win
  if (-not $win) {
    if ($Select) { Start-Process explorer.exe -ArgumentList "/select,`"$target`"" }
    else { Start-Process explorer.exe -ArgumentList "`"$folder`"" }
    for ($i = 0; $i -lt 30 -and -not $win; $i++) { Start-Sleep -Milliseconds 200; $win = Find-Window }
  } elseif ($Select) {
    # 1 select | 4 deselect others | 8 ensure visible | 16 focus
    try { $win.Document.SelectItem($win.Document.Folder.ParseName((Split-Path -Leaf $target)), 29) } catch { }
  }

  $focused = $false
  if ($win) {
    $h = [IntPtr]$win.HWND
    if ([Reveal.Win]::IsIconic($h)) { [void][Reveal.Win]::ShowWindow($h, 9) } # SW_RESTORE
    [Reveal.Win]::SwitchToThisWindow($h, $true)
    Start-Sleep -Milliseconds 150
    $focused = [Reveal.Win]::GetForegroundWindow() -eq $h
    if (-not $focused) {
      $fgThread = [Reveal.Win]::GetWindowThreadProcessId([Reveal.Win]::GetForegroundWindow(), [IntPtr]::Zero)
      $me = [Reveal.Win]::GetCurrentThreadId()
      $attached = $fgThread -ne 0 -and $fgThread -ne $me -and [Reveal.Win]::AttachThreadInput($me, $fgThread, $true)
      [void][Reveal.Win]::BringWindowToTop($h)
      [void][Reveal.Win]::SetForegroundWindow($h)
      if ($attached) { [void][Reveal.Win]::AttachThreadInput($me, $fgThread, $false) }
      Start-Sleep -Milliseconds 150
      $focused = [Reveal.Win]::GetForegroundWindow() -eq $h
    }
  }

  [pscustomobject]@{ ok = [bool]$win; path = $target; reused = $reused; focused = [bool]$focused } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; path = $Path; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
