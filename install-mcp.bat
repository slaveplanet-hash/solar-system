@echo off
rem ===========================================================================
rem  install-mcp.bat - double-click to let AI apps use the simulator (MCP).
rem    * Claude Code: registered for every folder
rem    * Skills: copied so Claude knows how to use it (and how to set it up)
rem    * Claude Desktop: added if it is installed (old settings kept as .bak)
rem    * OpenCode (CLI + Desktop): added if it is installed (old settings kept as .bak)
rem    * Other apps: prints the settings to paste
rem  Options:  install-mcp.bat --check   /   install-mcp.bat --uninstall
rem ===========================================================================
title Sol Simulator - MCP install
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on the PATH.
  echo Install the LTS version from https://nodejs.org/ and run this again.
  pause
  exit /b 1
)
node mcp\install.mjs %*
echo.
pause
