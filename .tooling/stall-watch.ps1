# Stall watch for long unattended runs (no LLM involved).
# Run every 10 minutes by Task Scheduler (task "gimoza-stall-watch").
# If the newest commit on any branch is older than the threshold, append one line to
# .tooling/stall-watch.log (at most once per hour per stalled commit).
# Every run overwrites .tooling/stall-watch.heartbeat.log so we can see the watcher itself is alive.
# ASCII only on purpose: Task Scheduler starts Windows PowerShell 5.1, which misreads BOM-less UTF-8.
param(
  [int]$ThresholdMinutes = 60
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$log = Join-Path $PSScriptRoot 'stall-watch.log'
$beat = Join-Path $PSScriptRoot 'stall-watch.heartbeat.log'
$state = Join-Path $PSScriptRoot 'stall-watch.state.log'
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$now = Get-Date
$nowText = $now.ToString('yyyy-MM-dd HH:mm:ss', $inv)

try {
  # --all: worktrees commit on their own branches while main HEAD sits still during verification.
  $line = (& git -C $repo log -1 '--format=%ct %h' --all) | Select-Object -First 1
  $parts = $line.Trim().Split(' ')
  $commitAt = [DateTimeOffset]::FromUnixTimeSeconds([long]$parts[0]).LocalDateTime
  $hash = $parts[1]
  $ageMin = [int][Math]::Floor(($now - $commitAt).TotalMinutes)

  # Context only: when did the Claude session transcript last change (pinpoint dir, no recursion).
  $tdir = 'C:\Users\asteain-ninia\.claude\projects\e--WORKSPACE-time-map-app-4'
  $tAgeText = 'unknown'
  if (Test-Path $tdir) {
    $newest = Get-ChildItem -LiteralPath $tdir -Filter '*.jsonl' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) { $tAgeText = ('{0}min' -f [int][Math]::Floor(($now - $newest.LastWriteTime).TotalMinutes)) }
  }

  Set-Content -LiteralPath $beat -Value ('{0} last-commit={1} age={2}min transcript-age={3}' -f $nowText, $hash, $ageMin, $tAgeText) -Encoding ASCII

  if ($ageMin -ge $ThresholdMinutes) {
    $lastHash = ''; $lastAt = [DateTime]::MinValue
    if (Test-Path $state) {
      $s = (Get-Content -LiteralPath $state -TotalCount 1).Split(' ')
      $lastHash = $s[0]; $lastAt = [DateTime]::ParseExact($s[1], 'yyyyMMddHHmmss', $inv)
    }
    if ($lastHash -ne $hash -or ($now - $lastAt).TotalMinutes -ge 60) {
      $msg = '{0} STALL: no new commit for {1} min (last {2} at {3}); transcript last written {4} ago' -f $nowText, $ageMin, $hash, $commitAt.ToString('yyyy-MM-dd HH:mm', $inv), $tAgeText
      Add-Content -LiteralPath $log -Value $msg -Encoding ASCII
      Set-Content -LiteralPath $state -Value ('{0} {1}' -f $hash, $now.ToString('yyyyMMddHHmmss', $inv)) -Encoding ASCII
    }
  }
} catch {
  Add-Content -LiteralPath $log -Value ('{0} ERROR: {1}' -f $nowText, $_.Exception.Message) -Encoding ASCII
}
