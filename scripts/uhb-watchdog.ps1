<#
  UHB watchdog - keeps the Universal Health Bridge (port 8990) alive.
  Design mirrors the proven pro-cache-bridge watchdog:
    - single instance via named mutex
    - probes 127.0.0.1:8990 (TCP + /__stats) every N seconds
    - restarts with a validated node.exe (tries known candidates in order)
    - rotates watchdog.log at 2MB
  NOTE: comments are ASCII on purpose - Windows PowerShell 5.1 reads .ps1 as ANSI,
        non-ASCII text would break parsing.
#>
param(
  [int]$Port = 8990,
  [string]$Config = 'config.uhb.json',
  [int]$CheckSeconds = 10
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Root           # scripts/ -> project root
$Entry = Join-Path $Root 'uhb.js'
$LogPath = Join-Path $Root 'logs\watchdog.log'
$PidPath = Join-Path $Root 'logs\uhb.pid'

New-Item -ItemType Directory -Path (Join-Path $Root 'logs') -Force | Out-Null

function Write-Log([string]$m) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m
  try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
}

# rotate
try {
  $fi = Get-Item -LiteralPath $LogPath -ErrorAction SilentlyContinue
  if ($fi -and $fi.Length -gt 2MB) { Move-Item -LiteralPath $LogPath -Destination ($LogPath + '.1') -Force }
} catch { }

# single instance
try {
  $mutex = New-Object System.Threading.Mutex($false, 'Local\uhb-watchdog')
  if (-not $mutex.WaitOne(0)) { Write-Log 'another watchdog instance is running, exit'; exit 0 }
} catch { }

function Test-Port([int]$p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $a = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    if (-not $a.AsyncWaitHandle.WaitOne(800)) { return $false }
    $c.EndConnect($a); return $true
  } catch { return $false } finally { try { $c.Close() } catch { } }
}

function Test-Http([int]$p) {
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$p/__stats") -UseBasicParsing -TimeoutSec 5
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Test-Node([string]$exe) {
  if (-not (Test-Path -LiteralPath $exe)) { return $false }
  $o = Join-Path $env:TEMP ('uhbn-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.out')
  try {
    $pr = Start-Process -FilePath $exe -ArgumentList '--version' -PassThru -Wait -WindowStyle Hidden -RedirectStandardOutput $o -RedirectStandardError ($o + '.e')
    if ($pr.ExitCode -ne 0) { return $false }
    return ((Get-Content -LiteralPath $o -Raw -ErrorAction SilentlyContinue) -match '^v\d+\.')
  } catch { return $false }
  finally { Remove-Item -LiteralPath $o, ($o + '.e') -Force -ErrorAction SilentlyContinue }
}

function Get-NodeCandidates {
  # 不内置任何本机路径：候选顺序 = 环境变量 UHB_NODE -> scripts\node-path.txt -> PATH 上的 node
  $l = @()
  if ($env:UHB_NODE) { $l += $env:UHB_NODE }
  $txt = Join-Path $Root 'scripts\node-path.txt'
  if (Test-Path -LiteralPath $txt) {
    try { foreach ($ln in Get-Content -LiteralPath $txt) { if ($ln -and $ln.Trim()) { $l += $ln.Trim() } } } catch { }
  }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $l += $cmd.Source }
  $ok = @()
  foreach ($c in $l) {
    if (-not $c) { continue }
    if ($ok -contains $c) { continue }
    if (Test-Node $c) { $ok += $c } else { Write-Log ('[warn] node not runnable: ' + $c) }
  }
  return $ok
}

$nodes = @(Get-NodeCandidates)
if ($nodes.Count -eq 0) { Write-Log '[fatal] no runnable node.exe found'; exit 1 }
$nodeIdx = 0
$node = $nodes[0]

Set-Location -LiteralPath $Root
$PID | Out-File -LiteralPath $PidPath -Encoding ascii
Write-Log ("watchdog start pid=" + $PID + " node=" + $node + " port=" + $Port + " config=" + $Config)

function Start-Uhb {
  $args = @('"' + $Entry + '"', 'run', '--config', ('"' + $Config + '"'), '--port', ("$Port"))
  $p = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
       -RedirectStandardOutput (Join-Path $Root 'logs\uhb-stdout.log') `
       -RedirectStandardError  (Join-Path $Root 'logs\uhb-stderr.log')
  if ($p) { $p.Id | Out-File -LiteralPath (Join-Path $Root 'logs\uhb-child.pid') -Encoding ascii }
  return $p
}

$state = ''
$failStreak = 0
$startFail = 0

while ($true) {
  if (-not (Test-Port $Port)) {
    if ($state -ne 'down') { Write-Log '[down] port not listening -> starting'; $state = 'down' }
    $p = Start-Uhb
    $up = $false
    for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 500; if (Test-Port $Port) { $up = $true; break } }
    if ($up) {
      Write-Log ('[ok] UHB started pid=' + $p.Id + ' on 127.0.0.1:' + $Port)
      $state = 'up'; $failStreak = 0; $startFail = 0
    } else {
      $startFail++
      Write-Log ('[warn] failed to start (' + $startFail + ') with ' + $node)
      if ($startFail -ge 2 -and $nodes.Count -gt 1) {
        $nodeIdx = ($nodeIdx + 1) % $nodes.Count
        $node = $nodes[$nodeIdx]
        $startFail = 0
        Write-Log ('[switch] next node candidate: ' + $node)
      }
    }
    Start-Sleep -Seconds 5
    continue
  }

  if (Test-Http $Port) {
    if ($state -ne 'up') { Write-Log '[ok] UHB healthy (port + /__stats 200)'; $state = 'up' }
    $failStreak = 0
  } else {
    $failStreak++
    Write-Log ('[warn] port open but /__stats not answering (' + $failStreak + ')')
    if ($failStreak -ge 3) {
      $child = 0
      try { $child = [int](Get-Content -LiteralPath (Join-Path $Root 'logs\uhb-child.pid') -ErrorAction Stop | Select-Object -First 1) } catch { }
      if ($child -gt 0) { try { Stop-Process -Id $child -Force; Write-Log ('[kill] hung child pid=' + $child) } catch { } }
      $failStreak = 0
    }
  }
  Start-Sleep -Seconds $CheckSeconds
}
