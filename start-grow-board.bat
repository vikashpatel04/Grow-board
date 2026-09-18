@echo off
REM Grow Board - start the dashboard.
cd /d "%~dp0"
if not exist "node_modules\electron" (
  echo First run - installing dependencies, this takes a minute...
  call npm install
)
start "" "node_modules\.bin\electron.cmd" .
