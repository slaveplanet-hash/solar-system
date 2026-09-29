// errorlog.js — local troubleshooting only. Catches uncaught errors, unhandled promise
// rejections, failed resource loads and console.error/warn; keeps the last entries in
// localStorage, shows a ⚠ badge (click = copy log, shift-click = clear) and forwards each
// entry to tools/serve.mjs, which appends it to logs/errors.log.
// Loaded as a classic script before the import map so it sees module load/parse failures too.
// Does nothing unless the page is served from localhost (or the URL has ?errlog).
(() => {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || /[?&]errlog\b/.test(location.search);
  if (!local) return;

  const KEY = 'sol.errorlog', MAX = 300;
  let entries = [];
  try { entries = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { /* storage blocked */ }
  let serverOK = true, badge = null, sessionCount = 0;
  const repeats = new Map(); // message -> count, so a per-frame error doesn't flood the log

  const fmt = (a) => {
    if (a instanceof Error) return a.stack && a.stack.includes(a.message) ? a.stack : `${a.name}: ${a.message}\n${a.stack || ''}`;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  };

  function record(level, msg) {
    const n = (repeats.get(msg) || 0) + 1;
    repeats.set(msg, n);
    if (n > 3 && n !== 10 && n !== 100 && n % 1000 !== 0) return; // first 3, then 10/100/every 1000th
    const e = { t: new Date().toISOString(), level, msg: n > 3 ? `(×${n}) ${msg}` : msg };
    entries.push(e);
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* storage blocked / full */ }
    if (level !== 'info') { sessionCount++; updateBadge(level); }
    if (serverOK) {
      fetch('/__log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...e, url: location.pathname + location.search }), keepalive: true })
        .then((r) => { if (!r.ok) serverOK = false; }, () => { serverOK = false; }); // e.g. a server without /__log
    }
  }

  function updateBadge(level) {
    if (!document.body) { document.addEventListener('DOMContentLoaded', () => updateBadge(level), { once: true }); return; }
    if (!badge) {
      badge = document.createElement('button');
      badge.title = 'Error log — click: copy to clipboard, shift-click: clear';
      badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;padding:3px 8px;border:0;border-radius:6px;font:12px monospace;color:#fff;cursor:pointer;opacity:.85';
      badge.onclick = async (ev) => {
        if (ev.shiftKey) { entries = []; sessionCount = 0; repeats.clear(); try { localStorage.removeItem(KEY); } catch {} badge.remove(); badge = null; return; }
        const text = entries.map((x) => `${x.t} [${x.level}] ${x.msg}`).join('\n');
        try { await navigator.clipboard.writeText(text); badge.textContent = 'copied'; setTimeout(() => updateBadge(), 1200); }
        catch { console.log(text); }
      };
      document.body.appendChild(badge);
    }
    if (level === 'error' || level === 'rejection' || level === 'resource') badge.style.background = '#b00';
    else if (!badge.style.background) badge.style.background = '#a60';
    badge.textContent = `⚠ ${sessionCount}`;
  }

  // Capture phase also sees failed <img>/<script>/<link> loads, which don't bubble.
  window.addEventListener('error', (ev) => {
    const t = ev.target;
    if (t && t !== window && (t.src || t.href)) { record('resource', `failed to load ${t.tagName.toLowerCase()} ${t.src || t.href}`); return; }
    const where = ev.filename ? ` (${ev.filename.replace(location.origin, '')}:${ev.lineno}:${ev.colno})` : '';
    record('error', (ev.error ? fmt(ev.error) : ev.message) + where);
  }, true);
  window.addEventListener('unhandledrejection', (ev) => record('rejection', fmt(ev.reason)));

  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { orig(...args); try { record(level, args.map(fmt).join(' ')); } catch { /* never break logging */ } };
  }

  window.__errlog = { get entries() { return entries; }, record };
  record('info', `page loaded ${location.href} — ${navigator.userAgent}`);
})();
