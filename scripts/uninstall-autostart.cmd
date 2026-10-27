@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
echo Removing UHB autostart entry (HKCU Run -> UHB-watchdog)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1" -Remove
echo.
echo Note: this only removes autostart. A running watchdog/UHB keeps running
echo       until you log off or run scripts\stop-uhb.cmd
echo.
pause
endlocal
