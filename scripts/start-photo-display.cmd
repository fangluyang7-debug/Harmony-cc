@echo off
cd /d "%~dp0.."
node scripts\photo-display-server.cjs %*
if errorlevel 1 pause
