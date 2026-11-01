# テストがウィンドウを前面へ出して利用者の作業を奪っていないかを測る（開発ガイド §5.66）。
#
# 前面のウィンドウの持ち主を一定の間隔で読み、指定した名前のプロセスだった回数と、
# 前面がそのプロセスへ変わった回数を出す。テストと並行して別の窓で動かす。
#
#   pwsh -File scripts/measure-foreground.ps1 -Seconds 300
#
# 名前で数えるので、所有者が開いている `electron-vite dev` のウィンドウを前面にしていると
# それも数える。0 回を見たいときは、測っているあいだ別のアプリを前面にしておく。
param(
  [int]$Seconds = 60,
  [int]$IntervalMs = 100,
  [string]$ProcessName = 'electron'
)

Add-Type -Namespace Gimoza -Name Foreground -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
'@

function Get-ForegroundProcessName {
  $window = [Gimoza.Foreground]::GetForegroundWindow()
  if ($window -eq [IntPtr]::Zero) { return '' }
  $processId = [uint32]0
  [void][Gimoza.Foreground]::GetWindowThreadProcessId($window, [ref]$processId)
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process) { return '' }
  return $process.ProcessName
}

$samples = 0
$matched = 0
$entered = 0
$wasMatched = $false
$deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
while ([DateTime]::UtcNow -lt $deadline) {
  $isMatched = (Get-ForegroundProcessName) -ieq $ProcessName
  $samples += 1
  if ($isMatched) { $matched += 1 }
  if ($isMatched -and -not $wasMatched) { $entered += 1 }
  $wasMatched = $isMatched
  Start-Sleep -Milliseconds $IntervalMs
}

$share = if ($samples -eq 0) { 0 } else { [math]::Round(100.0 * $matched / $samples, 1) }
$shareText = $share.ToString([Globalization.CultureInfo]::InvariantCulture)
Write-Output "読んだ回数: $samples / 前面が $ProcessName だった回数: $matched（$shareText%）/ 前面が $ProcessName へ変わった回数: $entered"
if ($entered -gt 0) { exit 1 }
