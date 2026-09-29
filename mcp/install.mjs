#!/usr/bin/env node
// =============================================================================
// mcp/install.mjs — Register the Sol simulator MCP server with AI apps on this computer.
//
//   node mcp/install.mjs              install (Claude Code for every folder, the skills,
//                                     Claude Desktop and OpenCode (CLI + Desktop) if installed)
//   node mcp/install.mjs --check      only report what is installed
//   node mcp/install.mjs --uninstall  remove everything this script added
//
// Other MCP clients (Cursor, VS Code, Windsurf, LM Studio, …): the script prints the JSON block
// to paste into their MCP settings. Paths are absolute, so it works from any folder.
// =============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, cp, rm, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'mcp', 'server.mjs');
const NAME = 'sol-simulator';
const SKILLS = ['sol-simulator', 'sol-simulator-setup'];
const NODE = process.execPath;                       // absolute: desktop apps often don't have node on their PATH
const MODE = process.argv.includes('--uninstall') ? 'uninstall' : process.argv.includes('--check') ? 'check' : 'install';
const say = (s = '') => console.log(s);
const ok = (s) => say(`  ✔ ${s}`), skip = (s) => say(`  – ${s}`), bad = (s) => say(`  ✖ ${s}`);

function claudeCli(args) {
  // `claude` is a .cmd shim on Windows: run it through the shell.
  const r = spawnSync(`claude ${args.join(' ')}`, { encoding: 'utf8', shell: true, windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), missing: r.error?.code === 'ENOENT' || /not recognized|not found/i.test(r.stderr || '') };
}

// --- Claude Code: user scope (every folder) -------------------------------------------------
function claudeCode() {
  say('Claude Code');
  const probe = claudeCli(['--version']);
  if (!probe.ok) { skip('the `claude` command was not found — install Claude Code, then run this again'); return; }
  const cur = claudeCli(['mcp', 'get', NAME]);
  const userScoped = cur.ok && /Scope:\s*User/i.test(cur.out);
  if (MODE === 'check') { (userScoped ? ok : skip)(userScoped ? `registered for every folder (${probe.out})` : 'not registered — run: node mcp/install.mjs'); return; }
  if (userScoped) claudeCli(['mcp', 'remove', NAME, '-s', 'user']);   // re-add so the paths are current
  if (MODE === 'uninstall') { (userScoped ? ok : skip)(userScoped ? 'removed' : 'was not registered'); return; }
  const r = claudeCli(['mcp', 'add', '--scope', 'user', NAME, '--', `"${NODE}"`, `"${SERVER}"`]);
  (r.ok ? ok : bad)(r.ok ? 'registered for every folder (user scope) — start a NEW `claude` session to use it' : `could not register: ${r.out.slice(0, 300)}`);
}

// --- Skills (Claude Code, every folder) ---------------------------------------------------------
async function skills() {
  say('Skills (Claude Code)');
  for (const s of SKILLS) {
    const src = join(ROOT, '.claude', 'skills', s), dst = join(homedir(), '.claude', 'skills', s);
    if (MODE === 'check') { (existsSync(join(dst, 'SKILL.md')) ? ok : skip)(`${s}: ${existsSync(join(dst, 'SKILL.md')) ? 'installed' : 'not installed'} for every folder`); continue; }
    if (MODE === 'uninstall') { if (existsSync(dst)) { await rm(dst, { recursive: true, force: true }); ok(`${s}: removed`); } else skip(`${s}: was not installed`); continue; }
    await mkdir(dst, { recursive: true });
    await cp(src, dst, { recursive: true, force: true });
    ok(`${s}: installed to ${dst}`);
  }
}

