@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
echo ============================================
echo   UHB status
echo ============================================
powershell -NoProfile -Command ^
  "$c=Get-NetTCPConnection -LocalPort 8990 -State Listen -ErrorAction SilentlyContinue;" ^
  "if($c){ Write-Host ('  port 8990: LISTENING pid=' + $c.OwningProcess) } else { Write-Host '  port 8990: NOT LISTENING' };" ^
  "$w=Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*uhb-watchdog.ps1*' };" ^
  "if($w){ foreach($p in $w){ Write-Host ('  watchdog: pid=' + $p.ProcessId) } } else { Write-Host '  watchdog: not running' };" ^
  "try { $j=(Invoke-WebRequest -Uri 'http://127.0.0.1:8990/__stats' -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json; Write-Host ('  version=' + $j.version + '  requests=' + $j.requests + '  hit60s=' + $j.hitRate60s.hitRate + '%'); foreach($k in $j.per.PSObject.Properties.Name){ $v=$j.per.$k; Write-Host ('  route ' + $k + ': running=' + $v.admission.running.small + '/' + $v.admission.running.mid + '/' + $v.admission.running.large + '  quota=' + $v.quota.active + '  breaker=' + $v.guard.breaker.active) } } catch { Write-Host '  /__stats: not reachable' }"
echo.
type logs\watchdog.log 2>nul | more +0
echo.
pause
endlocal
