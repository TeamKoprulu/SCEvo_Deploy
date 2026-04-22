@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-manifests.ps1"
pause
