// API Recorder - the human-readable summary report (one self-contained HTML
// file). Built from the HAR (after redaction), so it never shows more than
// the HAR does. Pure functions, shared by the service worker and the tests.

const SUMMARY_DEFAULT_LINES = 200;

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Pretty-print a body: JSON is indented; anything else is shown as is. Long
// bodies are cut after maxLines with a note pointing to the full HAR.
function prettyBody(text, encoding, maxLines) {
  if (text === undefined || text === null || text === '') return null;
  if (encoding === 'base64') return `(binary content, ${Math.floor(text.length * 0.75).toLocaleString('en-US')} bytes; see the full HAR)`;
  let out = text;
  try { out = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }
  const lines = out.split('\n');
  if (lines.length > maxLines) {
    out = `${lines.slice(0, maxLines).join('\n')}\n… (${(lines.length - maxLines).toLocaleString('en-US')} more lines; see the full HAR)`;
  }
  return out;
}

const two = (n) => String(n).padStart(2, '0');
const clock = (d) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
const day = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// meta: { startedAt, endedAt (ms), harName (or null when no HAR is saved), maxLines }
function buildSummaryHtml(har, meta) {
  const { pages, entries, comment } = har.log;
  const tabTitle = Object.fromEntries(pages.map((p) => [p.id, p.title]));
  const maxLines = meta.maxLines || SUMMARY_DEFAULT_LINES;
  const calls = entries.map((e, i) => {
    const err = e.response._error;
    return {
      n: i + 1,
      time: clock(new Date(e.startedDateTime)),
      tab: tabTitle[e.pageref] || '',
      method: e.request.method,
      status: e.response.status,
      statusText: err || e.response.statusText || '',
      ms: Math.round(e.time),
      url: e.request.url,
      payload: prettyBody(e.request.postData?.text, null, maxLines),
      response: prettyBody(e.response.content.text, e.response.content.encoding, maxLines)
        ?? (e.response.content.comment || (err ? `(no response: ${err})` : null)),
    };
  });
  const hosts = [...new Set(entries.map((e) => { try { return new URL(e.request.url).host; } catch { return ''; } }).filter(Boolean))];
  const errors = calls.filter((c) => c.status >= 400 || c.status === 0).length;
  const slowest = calls.reduce((m, c) => Math.max(m, c.ms), 0);
  const start = new Date(meta.startedAt), end = new Date(meta.endedAt);
  const rows = [
    ['Site', hosts.join(', ') || '–'],
    ['Recorded', `${day(start)} · ${clock(start)} – ${clock(end)} (${span(meta.endedAt - meta.startedAt)})`],
    ['Tabs', pages.map((p) => p.title).join(', ') || '–'],
    ...(meta.harName ? [['Full HAR', meta.harName]] : []),
  ];
  // Data for the page script; "<" escaped so nothing in a body can end the <script>.
  const data = JSON.stringify(calls).replace(/</g, '\\u003c');
  const title = `API Recorder · ${hosts[0] || 'recording'} · ${day(start)} ${clock(start).slice(0, 5)}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>
  :root { --bg: #f6f7f9; --card: #fff; --text: #202124; --muted: #5f6368; --line: #e1e3e6; --accent: #1a73e8; --ok: #188038; --err: #d93025; --code: #f3f4f6; --key: #a142f4; --str: #188038; --num: #c5221f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #17181b; --card: #222327; --text: #e6e6e6; --muted: #a0a4ab; --line: #34363c; --code: #1b1c20; --key: #c58af9; --str: #81c995; --num: #f28b82; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 60px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  table.info { border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-bottom: 14px; }
  table.info th, table.info td { text-align: left; padding: 6px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  table.info tr:last-child th, table.info tr:last-child td { border-bottom: 0; }
  table.info th { color: var(--muted); font-weight: 600; white-space: nowrap; }
  table.info td { word-break: break-word; }
  .stats { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
  .stat { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; min-width: 76px; }
  .stat b { font-size: 18px; display: block; }
  .stat.err b { color: var(--err); }
  .tools { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
  .tools input { flex: 1; min-width: 200px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: inherit; font: inherit; }
  .tools button { padding: 7px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: inherit; cursor: pointer; font: inherit; }
  .tools button.on { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .call { background: var(--card); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
  .call.err { box-shadow: inset 4px 0 0 var(--err); } /* inner edge: rows stay aligned */
  .head { display: grid; grid-template-columns: 30px 58px 40px 34px var(--tabw, 110px) minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 8px 12px; cursor: pointer; }
  .tab { justify-self: start; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--muted); background: var(--code); border-radius: 10px; padding: 1px 8px; }
  .head:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
  .n, .ms, .time { color: var(--muted); font-size: 12.5px; }
  .method { font-weight: 700; font-size: 12px; }
  .status { font-weight: 700; }
  .status.ok { color: var(--ok); } .status.bad { color: var(--err); }
  .path { font-family: ui-monospace, Consolas, monospace; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .body { display: none; border-top: 1px solid var(--line); padding: 10px 12px 14px; }
  .call.open .body { display: block; }
  .url { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; color: var(--muted); word-break: break-all; margin-bottom: 8px; }
  .panes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 760px) { .panes { grid-template-columns: 1fr; } .head { grid-template-columns: 26px 40px 34px min(var(--tabw, 110px), 90px) minmax(0, 1fr); } .ms, .time { display: none; } }
  .pane { min-width: 0; }
  .pane h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 4px; display: flex; justify-content: space-between; }
  .pane h3 button { border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; text-transform: none; letter-spacing: 0; }
  pre { margin: 0; background: var(--code); border-radius: 6px; padding: 10px; overflow: auto; max-height: 420px; font: 12.5px/1.45 ui-monospace, Consolas, monospace; white-space: pre; }
  .k { color: var(--key); } .s { color: var(--str); } .d { color: var(--num); }
  .none { color: var(--muted); font-style: italic; }
  .empty { color: var(--muted); padding: 20px; text-align: center; }
  .note { color: var(--muted); font-size: 12.5px; margin-top: 18px; }
</style>
</head>
<body>
<main>
  <h1>API Recorder summary</h1>
  <table class="info">${rows.map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join('')}</table>
  <div class="stats">
    <div class="stat"><b>${calls.length}</b>calls</div>
    <div class="stat"><b>${calls.length - errors}</b>OK</div>
    <div class="stat${errors ? ' err' : ''}"><b>${errors}</b>error${errors === 1 ? '' : 's'}</div>
    <div class="stat"><b>${slowest >= 1000 ? `${(slowest / 1000).toFixed(1)} s` : `${slowest} ms`}</b>slowest</div>
  </div>
  <div class="tools">
    <input id="q" placeholder="Filter by URL, payload or response text…">
    <button id="all" class="on">All</button>
    <button id="errs">Errors only</button>
    <button id="expand">Expand all</button>
  </div>
  <div id="list"></div>
  <p class="note">${escHtml(comment || '')} Click a call to see its payload and response.</p>
</main>
<script id="calls" type="application/json">${data}</script>
<script>
const calls = JSON.parse(document.getElementById('calls').textContent);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// Light JSON coloring on the escaped text: keys, strings, numbers/literals.
const color = (t) => esc(t)
  .replace(/("(?:[^"\\\\\\n]|\\\\.)*")(\\s*:)/g, '<span class="k">$1</span>$2')
  .replace(/(:\\s*|^\\s*|\\[\\s*|,\\s*)("(?:[^"\\\\\\n]|\\\\.)*")/gm, '$1<span class="s">$2</span>')
  .replace(/(:\\s*|^\\s*)(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|true|false|null)(?=\\s*[,\\]}]?\\s*$)/gm, '$1<span class="d">$2</span>');
const pane = (title, text, key) => '<div class="pane"><h3>' + title + (text == null ? '' : '<button data-copy="' + key + '">Copy</button>') + '</h3>'
  + (text == null ? '<div class="none">none</div>' : '<pre>' + color(text) + '</pre>') + '</div>';
const path = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
const list = document.getElementById('list');
// One width for the tab column (the longest tab name, up to 150 px) so the endpoints line up.
const ruler = document.createElement('span');
ruler.className = 'tab';
ruler.style.cssText = 'position:absolute;visibility:hidden;max-width:none';
document.body.append(ruler);
const tabWidth = Math.max(40, ...calls.map((c) => { ruler.textContent = c.tab || '–'; return ruler.offsetWidth; }));
ruler.remove();
list.style.setProperty('--tabw', Math.min(150, tabWidth + 2) + 'px');
list.innerHTML = calls.length ? calls.map((c, i) => {
  const bad = c.status >= 400 || c.status === 0;
  return '<div class="call' + (bad ? ' err' : '') + '" data-i="' + i + '"><div class="head">'
    + '<span class="n">#' + c.n + '</span><span class="time">' + c.time + '</span><span class="method">' + esc(c.method) + '</span>'
    + '<span class="status ' + (bad ? 'bad' : 'ok') + '" title="' + esc(c.statusText) + '">' + (c.status || 'ERR') + '</span>'
    + '<span class="tab" title="' + esc(c.tab) + '">' + esc(c.tab || '–') + '</span>'
    + '<span class="path" title="' + esc(c.url) + '">' + esc(path(c.url)) + '</span><span class="ms">' + c.ms.toLocaleString('en-US') + ' ms</span></div>'
    + '<div class="body"><div class="url">' + esc(c.url) + (c.tab ? ' · tab ' + esc(c.tab) : '') + (c.statusText ? ' · ' + esc(c.statusText) : '') + '</div>'
    + '<div class="panes">' + pane('Payload', c.payload, i + ':p') + pane('Response', c.response, i + ':r') + '</div></div></div>';
}).join('') : '<div class="empty">No API calls were recorded.</div>';
list.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const [i, k] = copy.dataset.copy.split(':');
    navigator.clipboard.writeText(k === 'p' ? calls[i].payload : calls[i].response).then(() => { copy.textContent = 'Copied'; });
    return;
  }
  e.target.closest('.head')?.parentElement.classList.toggle('open');
});
let errorsOnly = false;
const apply = () => {
  const q = document.getElementById('q').value.toLowerCase();
  document.querySelectorAll('.call').forEach((el) => {
    const c = calls[el.dataset.i];
    const bad = c.status >= 400 || c.status === 0;
    el.hidden = (errorsOnly && !bad) || (q && !(c.url + ' ' + (c.payload || '') + ' ' + (c.response || '')).toLowerCase().includes(q));
  });
};
const allBtn = document.getElementById('all'), errBtn = document.getElementById('errs');
document.getElementById('q').addEventListener('input', apply);
allBtn.onclick = () => { errorsOnly = false; allBtn.classList.add('on'); errBtn.classList.remove('on'); apply(); };
errBtn.onclick = () => { errorsOnly = true; errBtn.classList.add('on'); allBtn.classList.remove('on'); apply(); };
document.getElementById('expand').onclick = (e) => {
  const open = e.target.textContent === 'Expand all';
  document.querySelectorAll('.call').forEach((el) => el.classList.toggle('open', open));
  e.target.textContent = open ? 'Collapse all' : 'Expand all';
};
</script>
</body>
</html>
`;
}

if (typeof module !== 'undefined') module.exports = { buildSummaryHtml, prettyBody, SUMMARY_DEFAULT_LINES };
