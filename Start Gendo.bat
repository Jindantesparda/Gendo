@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Gendo is not installed correctly: Electron is missing.
  echo Run npm install in this folder.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" "%~dp0"
