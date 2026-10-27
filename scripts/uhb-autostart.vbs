' Launches the UHB watchdog hidden (no console window).
' Registered by install-autostart.ps1 under HKCU\...\Run -> UHB-watchdog
Option Explicit
Dim sh, fso, root, ps, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
ps = sh.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
cmd = """" & ps & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\scripts\uhb-watchdog.ps1"""
sh.Run cmd, 0, False
Set sh = Nothing
Set fso = Nothing