// --- Claude Desktop ------------------------------------------------------------------------------
function desktopConfigPath() {
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}
async function claudeDesktop() {
  say('Claude Desktop');
  const file = desktopConfigPath();
  if (!existsSync(dirname(file))) { skip('not installed on this computer (no Claude settings folder)'); return; }
  let cfg = {};
  if (existsSync(file)) {
    try { cfg = JSON.parse(await readFile(file, 'utf8')); }
    catch { bad(`${file} is not valid JSON — fix or delete it, then run this again`); return; }
  }
  const has = !!cfg.mcpServers?.[NAME];
  if (MODE === 'check') { (has ? ok : skip)(has ? 'registered' : 'not registered'); return; }
  if (MODE === 'uninstall' && !has) { skip('was not registered'); return; }
  if (existsSync(file)) await copyFile(file, file + '.bak');           // keep the previous settings
  cfg.mcpServers = cfg.mcpServers || {};
  if (MODE === 'uninstall') delete cfg.mcpServers[NAME];
  else cfg.mcpServers[NAME] = { command: NODE, args: [SERVER] };
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n');
  ok(`${MODE === 'uninstall' ? 'removed from' : 'registered in'} ${file}${existsSync(file + '.bak') ? ' (previous version saved as .bak)' : ''} — quit and reopen Claude Desktop`);
}

// --- OpenCode (CLI and OpenCode Desktop share ~/.config/opencode) -----------------------------------
// The config is JSONC and holds the user's providers and keys, so it is edited as TEXT: only our
// entry is inserted or removed, everything else (formatting, comments) stays byte-for-byte the same.
// Skills need nothing extra: OpenCode also reads ~/.claude/skills/.

/** Index just past the value starting at i (object/array/string/literal), skipping strings and comments. */
function scanValue(t, i) {
  let depth = 0;
  for (; i < t.length; i++) {
    const c = t[i];
    if (c === '"') { for (i++; i < t.length && t[i] !== '"'; i++) if (t[i] === '\\') i++; if (depth === 0) return i + 1; continue; }
    if (c === '/' && t[i + 1] === '/') { i = t.indexOf('\n', i); if (i < 0) return t.length; continue; }
    if (c === '/' && t[i + 1] === '*') { i = t.indexOf('*/', i + 2) + 1; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; }
    else if (depth === 0 && /[,\s]/.test(c)) return i;
  }
  return t.length;
}
/** Position of `"key":` directly inside the object whose '{' is at `open`, or -1. */
function findKey(t, open, key) {
  let i = open + 1;
  const end = scanValue(t, open) - 1;
  while (i < end) {
    const c = t[i];
    if (/[\s,]/.test(c)) { i++; continue; }
    if (c === '/' && t[i + 1] === '/') { i = t.indexOf('\n', i) + 1 || end; continue; }
    if (c === '/' && t[i + 1] === '*') { i = t.indexOf('*/', i + 2) + 2; continue; }
    if (c !== '"') return -1;
    const kEnd = scanValue(t, i), k = JSON.parse(t.slice(i, kEnd));
    const colon = t.indexOf(':', kEnd);
    let v = colon + 1; while (/\s/.test(t[v])) v++;
    if (k === key) return i;
    i = scanValue(t, v);
  }
  return -1;
}
const stripJsonc = (t) => t.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : '')).replace(/,(\s*[}\]])/g, '$1');

