<#
  Install / update the UHB autostart entry (HKCU Run -> UHB-watchdog).
  ASCII-only comments (PowerShell 5.1 reads .ps1 as ANSI).
  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Root
$Vbs = Join-Path $Root 'scripts\uhb-autostart.vbs'
$Key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$Name = 'UHB-watchdog'
$Cmd = 'wscript.exe "' + $Vbs + '"'

if ($Remove) {
  try { Remove-ItemProperty -Path $Key -Name $Name -ErrorAction Stop; Write-Host '[ok] autostart removed' }
  catch { Write-Host '[info] autostart entry not present' }
  exit 0
}

if (-not (Test-Path -LiteralPath $Vbs)) { throw "missing launcher: $Vbs" }
New-ItemProperty -Path $Key -Name $Name -PropertyType String -Value $Cmd -Force | Out-Null
$now = (Get-ItemProperty -Path $Key -Name $Name).$Name
Write-Host '[ok] autostart installed'
Write-Host ('     key: HKCU\Software\Microsoft\Windows\CurrentVersion\Run')
Write-Host ('     name: ' + $Name)
Write-Host ('     value: ' + $now)

# start it right now (idempotent: watchdog has a single-instance mutex)
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $Vbs + '"') -WindowStyle Hidden
Write-Host '[ok] watchdog launched (background)'
