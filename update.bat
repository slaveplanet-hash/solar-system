@echo off
rem ===========================================================================
rem  update.bat - double-click to refresh the simulator's data.
rem    * Earth satellites: every time (quick; skipped if less than 2 hours old,
rem      because CelesTrak blocks clients that download more often).
rem    * Asteroids, comets, spacecraft (JPL): only when that data is more than
rem      30 days old (about 2 minutes).
rem  Extra options are passed on, e.g.  update.bat --force
rem ===========================================================================
title Sol Simulator - data update
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on the PATH.
  echo Install the LTS version from https://nodejs.org/ and run this again.
  pause
  exit /b 1
)
node fetch-data.mjs --auto %*
if errorlevel 1 (
  echo.
  echo Update FAILED - see the messages above. Your previous data is unchanged.
  pause
  exit /b 1
)
echo.
echo Update finished. Reload the simulator page (F5) to see the new data.
echo For the GitHub Pages copy: commit and push the data folder.
pause