async function openCode() {
  say('OpenCode (CLI and Desktop)');
  const dir = process.env.SOL_OPENCODE_DIR || join(homedir(), '.config', 'opencode');   // override: tests
  const file = ['opencode.jsonc', 'opencode.json'].map((f) => join(dir, f)).find(existsSync) || join(dir, 'opencode.json');
  if (!existsSync(dir)) { skip('not installed on this computer (no ~/.config/opencode folder)'); return; }
  let text = existsSync(file) ? await readFile(file, 'utf8') : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  try { JSON.parse(stripJsonc(text)); } catch { bad(`${file} could not be read (invalid JSON) — fix it, then run this again`); return; }
  const root = text.indexOf('{');
  const mcpAt = findKey(text, root, 'mcp');
  const mcpOpen = mcpAt >= 0 ? text.indexOf('{', text.indexOf(':', scanValue(text, mcpAt))) : -1;
  const ourAt = mcpOpen >= 0 ? findKey(text, mcpOpen, NAME) : -1;
  if (MODE === 'check') { (ourAt >= 0 ? ok : skip)(ourAt >= 0 ? `registered in ${file}` : 'not registered'); return; }
  if (ourAt >= 0) {
    // Remove our entry (and one adjoining comma) so it can be re-added with current paths.
    // Exactly undo the insertion below: "\n    <entry>," (or the last entry: ",\n    <entry>").
    const vStart = text.indexOf('{', text.indexOf(':', scanValue(text, ourAt)));
    let s = ourAt, e = scanValue(text, vStart);
    while (s > 0 && /[ \t]/.test(text[s - 1])) s--;
    if (text[s - 1] === '\n') s--;
    if (text[s - 1] === '\r') s--;
    if (text[e] === ',') e++;
    else { let b = s; while (b > 0 && /\s/.test(text[b - 1])) b--; if (text[b - 1] === ',') s = b - 1; }
    text = text.slice(0, s) + text.slice(e);
    // An object left holding only whitespace ("{\n  }", from inserting into "{}") goes back to "{}".
    text = text.replace(/("mcp"\s*:\s*)\{\s*\}/, '$1{}');
  }
  if (MODE === 'uninstall' && ourAt < 0) { skip('was not registered'); return; }
  if (MODE === 'install') {
    const entry = { type: 'local', command: [NODE.replace(/\\/g, '/'), SERVER.replace(/\\/g, '/')], enabled: true, timeout: 20000 };
    const body = JSON.stringify(entry, null, 2).replace(/\n/g, '\n    ');
    const open = findKey(text, text.indexOf('{'), 'mcp') >= 0
      ? text.indexOf('{', text.indexOf(':', scanValue(text, findKey(text, text.indexOf('{'), 'mcp')))) : -1;
    if (open >= 0) {
      const empty = /^\s*}/.test(text.slice(open + 1));
      text = text.slice(0, open + 1) + `\n    "${NAME}": ${body}${empty ? '\n  ' : ','}` + text.slice(open + 1);
    } else {
      const r = text.indexOf('{');
      const empty = /^\s*}/.test(text.slice(r + 1));
      text = text.slice(0, r + 1) + `\n  "mcp": {\n    "${NAME}": ${body}\n  }${empty ? '\n' : ','}` + text.slice(r + 1);
    }
  }
  try { JSON.parse(stripJsonc(text)); } catch (e) { bad(`edit produced invalid JSON (${e.message}) — nothing written. Add it by hand (see the block below).`); return; }
  if (existsSync(file)) await copyFile(file, file + '.bak');
  await writeFile(file, text);
  ok(`${MODE === 'uninstall' ? 'removed from' : 'registered in'} ${file} (previous version saved as .bak) — restart OpenCode / OpenCode Desktop`);
  ok('skills: OpenCode reads them from ~/.claude/skills/ (installed above)');
}

// --- anything else --------------------------------------------------------------------------------
function otherClients() {
  say('Other AI apps (Cursor, VS Code, Windsurf, LM Studio, …)');
  say('  Add this to the app\'s MCP settings (usually a file called mcp.json or "MCP servers" in its settings):');
  say(JSON.stringify({ mcpServers: { [NAME]: { command: NODE, args: [SERVER] } } }, null, 2).replace(/^/gm, '    '));
}

say(`Sol simulator MCP server — ${MODE}\n  server: ${SERVER}\n  node:   ${NODE}\n`);
if (!existsSync(SERVER)) { bad(`${SERVER} not found — run this from the solar-system folder`); process.exit(1); }
claudeCode();
await skills();
await claudeDesktop();
await openCode();
if (MODE === 'install') {
  otherClients();
  // Quick self-test: the server must answer the MCP handshake.
  const r = spawnSync(NODE, [SERVER], { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'install', version: '1' } } }) + '\n', encoding: 'utf8', timeout: 15000 });
  const line = (r.stdout || '').split('\n').find((l) => l.includes('"id":1'));
  say('\nSelf-test');
  (line && line.includes('sol-simulator') ? ok : bad)(line ? 'the server answers the MCP handshake' : `no answer from the server: ${(r.stderr || '').slice(0, 300)}`);
  say('\nDone. In a new Claude session try: "When can I see the ISS from my town this week?" or "Show me the next total solar eclipse."');
}
