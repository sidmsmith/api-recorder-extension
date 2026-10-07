// API Recorder - the human-readable summary report (one self-contained HTML
// file). Built from the HAR (after redaction), so it never shows more than
// the HAR does. Calls are grouped into steps (your clicks) and sorted into
// data / lookup / background (har.js), so the report can open showing only
// the relevant ones. Pure functions, shared by the service worker and tests.

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

// What a step says: Clicked "Blind Receipt", Pressed Enter in "ASN" (0000123), Opened "WM Mobile".
function stepText(st) {
  if (st.kind === 'enter') return `Pressed Enter in “${st.label || 'a field'}”${st.value ? ` (${st.value})` : ''}`;
  if (st.kind === 'load') return `Opened “${st.screen || 'a page'}”`;
  if (st.kind === 'key') return `Pressed ${st.label || 'a key'}`;
  if (st.kind === 'start') return 'Recording started';
  const field = st.field ? ` · ${st.field.label} = ${st.field.value || '(empty)'}` : '';
  return `Clicked “${st.label || 'something'}”${field}`;
}

// The signed-in user (and organization), from the WMS's activity headers or
// its sign-in user call. Empty when the recording doesn't show it.
function findUser(entries) {
  for (const e of entries) {
    const h = Object.fromEntries(e.request.headers.map((x) => [x.name.toLowerCase(), x.value]));
    const user = h['x-activitystream-user'];
    if (user && user !== '[REDACTED]') return h['x-activitystream-userorg'] ? `${user} (organization ${h['x-activitystream-userorg']})` : user;
  }
  for (const e of entries) {
    if (!/\/authserver\/user$/i.test(e.request.url.split('?')[0])) continue;
    try {
      const j = JSON.parse(e.response.content.text);
      const name = j.name || j.principal?.username || j.userName || j.username;
      if (name && name !== '[REDACTED]') return name;
    } catch { /* not JSON */ }
  }
  return '';
}

