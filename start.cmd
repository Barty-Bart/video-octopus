@echo off
rem Start Video Octopus and open it in the browser (Windows; start.sh on a Mac).
rem Video Octopus restarts itself here after an update (Settings, Updates, Restart): the server exits with code 75 and
rem this loop starts it again. Any other exit (Ctrl+C, a crash) ends the loop.
rem   set STUDIO_NO_OPEN=1   don't open the browser (Open Video Octopus when I log in starts it this way)
rem   set PORT=4801          another port than 4800
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Video Octopus needs Node.js 22.16 or newer on Node 22, or Node.js 24 or newer: https://nodejs.org
  exit /b 1
)
node server\runtime-check.cjs
if errorlevel 1 exit /b 1

if not defined PORT set PORT=4800
if not "%STUDIO_NO_OPEN%"=="1" start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://127.0.0.1:%PORT%"

rem Tells the server that Restart works here.
set STUDIO_SUPERVISED=1
:run
node server\index.mjs
set CODE=%ERRORLEVEL%
if "%CODE%"=="75" (
  echo Restarting Video Octopus...
  goto run
)
exit /b %CODE%
