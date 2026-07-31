@echo off
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0deploy-to-r2.ps1" %*
echo.
pause
