@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
echo Stopping UHB (port 8990) and its watchdog...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*uhb-watchdog.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('  killed watchdog ' + $_.ProcessId) };" ^
  "$c=Get-NetTCPConnection -LocalPort 8990 -State Listen; if($c){ Stop-Process -Id $c.OwningProcess -Force; Write-Host ('  killed uhb ' + $c.OwningProcess) } else { Write-Host '  uhb not listening' }"
echo.
echo Done. (Autostart entry untouched - use scripts\uninstall-autostart.cmd to remove it.)
pause
endlocal
