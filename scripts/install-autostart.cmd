@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
echo ============================================
echo   UHB - Universal Health Bridge (guard-only)
echo   port 8990   *no protocol translation*
echo ============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
echo.
echo   Open health:  http://127.0.0.1:8990/__stats
echo   Uninstall:    double-click scripts\uninstall-autostart.cmd
echo.
pause
endlocal
