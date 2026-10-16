@echo off
REM Convenience wrapper: the default PowerShell execution policy blocks .ps1 files, so the build
REM scripts are invoked with -ExecutionPolicy Bypass.
setlocal
set PROJ=%~dp0..
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJ%\tools\build-apk.ps1" %*
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJ%\tools\verify-apk.ps1"
