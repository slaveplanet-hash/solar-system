---
name: sol-simulator-setup
description: Install, check, repair or remove the Sol Solar System simulator MCP server (sol-simulator) for Claude Code, Claude Desktop, OpenCode (CLI and Desktop) or another AI app. Use when the user wants an AI to be able to use the simulator, asks whether the MCP server is installed, or when sol-simulator tools are missing or failing to connect.
---

# Setting up the Sol simulator MCP server

The server is `mcp/server.mjs` in the solar-system project folder. It needs Node.js 18+ and has no other dependencies. `mcp/install.mjs` does the whole setup with absolute paths.

## Install

1. Find the project folder: the one containing `mcp/server.mjs`, `index.html` and `update.bat`. If you are not in it, ask the user where it is.
2. Check Node: `node --version` must be 18 or newer. If it isn't, point the user to https://nodejs.org/ (LTS) and stop.
3. Run `node mcp/install.mjs` from that folder (or have the user double-click `install-mcp.bat`). It:
   - registers the server with Claude Code for every folder (user scope);
   - copies the `sol-simulator` and `sol-simulator-setup` skills to `~/.claude/skills/`;
   - adds the server to Claude Desktop's config, if Claude Desktop is installed (the old config is kept as `.bak`);
   - adds it to OpenCode's global config `~/.config/opencode/opencode.jsonc`, used by both the OpenCode CLI and OpenCode Desktop. It inserts only its own entry and keeps a `.bak`. OpenCode reads the skills from `~/.claude/skills/` too;
   - prints the JSON block for any other MCP client, and self-tests the handshake.
4. Tell the user what to restart:
   - Claude Code: start a new `claude` session.
   - Claude Desktop: quit it fully (tray icon → Quit) and reopen.
   - OpenCode / OpenCode Desktop: close and reopen it.
   - Other apps: paste the printed JSON into their MCP settings.
5. Optional: to stop Claude Code asking before every tool call, add `"mcp__sol-simulator__*"` to `permissions.allow` in `~/.claude/settings.json`. Ask the user first.

## Check

- `node mcp/install.mjs --check` shows where it is installed.
- `claude mcp list` (Claude Code) or `opencode mcp list` (OpenCode) should show `sol-simulator` as connected.

## Troubleshoot

- **Tools don't appear:** restart the client. Re-run the installer if the project folder was moved, because the paths are absolute.
- **"No simulator tab is connected":** call `sim_open`. Calculation tools (`find_eclipses`, `satellite_passes`, …) work without a tab.
- **"Port 8130 is in use":**
  - An old simulator server window is probably still running: close it.
  - Otherwise set `SOL_PORT` in the server's `env` to another port.
- **A `sim_*` tool times out:** bring the simulator tab to the front, or reload it.
- **Satellite tools say the data is too old:** run `update.bat` (or `node fetch-data.mjs --satellites`).
- **Server log:** Claude Code shows stderr with `claude --debug`; `logs/errors.log` has page and server errors.

## Remove

`node mcp/install.mjs --uninstall` removes the Claude Code registration, the copied skills and the Claude Desktop entry.