// meta: { startedAt, endedAt (ms), harName (or null when no HAR is saved), maxLines, relevantOnly }
function buildSummaryHtml(har, meta) {
  const { pages, entries, comment } = har.log;
  const tabTitle = Object.fromEntries(pages.map((p) => [p.id, p.title]));
  const maxLines = meta.maxLines || SUMMARY_DEFAULT_LINES;
  const calls = entries.map((e, i) => {
    const err = e.response._error;
    const tab = tabTitle[e.pageref] || '';
    return {
      n: i + 1,
      time: clock(new Date(e.startedDateTime)),
      screen: e._screen || tab,
      tab,
      method: e.request.method,
      status: e.response.status,
      statusText: err || e.response.statusText || '',
      ms: Math.round(e.time),
      url: e.request.url,
      cat: e._category || 'data',
      step: e._step || 0,
      payload: prettyBody(e.request.postData?.text, null, maxLines),
      response: prettyBody(e.response.content.text, e.response.content.encoding, maxLines)
        ?? (e.response.content.comment || (err ? `(no response: ${err})` : null)),
    };
  });
  const shots = meta.shots || {};
  const steps = (har.log._steps || []).map((st) => ({
    n: st.n, time: clock(new Date(st.t)), text: stepText(st), screen: st.screen || '',
    inputs: (st.inputs || []).map((x) => ({ label: x.label, value: x.value })),
    checkpoints: (st.checkpoints || []).map((c) => ({ text: c.text, time: clock(new Date(c.t)) })),
    ...(shots[st.n] ? { shot: `data:image/jpeg;base64,${shots[st.n]}` } : {}),
  }));
  const scenario = meta.scenario || har.log._scenario || null;
  const TIER_NAMES = { gold: 'Gold / Base', standard: 'Standard', custom: 'Custom' };
  const hosts = [...new Set(entries.map((e) => { try { return new URL(e.request.url).host; } catch { return ''; } }).filter(Boolean))];
  const bad = (c) => c.status >= 400 || c.status === 0;
  const relevant = calls.filter((c) => c.cat === 'data');
  const errors = calls.filter(bad).length;
  const slowest = (relevant.length ? relevant : calls).reduce((m, c) => Math.max(m, c.ms), 0);
  const start = new Date(meta.startedAt), end = new Date(meta.endedAt);
  const user = findUser(entries);
  // Every screen visited, in order (from your steps and each call's screen).
  const screens = [...new Set([
    ...(har.log._steps || []).map((st) => ({ t: st.t, name: st.screen })),
    ...entries.map((e) => ({ t: new Date(e.startedDateTime).getTime(), name: e._screen || tabTitle[e.pageref] })),
  ].filter((x) => x.name).sort((a, b) => a.t - b.t).map((x) => x.name))];
  const rows = [
    ['Site', `${hosts.join(', ') || '–'}${user ? ` · user ${user}` : ''}`],
    ...(scenario ? [['Scenario', [TIER_NAMES[scenario.tier] || scenario.tier, scenario.area, scenario.customer ? `customer ${scenario.customer}` : ''].filter(Boolean).join(' · ')]] : []),
    ...(scenario?.notes ? [['Notes', scenario.notes]] : []),
    ['Recorded', `${day(start)} · ${clock(start)} – ${clock(end)} (${span(meta.endedAt - meta.startedAt)})`],
    ['Screens', (screens.length ? screens : pages.map((p) => p.title)).join(' → ') || '–'],
    ...(meta.harName ? [['Full HAR', meta.harName]] : []),
  ];
  // Data for the page script; "<" escaped so nothing in a body can end the <script>.
  const data = JSON.stringify({ calls, steps, relevantOnly: meta.relevantOnly !== false }).replace(/</g, '\\u003c');
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
  .tools { display: flex; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; align-items: center; }
  .tools input[type=search] { flex: 1; min-width: 200px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: inherit; font: inherit; }
  .tools button { padding: 7px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: inherit; cursor: pointer; font: inherit; }
  .tools button.on { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .tools label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-weight: 600; padding: 0 4px; }
  .count { color: var(--muted); font-size: 12.5px; margin: 0 0 10px; }
  .stephead { display: flex; gap: 10px; align-items: baseline; margin: 16px 0 6px; padding: 0 2px; }
  .stephead b { font-size: 13.5px; }
  .stephead .sn { color: var(--accent); font-weight: 700; font-size: 12.5px; }
  .stephead .st { color: var(--muted); font-size: 12.5px; }
  .call { background: var(--card); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 6px; overflow: hidden; }
  .call.err { box-shadow: inset 4px 0 0 var(--err); } /* inner edge: rows stay aligned */
  .call.background { opacity: .62; }
  .head { display: grid; grid-template-columns: 30px 58px 40px 34px var(--tabw, 110px) minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 8px 12px; cursor: pointer; }
  .head:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
  .tab { justify-self: start; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--muted); background: var(--code); border-radius: 10px; padding: 1px 8px; }
  .n, .ms, .time { color: var(--muted); font-size: 12.5px; }
  .method { font-weight: 700; font-size: 12px; }
  .status { font-weight: 700; }
  .status.ok { color: var(--ok); } .status.bad { color: var(--err); }
  .path { font-family: ui-monospace, Consolas, monospace; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cat { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 10px; padding: 0 7px; margin-left: 6px; font-family: system-ui, sans-serif; }
  .more { display: block; width: 100%; text-align: left; margin: 0 0 6px; padding: 6px 12px; border: 1px dashed var(--line); border-radius: 8px; background: none; color: var(--muted); cursor: pointer; font: inherit; font-size: 12.5px; }
  .more:hover { color: var(--accent); border-color: var(--accent); }
  .tier { font-size: 12px; font-weight: 700; vertical-align: middle; border-radius: 10px; padding: 2px 10px; margin-left: 6px; border: 1px solid var(--line); color: var(--muted); }
  .tier.gold { background: #fbbc04; border-color: #fbbc04; color: #202124; }
  .tier.standard { background: #1a73e8; border-color: #1a73e8; color: #fff; }
  .tier.custom { background: #a142f4; border-color: #a142f4; color: #fff; }
  .inputs { margin: -2px 0 6px 2px; font-size: 12.5px; color: var(--muted); }
  .inputs b { color: var(--text); font-weight: 600; }
  .check { margin: 2px 0 8px 2px; font-size: 13px; color: var(--ok); font-weight: 600; }
  .shot { margin: 2px 0 10px 2px; }
  .shot img { max-width: 220px; max-height: 160px; border: 1px solid var(--line); border-radius: 6px; cursor: zoom-in; display: block; }
  .shot span { font-size: 11.5px; color: var(--muted); }
  #lightbox { position: fixed; inset: 0; background: rgba(0, 0, 0, .75); display: flex; align-items: center; justify-content: center; cursor: zoom-out; z-index: 10; }
  #lightbox img { max-width: 94vw; max-height: 94vh; border-radius: 6px; box-shadow: 0 8px 30px rgba(0, 0, 0, .5); }
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
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>${scenario ? `${escHtml(scenario.name)} <span class="tier ${escHtml(scenario.tier || '')}">${escHtml(TIER_NAMES[scenario.tier] || scenario.tier || '')}</span>` : 'API Recorder summary'}</h1>
  <table class="info">${rows.map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join('')}</table>
  <div class="stats">
    <div class="stat"><b>${relevant.length}</b>relevant</div>
    <div class="stat"><b>${calls.length}</b>calls in all</div>
    <div class="stat${errors ? ' err' : ''}"><b>${errors}</b>error${errors === 1 ? '' : 's'}</div>
    <div class="stat"><b>${slowest >= 1000 ? `${(slowest / 1000).toFixed(1)} s` : `${slowest} ms`}</b>slowest${relevant.length ? ' relevant' : ''}</div>
  </div>
  <div class="tools">
    <input type="search" id="q" placeholder="Filter by URL, payload or response text…">
    <label title="Hide the app's background calls (feature flags, chat, permissions, settings, icons); supporting lookups are folded under each step"><input type="checkbox" id="relevant"> Relevant calls only</label>
    <button id="all" class="on">All</button>
    <button id="errs">Errors only</button>
    <button id="expand">Expand all</button>
  </div>
  <p class="count" id="count"></p>
  <div id="list"></div>
  <p class="note">${escHtml(comment || '')} Click a call to see its payload and response. Steps are your clicks while recording; a call belongs to the last step before it.</p>
</main>
<script id="data" type="application/json">${data}</script>
<script>(${reportScript})();</script>
</body>
</html>
`;
}

// Runs inside the report page (inserted as source text, so it can't use
// anything outside itself).
function reportScript() {
  const { calls, steps, relevantOnly } = JSON.parse(document.getElementById('data').textContent);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Light JSON coloring on the escaped text: keys, strings, numbers/literals.
  const color = (t) => esc(t)
    .replace(/(&quot;(?:(?!&quot;).)*?&quot;)(\s*:)/g, '<span class="k">$1</span>$2')
    .replace(/(:\s*|^\s*|\[\s*|,\s*)(&quot;(?:(?!&quot;).)*?&quot;)/gm, '$1<span class="s">$2</span>')
    .replace(/(:\s*|^\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=\s*[,\]}]?\s*$)/gm, '$1<span class="d">$2</span>');
  const pane = (title, text, key) => `<div class="pane"><h3>${title}${text == null ? '' : `<button data-copy="${key}">Copy</button>`}</h3>${
    text == null ? '<div class="none">none</div>' : `<pre>${color(text)}</pre>`}</div>`;
  const path = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
  const isBad = (c) => c.status >= 400 || c.status === 0;
  const CAT_LABEL = { lookup: 'lookup', background: 'background' };

  const row = (c, i) => `<div class="call ${c.cat}${isBad(c) ? ' err' : ''}" data-i="${i}"><div class="head">
    <span class="n">#${c.n}</span><span class="time">${c.time}</span><span class="method">${esc(c.method)}</span>
    <span class="status ${isBad(c) ? 'bad' : 'ok'}" title="${esc(c.statusText)}">${c.status || 'ERR'}</span>
    <span class="tab" title="Screen: ${esc(c.screen)}${c.tab && c.tab !== c.screen ? ` · tab ${esc(c.tab)}` : ''}">${esc(c.screen || '–')}</span>
    <span class="path" title="${esc(c.url)}">${esc(path(c.url))}${CAT_LABEL[c.cat] ? `<span class="cat">${CAT_LABEL[c.cat]}</span>` : ''}</span>
    <span class="ms">${c.ms.toLocaleString('en-US')} ms</span></div>
    <div class="body"><div class="url">${esc(c.url)}${c.screen ? ` · ${esc(c.screen)}` : ''}${c.statusText ? ` · ${esc(c.statusText)}` : ''}</div>
    <div class="panes">${pane('Payload', c.payload, `${i}:p`)}${pane('Response', c.response, `${i}:r`)}</div></div></div>`;

  // Groups: calls before your first step, then one per step (in order).
  const groups = [];
  const before = calls.map((c, i) => i).filter((i) => !steps.some((st) => st.n === calls[i].step));
  if (before.length) groups.push({ step: 0, head: steps.length ? { n: 0, text: 'Before your first click', time: calls[before[0]].time } : null, items: before });
  for (const st of steps) groups.push({ step: st.n, head: st, items: calls.map((c, i) => i).filter((i) => calls[i].step === st.n) });
  // Typed values, checkpoints and the screenshot make a step worth showing even without API calls.
  const extras = (g) => Boolean(g.head && (g.head.inputs?.length || g.head.checkpoints?.length || g.head.shot));

  const list = document.getElementById('list');
  // One width for the screen column (the longest name, up to 150 px) so the endpoints line up.
  const ruler = document.createElement('span');
  ruler.className = 'tab';
  ruler.style.cssText = 'position:absolute;visibility:hidden;max-width:none';
  document.body.append(ruler);
  const tabWidth = Math.max(40, ...calls.map((c) => { ruler.textContent = c.screen || '–'; return ruler.offsetWidth; }));
  ruler.remove();
  list.style.setProperty('--tabw', `${Math.min(150, tabWidth + 2)}px`);

  list.innerHTML = groups.length ? groups.map((g, gi) => {
    const h = g.head;
    const head = h ? `<div class="stephead" data-g="${gi}"><span class="sn">${h.n ? `STEP ${h.n}` : 'START'}</span><b>${esc(h.text)}</b><span class="st">${h.time}${h.screen ? ` · ${esc(h.screen)}` : ''}</span></div>` : '';
    const inputs = h?.inputs?.length ? `<div class="inputs">Entered: ${h.inputs.map((x) => `${esc(x.label)} = <b>${esc(x.value || '(hidden)')}</b>`).join(' · ')}</div>` : '';
    // Every call in time order; lookups are folded in place while "relevant only" is on.
    const rows = g.items.map((i) => row(calls[i], i)).join('');
    const more = g.items.some((i) => calls[i].cat === 'lookup') ? `<button class="more" data-more="${gi}"></button>` : '';
    const checks = (h?.checkpoints || []).map((c) => `<div class="check">✔ Checkpoint: ${esc(c.text)} <span class="st">${c.time}</span></div>`).join('');
    const shot = h?.shot ? `<div class="shot"><img src="${h.shot}" alt="Screen after step ${h.n}" data-zoom="1"><span>Screen after this step</span></div>` : '';
    return `<section data-g="${gi}">${head}${inputs}${rows}${more}${checks}${shot}</section>`;
  }).join('') : '<div class="empty">No API calls were recorded.</div>';

  const relevantBox = document.getElementById('relevant');
  relevantBox.checked = relevantOnly;
  const openLookups = new Set();
  let errorsOnly = false;

  const apply = () => {
    const q = document.getElementById('q').value.toLowerCase();
    const relOnly = relevantBox.checked;
    const passes = (c) => (!errorsOnly || isBad(c)) && (!q || `${c.url} ${c.screen} ${c.payload || ''} ${c.response || ''}`.toLowerCase().includes(q));
    let shown = 0;
    groups.forEach((g, gi) => {
      const section = list.querySelector(`section[data-g="${gi}"]`);
      let any = false;
      for (const i of g.items) {
        const c = calls[i];
        let visible = passes(c);
        if (relOnly && c.cat === 'background') visible = false;
        if (relOnly && c.cat === 'lookup' && !openLookups.has(gi)) visible = false;
        list.querySelector(`.call[data-i="${i}"]`).hidden = !visible;
        if (visible) { shown++; any = true; }
      }
      // Folded lookups: "+ 5 supporting lookups" (only while relevant-only).
      const lk = g.items.filter((i) => calls[i].cat === 'lookup' && passes(calls[i]));
      const more = list.querySelector(`.more[data-more="${gi}"]`);
      if (more) {
        more.hidden = !relOnly || !lk.length;
        more.textContent = `${openLookups.has(gi) ? '−' : '+'} ${lk.length} supporting lookup${lk.length === 1 ? '' : 's'} (reference data)`;
        if (relOnly && lk.length) any = true;
      }
      // Searching or "errors only": just the steps with matching calls. Otherwise
      // a step also shows for its typed values, checkpoints or screenshot (and
      // every step shows while "relevant only" is off).
      const filtering = errorsOnly || q;
      section.hidden = !(any || (!filtering && (extras(g) || (!relOnly && g.head))));
    });
    document.getElementById('count').textContent = `Showing ${shown} of ${calls.length} calls${relOnly ? ' · background calls hidden' : ''}`;
  };

  list.addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const [i, k] = copy.dataset.copy.split(':');
      navigator.clipboard.writeText(k === 'p' ? calls[i].payload : calls[i].response).then(() => { copy.textContent = 'Copied'; });
      return;
    }
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) {
      const box = document.createElement('div');
      box.id = 'lightbox';
      box.innerHTML = `<img src="${zoom.src}" alt="">`;
      box.onclick = () => box.remove();
      document.body.append(box);
      return;
    }
    const more = e.target.closest('[data-more]');
    if (more) {
      const gi = Number(more.dataset.more);
      if (openLookups.has(gi)) openLookups.delete(gi); else openLookups.add(gi);
      apply();
      return;
    }
    e.target.closest('.head')?.parentElement.classList.toggle('open');
  });
  const allBtn = document.getElementById('all'), errBtn = document.getElementById('errs');
  document.getElementById('q').addEventListener('input', apply);
  relevantBox.addEventListener('change', apply);
  allBtn.onclick = () => { errorsOnly = false; allBtn.classList.add('on'); errBtn.classList.remove('on'); apply(); };
  errBtn.onclick = () => { errorsOnly = true; errBtn.classList.add('on'); allBtn.classList.remove('on'); apply(); };
  document.getElementById('expand').onclick = (e) => {
    const open = e.target.textContent === 'Expand all';
    list.querySelectorAll('.call:not([hidden])').forEach((el) => el.classList.toggle('open', open));
    e.target.textContent = open ? 'Collapse all' : 'Expand all';
  };
  apply();
}

if (typeof module !== 'undefined') module.exports = { buildSummaryHtml, findUser, prettyBody, stepText, SUMMARY_DEFAULT_LINES };
