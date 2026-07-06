@echo off
cd /d "%~dp0"
echo Usando PowerShell (sin Python ni Node)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0static-server.ps1"
pause
