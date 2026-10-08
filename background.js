// API Recorder - background service worker.
//
// Click the toolbar icon: start recording the tab's network traffic with
// Chrome's debugger (the same engine as DevTools' Network panel). Click it
// again: stop, build a HAR file (har.js) and download it. The badge shows how
// many calls have been captured. Chrome shows its "started debugging this
// browser" bar while recording; its Cancel button also stops and saves.

importScripts('har.js', 'summary.js');

let session = null; // the recording in progress, see start()
let keepAlive = null;

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// ---- toolbar ---------------------------------------------------------------

const IDLE_TITLE = "API Recorder: click to start recording this tab's API calls";

chrome.action.onClicked.addListener(async (tab) => {
  if (session) await stop('button');
  else await start(tab);
});

// Keyboard shortcut (Alt+Shift+B by default): stop and save while recording;
// otherwise start – in scenario mode by opening the scenario panel for the
// name, since the icon may be out of sight (e.g. in a narrow frame window).
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-recording') return;
  if (session) return stop('shortcut');
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  if (!(await getSettings()).scenarioMode) return start(tab);
  // The panel records this tab, even when it opens in a window of its own.
  await chrome.storage.session.set({ panelTabId: tab.id });
  try {
    await chrome.action.openPopup({ windowId: tab.windowId });
  } catch {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    await chrome.windows.create({
      url: 'popup.html', type: 'popup', width: 380, height: 560, focused: true,
      ...(win ? { left: win.left + 40, top: win.top + 80 } : {}),
    });
  }
});

// The key guard (keyguard.js) asks which shortcuts to keep away from the page.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'keyguard-get' || sender.id !== chrome.runtime.id) return;
  chrome.commands.getAll().then((cmds) => sendResponse({ shortcuts: cmds.map((c) => c.shortcut).filter(Boolean) }), () => sendResponse({}));
  return true;
});

function showBadge() {
  if (!session) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: IDLE_TITLE });
    return;
  }
  const n = session.done.length;
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
  chrome.action.setBadgeText({ text: n === 0 ? 'REC' : n > 999 ? '999+' : String(n) });
  chrome.action.setTitle({ title: `API Recorder: recording, ${n} call${n === 1 ? '' : 's'} so far. Click to stop and save the HAR file.` });
}

// A short message on the icon (e.g. a page that can't be recorded).
function flash(text, title) {
  chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
  chrome.action.setBadgeText({ text });
  chrome.action.setTitle({ title });
  setTimeout(() => { if (!session) showBadge(); }, 4000);
}

// ---- recording -------------------------------------------------------------

async function start(tab, scenario = null) {
  if (!/^https?:/i.test(tab?.url || '')) {
    flash('!', "API Recorder: this page can't be recorded (only http/https pages)");
    return "This page can't be recorded (only http/https pages).";
  }
  session = {
    rootTabId: tab.id,
    tabs: new Set(),
    pages: new Map(),
    records: new Map(), // key `${tabId}:${requestId}` -> record still in flight
    extra: new Map(),   // ExtraInfo headers that arrived before their request
    done: [],           // finished records, in order
    pending: new Set(), // body/post-data fetches in progress
    following: new Set(), // new tabs being attached
    actions: [],          // your clicks / Enter / screen changes (summary steps)
    screens: new Map(),   // tabId -> the screen's current title
    scenario,             // { name, tier, area, customer, notes } in scenario mode
    shots: [],            // screenshots: { tabId, t (the step's action), data }
    befores: [],          // "before" screenshots (after you typed): { tabId, t (the step's action), data }
    pendingBefore: new Map(), // tabId -> the "before" picture taken after typing, waiting for its step
    shotTimers: new Map(), // tabId -> the step waiting for its screenshot
    settings: await getSettings(),
    startedAt: Date.now(),
  };
  try {
    await attach(tab);
  } catch (e) {
    session = null;
    flash('!', `API Recorder: couldn't start recording (${e.message || e})`);
    return `Couldn't start recording: ${e.message || e}`;
  }
  // The service worker must stay awake while recording: quiet periods would
  // otherwise let Chrome stop it and lose what was captured.
  keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  showBadge();
  return null;
}

async function attach(tab) {
  const target = { tabId: tab.id };
  await chrome.debugger.attach(target, '1.3');
  session.tabs.add(tab.id);
  session.pages.set(tab.id, { tabId: tab.id, url: tab.url || tab.pendingUrl || '', title: tab.title || '', startedAt: Date.now() });
  session.screens.set(tab.id, tab.title || '');
  await chrome.debugger.sendCommand(target, 'Network.enable', { maxPostDataSize: 1024 * 1024 });
  if (session.settings.trackClicks) await installTracker(target).catch((e) => console.warn('API Recorder: no click tracking', e));
}

// ---- your actions (for the summary's steps) ---------------------------------
// A small listener in the recorded page reports what you do through a
// debugger binding: clicks (with a fingerprint of what was clicked, for a
// later UI replay), Enter and shortcut keys, values you typed into fields,
// and screen changes. Password-like fields are never read. Installed for the
// current page and every page loaded afterwards.

// Named after the extension's version: a page that was open before an update
// still runs the old tracker, which must neither block the new one nor keep
// reporting (it calls a binding name that no longer exists).
const BINDING = `__apiRecorderAction_${chrome.runtime.getManifest().version.replace(/\W/g, '_')}`;

function pageTracker(binding) {
  if (window[`${binding}_installed`]) return;
  window[`${binding}_installed`] = true;
  // The screen's name: the visible page header (WM Mobile shows "MENU", "Blind
  // Receipt"… while its tab title stays "WM Mobile"), else the tab title.
  const screenName = () => {
    const titles = [...document.querySelectorAll('ion-header ion-title, ion-toolbar ion-title')]
      .filter((el) => el.getClientRects().length && !el.closest('.ion-page-hidden'));
    const header = titles.length ? titles[titles.length - 1].innerText.replace(/\s+/g, ' ').trim() : '';
    return header || document.title;
  };
  const report = (o) => {
    try { window[binding](JSON.stringify({ ...o, t: Date.now(), title: screenName() })); } catch (e) { /* binding gone */ }
  };
  const clean = (s, n = 60) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const CLICKABLE = 'button, a, [role=button], [role=menuitem], [role=tab], [role=option], [role=row], [role=gridcell], ion-item, ion-button, mat-option, li, tr, td, label, summary, input, select';
  const labelOf = (el) => clean(el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || el.tagName.toLowerCase());
  const isSecret = (el, label) => el.type === 'password' || /pass|pin|secret|token/i.test(`${label} ${el.name || ''} ${el.id || ''}`);
  // A field's label: <label for>, aria-label, placeholder, name, or the label text of its form row.
  const fieldLabel = (el) => clean(
    el.labels?.[0]?.innerText || el.getAttribute('aria-label')
    || el.closest('ion-item, mat-form-field, .form-group, .field, tr')?.querySelector('ion-label, label, mat-label, th')?.innerText
    || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || el.tagName.toLowerCase());
  // What was clicked, for finding it again later.
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    ...(el.id ? { id: el.id } : {}),
    ...(el.getAttribute('name') ? { name: el.getAttribute('name') } : {}),
    ...(el.getAttribute('role') ? { role: el.getAttribute('role') } : {}),
    ...(el.classList.length ? { classes: [...el.classList].slice(0, 4).join(' ') } : {}),
    text: clean(el.innerText || el.textContent, 80),
    path: (() => {
      const parts = [];
      for (let n = el.parentElement, k = 0; n && k < 4; n = n.parentElement, k++) {
        parts.push(n.tagName.toLowerCase() + (n.id ? `#${n.id}` : '') + (n.classList.length ? `.${[...n.classList].slice(0, 2).join('.')}` : ''));
      }
      return parts.join(' < ');
    })(),
  });
  // Components like Ionic's ion-button keep their real <button> in a shadow
  // root, with the text ("GO") on the outer element: use the outer one.
  const inShadow = (n) => n.getRootNode() instanceof ShadowRoot;
  // The field next to a clicked button (e.g. ASN beside GO), with its value -
  // empty matters: GO on an empty ASN creates a new one.
  // Only when it's the one field around the button (like WM Mobile's ASN row);
  // a button among several fields gets none rather than a guess.
  const fieldNear = (el) => {
    for (let n = el.parentElement, k = 0; n && n !== document.body && k < 3; n = n.parentElement, k++) {
      const fields = [...n.querySelectorAll('input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select')].filter((f) => f !== el);
      if (fields.length === 1) return fields[0];
      if (fields.length > 1) return null;
    }
    return null;
  };
  addEventListener('click', (e) => {
    flushTyping();
    const path = e.composedPath().filter((n) => n instanceof Element);
    const el = path.find((n) => n.matches(CLICKABLE) && !inShadow(n)) || path.find((n) => !inShadow(n)) || path[0];
    // Clicking into a text box only places the cursor: Enter or the typed value is the step.
    if (!el || (el.matches('textarea, input') && !/^(button|submit|checkbox|radio|reset|image|file|color|range)$/i.test(el.type))) return;
    const near = el.matches('button, ion-button, [role=button], input[type=button], input[type=submit]') ? fieldNear(el) : null;
    const field = near ? (() => { const label = fieldLabel(near); return { label, value: isSecret(near, label) ? '' : clean(near.value, 40) }; })() : null;
    report({ kind: 'click', label: labelOf(el), target: describe(el), ...(field ? { field } : {}) });
  }, true);
  // Field values: remember the value when a field gets focus, report it when you leave if it changed.
  const before = new WeakMap();
  const fieldOf = (e) => e.composedPath().find((n) => n instanceof Element && n.matches('input, textarea, select'));
  addEventListener('focusin', (e) => { const el = fieldOf(e); if (el) before.set(el, el.value); }, true);
  // Typing or pasting into a field: tell the recorder once it pauses (it takes a
  // "before" picture showing the value), or right before the click / Enter.
  let dirty = false;
  let typingTimer;
  const flushTyping = () => {
    clearTimeout(typingTimer);
    if (!dirty) return;
    dirty = false;
    report({ kind: 'typing' });
  };
  addEventListener('input', (e) => {
    if (!fieldOf(e)) return;
    dirty = true;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(flushTyping, 150);
  }, true);
  addEventListener('focusout', (e) => {
    const el = fieldOf(e);
    if (!el || before.get(el) === el.value || /^(button|submit|checkbox|radio|reset|image|file)$/i.test(el.type)) return;
    const label = fieldLabel(el);
    before.set(el, el.value);
    report({ kind: 'input', label, value: isSecret(el, label) ? '' : clean(el.value, 40) });
  }, true);
  addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      flushTyping();
      const el = fieldOf(e) || e.composedPath()[0];
      if (!(el instanceof Element)) return;
      const label = fieldLabel(el);
      before.set(el, el.value);
      report({ kind: 'enter', label, value: isSecret(el, label) ? '' : clean(el.value, 40) });
      return;
    }
    // Function keys and shortcuts (Ctrl/Alt + key) are steps too.
    const fkey = /^F([1-9]|1[0-2])$/.test(e.key);
    if (fkey || ((e.ctrlKey || e.altKey) && e.key.length === 1)) {
      const combo = `${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${fkey ? e.key : e.key.toUpperCase()}`;
      if (!/^Ctrl\+[CVXAZ]$/.test(combo)) report({ kind: 'key', label: combo });
    }
  }, true);
  // Screen changes (single-page apps change the title or address without a page load).
  let last = document.title + location.href;
  setInterval(() => {
    const now = document.title + location.href;
    if (now !== last) { last = now; report({ kind: 'screen' }); }
  }, 400);
  report({ kind: 'load' });
}

async function installTracker(target) {
  const source = `(${pageTracker})(${JSON.stringify(BINDING)});`;
  await chrome.debugger.sendCommand(target, 'Runtime.enable');
  await chrome.debugger.sendCommand(target, 'Runtime.addBinding', { name: BINDING });
  await chrome.debugger.sendCommand(target, 'Page.enable');
  await chrome.debugger.sendCommand(target, 'Page.addScriptToEvaluateOnNewDocument', { source });
  await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: source }).catch(() => {});
}

function onAction(tabId, payload) {
  let a;
  try { a = JSON.parse(payload); } catch { return; }
  if (a.title) session.screens.set(tabId, a.title);
  if (a.kind === 'screen') return;
  if (a.kind === 'typing') { takeBefore(tabId); return; }
  // A page load becomes a step named after the screen ("Opened …").
  session.actions.push({
    tabId, kind: a.kind, label: a.kind === 'load' ? '' : a.label, value: a.value || '', title: a.title || '', t: a.t,
    ...(a.target ? { target: a.target } : {}),
    ...(a.field ? { field: a.field } : {}),
  });
  if (STEP_KINDS.includes(a.kind)) {
    claimBefore(tabId, a.t);
    scheduleShot(tabId, a.t);
  }
}

// ---- screenshots (scenario mode) ----------------------------------------------
// One picture per step, taken once the step's calls have finished and the
// app's loading overlay (WM Mobile's "Loading....") is gone, plus a short
// settle: at least 0.9 s after the action, at most 30 s (slow transactions
// take 8 s or more). A new action first takes the previous step's picture
// straight away.

function scheduleShot(tabId, actionT) {
  const s = session;
  if (!s?.scenario || !s.settings.screenshots) return;
  const waiting = s.shotTimers.get(tabId);
  if (waiting) {
    clearTimeout(waiting.timer);
    takeShot(s, tabId, waiting.t);
  }
  const startedAt = Date.now();
  const entry = { t: actionT };
  let quietSince = 0;
  const check = async () => {
    if (s.shotTimers.get(tabId) !== entry) return; // replaced by a newer step
    const calls = [...s.records.values()].some((r) => r.tabId === tabId);
    const loading = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: "[...document.querySelectorAll('ion-loading')].some((el) => !el.classList.contains('overlay-hidden') && el.getClientRects().length > 0)",
      returnByValue: true,
    }).then((r) => Boolean(r?.result?.value), () => false);
    const busy = calls || loading;
    quietSince = busy ? 0 : quietSince || Date.now();
    // Quiet for 0.4 s (the new screen has drawn), or give up after 30 s.
    if ((!quietSince || Date.now() - quietSince < 400) && Date.now() - startedAt < 30000) { entry.timer = setTimeout(check, 200); return; }
    if (s.shotTimers.get(tabId) !== entry) return;
    s.shotTimers.delete(tabId);
    takeShot(s, tabId, actionT);
  };
  entry.timer = setTimeout(check, 900);
  s.shotTimers.set(tabId, entry);
}

// "Before" pictures: only when you typed or pasted since the last picture,
// taken as soon as the typing pauses (so the value is visible in the field),
// and given to the step that follows (the GO / Enter that submits it).
// Screenshot with other tools' overlays (Claude in Chrome's glow border and
// cursor, Device Frame's bezel) hidden for the moment of the capture. A counter in the page keeps
// overlapping captures from showing them again too early.
async function capture(s, tabId) {
  const sel = [
    s.settings.hideOverlays && (s.settings.overlaySelectors || '').trim(),
    s.settings.hideBezel && '#__devframe', // Device Frame's phone bezel and toolbar
  ].filter(Boolean).join(', ');
  const run = (expression) => chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression }).catch(() => {});
  if (sel) {
    await run(`(() => { const w = window; w.__apiRecorderHide = (w.__apiRecorderHide || 0) + 1;
      if (!document.getElementById('__apiRecorderHide')) { const st = document.createElement('style'); st.id = '__apiRecorderHide';
        st.textContent = ${JSON.stringify(sel)} + ' { visibility: hidden !important; }'; (document.head || document.documentElement).appendChild(st); } })()`);
  }
  try {
    // In a Device Frame (version 0.23.1+ says where the device is): crop to it.
    let geo = null;
    if (s.settings.cropToDevice) {
      const r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(() => { const d = document.getElementById('__devframe')?.dataset.capture; return d ? { d, w: innerWidth } : null; })()`,
        returnByValue: true,
      }).catch(() => null);
      const v = r?.result?.value;
      if (v?.d) try { geo = { ...JSON.parse(v.d), viewW: v.w }; } catch { /* old Device Frame */ }
    }
    const r = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', geo ? { format: 'png' } : { format: 'jpeg', quality: 60 });
    if (!r?.data) return null;
    if (!geo) return { data: r.data, ext: 'jpg' };
    return { data: await cropToDevice(r.data, geo, s.settings.hideBezel), ext: 'png' };
  } finally {
    if (sel) {
      await run(`(() => { const w = window; w.__apiRecorderHide = Math.max(0, (w.__apiRecorderHide || 1) - 1);
        if (!w.__apiRecorderHide) document.getElementById('__apiRecorderHide')?.remove(); })()`);
    }
  }
}

// Cut the device (or, with the bezel hidden, its screen) out of a full-window
// PNG, transparent outside its outline (rounded corners). geo is in CSS px.
async function cropToDevice(base64, geo, screenOnly) {
  const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
  const scale = bitmap.width / geo.viewW; // image px per CSS px (zoom x DPR)
  const pad = screenOnly ? 0 : geo.pad;
  const area = screenOnly ? geo.screen : geo.bounds;
  const crop = { x: area.x - pad, y: area.y - pad, w: area.w + pad * 2, h: area.h + pad * 2 };
  const canvas = new OffscreenCanvas(Math.round(crop.w * scale), Math.round(crop.h * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, crop.x * scale, crop.y * scale, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  // Keep only what's inside the outline.
  ctx.globalCompositeOperation = 'destination-in';
  ctx.setTransform(scale, 0, 0, scale, -crop.x * scale, -crop.y * scale);
  if (screenOnly) {
    const { x, y, w, h } = geo.screen;
    const r = Math.min(geo.screen.r || 0, w / 2, h / 2);
    const path = new Path2D();
    path.roundRect(x, y, w, h, r);
    ctx.fill(path);
  } else {
    ctx.fill(new Path2D(geo.mask));
  }
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function takeBefore(tabId) {
  const s = session;
  if (!s?.scenario || !s.settings.screenshots) return;
  const shot = capture(s, tabId).catch(() => null);
  s.pendingBefore.set(tabId, shot);
  s.pending.add(shot);
  shot.finally(() => s.pending.delete(shot));
}

function claimBefore(tabId, actionT) {
  const s = session;
  const capture = s?.pendingBefore.get(tabId);
  if (!capture) return;
  s.pendingBefore.delete(tabId);
  const job = capture.then((shot) => { if (shot) s.befores.push({ tabId, t: actionT, ...shot }); });
  s.pending.add(job);
  job.finally(() => s.pending.delete(job));
}

function takeShot(s, tabId, t) {
  const job = capture(s, tabId)
    .then((shot) => { if (shot) s.shots.push({ tabId, t, ...shot }); })
    .catch(() => { /* tab closed or hidden */ });
  s.pending.add(job);
  job.finally(() => s.pending.delete(job));
}

// Tabs opened by a recorded tab (e.g. WM Mobile opening in a new tab with
// window.open or a target=_blank link).
async function follow(tabId, openerTabId) {
  const s = session;
  // Both events below can report the same tab: only attach once.
  if (!s?.settings.followTabs || !s.tabs.has(openerTabId) || s.tabs.has(tabId) || s.following.has(tabId)) return;
  s.following.add(tabId);
  try {
    await attach(await chrome.tabs.get(tabId));
  } catch (e) {
    console.warn('API Recorder: could not follow tab', tabId, e);
  } finally {
    s.following.delete(tabId);
  }
}
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ tabId, sourceTabId }) => follow(tabId, sourceTabId));
chrome.tabs.onCreated.addListener((tab) => { if (tab.openerTabId !== undefined) follow(tab.id, tab.openerTabId); });

chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (!session || !session.tabs.has(source.tabId)) return;
  session.tabs.delete(source.tabId);
  // Cancel on Chrome's debugging bar, or the recorded tab closed: save what we have.
  if (reason === 'canceled_by_user' || source.tabId === session.rootTabId || session.tabs.size === 0) await stop(reason);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!session || !session.tabs.has(source.tabId)) return;
  if (method === 'Runtime.bindingCalled') {
    if (params.name === BINDING) onAction(source.tabId, params.payload);
    return;
  }
  if (!method.startsWith('Network.')) return;
  const key = `${source.tabId}:${params.requestId}`;
  const rec = session.records.get(key);
  switch (method) {
    case 'Network.requestWillBeSent': {
      // A redirect reuses the request id: the earlier hop ends here.
      if (rec && params.redirectResponse) {
        rec.redirectResponse = params.redirectResponse;
        rec.finishedAt = params.timestamp;
        finish(key, rec);
      }
      if (!wanted(params.request.url, params.type, session.settings)) return;
      const extra = session.extra.get(key);
      session.extra.delete(key);
      session.records.set(key, { tabId: source.tabId, sent: params, screen: session.screens.get(source.tabId), extraRequestHeaders: extra?.request, extraResponseHeaders: extra?.response });
      break;
    }
    case 'Network.requestWillBeSentExtraInfo':
      if (rec) rec.extraRequestHeaders = params.headers;
      else session.extra.set(key, { ...session.extra.get(key), request: params.headers });
      break;
    case 'Network.responseReceived':
      if (rec) rec.response = params.response;
      break;
    case 'Network.responseReceivedExtraInfo':
      if (rec) rec.extraResponseHeaders = params.headers;
      else session.extra.set(key, { ...session.extra.get(key), response: params.headers });
      break;
    case 'Network.loadingFinished':
      if (!rec) return;
      rec.finishedAt = params.timestamp;
      rec.encodedLength = params.encodedDataLength;
      collect(source, params.requestId, key, rec);
      break;
    case 'Network.loadingFailed':
      if (!rec) return;
      rec.finishedAt = params.timestamp;
      rec.failed = { errorText: params.errorText, canceled: Boolean(params.canceled) };
      finish(key, rec);
      break;
  }
});

// Fetch the response body (and a large request body) before Chrome drops it.
function collect(source, requestId, key, rec) {
  const { settings } = session;
  const s = session;
  const job = (async () => {
    if (rec.sent.request.hasPostData && rec.sent.request.postData === undefined) {
      const r = await chrome.debugger.sendCommand(source, 'Network.getRequestPostData', { requestId }).catch(() => null);
      if (r) rec.postData = r.postData;
    }
    if (settings.bodies) {
      if ((rec.encodedLength ?? 0) > settings.maxBodyKB * 1024) {
        rec.bodySkipped = `Body not saved: larger than ${settings.maxBodyKB} KB (see API Recorder options)`;
      } else {
        const r = await chrome.debugger.sendCommand(source, 'Network.getResponseBody', { requestId }).catch(() => null);
        if (r) rec.body = { text: r.body, base64Encoded: r.base64Encoded, size: r.base64Encoded ? Math.floor(r.body.length * 0.75) : r.body.length };
      }
    }
  })();
  s.pending.add(job);
  job.finally(() => {
    s.pending.delete(job);
    if (session === s) finish(key, rec);
    else s.done.push(rec); // stopped meanwhile: still include it
  });
}

function finish(key, rec) {
  if (!session) return;
  session.records.delete(key);
  session.done.push(rec);
  showBadge();
}

async function stop(reason) {
  const s = session;
  if (!s) return;
  session = null;
  clearInterval(keepAlive);
  showBadge();
  // Steps still waiting for their screenshot get it now, before letting go of the tabs.
  for (const [tabId, waiting] of s.shotTimers) { clearTimeout(waiting.timer); takeShot(s, tabId, waiting.t); }
  // Let body fetches that are already running finish, then let go of the tabs.
  await Promise.allSettled([...s.pending]);
  for (const tabId of s.tabs) await chrome.debugger.detach({ tabId }).catch(() => {});
  // Requests still in flight with a response are kept (no timing end yet).
  for (const rec of s.records.values()) if (rec.response) s.done.push(rec);
  for (const page of s.pages.values()) {
    const tab = await chrome.tabs.get(page.tabId).catch(() => null);
    if (tab) Object.assign(page, { url: tab.url || page.url, title: tab.title || page.title });
  }
  const scenario = s.scenario ? { ...s.scenario, recordedAt: new Date(s.startedAt).toISOString() } : null;
  const har = buildHar(s.done, [...s.pages.values()], s.settings, chrome.runtime.getManifest().version, s.actions, scenario);
  const rootUrl = s.pages.get(s.rootTabId)?.url || '';
  // Screenshots belong to the step whose action they follow.
  const shots = {};
  for (const shot of s.shots) {
    const step = har.log._steps.find((st) => st.t === shot.t && st.tabId === shot.tabId);
    if (step && !step.noEffect && !shots[step.n]) shots[step.n] = shot;
  }
  const befores = {};
  for (const shot of s.befores) {
    const step = har.log._steps.find((st) => st.t === shot.t && st.tabId === shot.tabId);
    if (step && !befores[step.n]) befores[step.n] = shot;
  }
  // Scenario mode: Downloads/<folder>/<tier>-<name>_<timestamp>/recording.har, .html, step-01.jpg …
  // Otherwise: API_<host>_<timestamp>.har / .html.
  const folder = scenario ? `${scenarioDir(s.settings.scenarioFolder, scenario)}/` : '';
  const harName = scenario ? `${folder}recording.har` : harFilename(s.settings.filename, rootUrl);
  const saveHar = s.settings.outputHar || !s.settings.outputSummary;
  if (saveHar) await download(JSON.stringify(har, null, 2), harName);
  if (s.settings.outputSummary) {
    const html = buildSummaryHtml(har, {
      startedAt: s.startedAt, endedAt: Date.now(), harName: saveHar ? harName.split('/').pop() : null,
      maxLines: s.settings.summaryLines, relevantOnly: s.settings.relevantOnly, scenario, shots, befores,
    });
    await download(html, harName.replace(/\.har$/i, '.html'));
  }
  // step-04-1-before.jpg, step-04-2-after.jpg: in order in any file list or
  // image viewer (with step-04.jpg / step-04-before.jpg a natural sort, as in
  // IrfanView, showed the after picture first).
  const save = (shot, n, kind) => download(shot.data, `${folder}step-${String(n).padStart(2, '0')}-${kind}.${shot.ext}`, shot.ext === 'png' ? 'image/png' : 'image/jpeg', true);
  for (const [n, shot] of Object.entries(befores)) await save(shot, n, '1-before');
  for (const [n, shot] of Object.entries(shots)) await save(shot, n, '2-after');
  const what = scenario ? `"${scenario.name}" (${s.done.length} calls, ${Object.keys(shots).length} screenshots) to Downloads\\${folder.replace(/\//g, '\\')}` : `${s.done.length} call(s) to Downloads`;
  flash(String(s.done.length > 999 ? '999+' : s.done.length), `API Recorder: saved ${what}${reason === 'button' ? '' : ` (${reason.replace(/_/g, ' ')})`}`);
  chrome.action.setBadgeBackgroundColor({ color: '#188038' });
}

// Download a text file from the service worker (no page needed): a base64
// data URL, built in chunks so large HARs don't overflow the call stack.
// Chrome may ignore the name passed to downloads.download (it did on the
// user's machine, saving "download" without an extension); naming our own
// downloads here takes priority. Other downloads are left alone.
const nextFilenames = []; // our downloads, in the order they were started
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId !== chrome.runtime.id || !nextFilenames.length) return;
  suggest({ filename: nextFilenames.shift(), conflictAction: 'uniquify' });
});

async function download(content, filename, type = 'application/octet-stream', isBase64 = false) {
  let data = content;
  if (!isBase64) {
    const bytes = new TextEncoder().encode(content);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    data = btoa(binary);
  }
  // octet-stream for text, so Chrome keeps the .har extension (with JSON it renames it .json).
  const url = `data:${type};base64,${data}`;
  nextFilenames.push(filename);
  await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
}

// "Scenario name" folder: <tier>-<name>_<YYYYMMDDHHMMSS>, only letters, digits and dashes.
function scenarioDir(base, scenario, date = new Date()) {
  const slug = String(scenario.name || 'scenario').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'scenario';
  const stamp = harFilename('{timestamp}', '', date).replace(/\.har$/, '');
  const root = String(base || DEFAULT_SETTINGS.scenarioFolder).replace(/[\\:*?"<>|]+/g, '_').replace(/^\/+|\/+$/g, '');
  return `${root}/${scenario.tier || 'standard'}-${slug}_${stamp}`;
}

// ---- the scenario panel (popup.html) ----------------------------------------
// In scenario mode the icon opens a panel (name, tier, area… then Start;
// while recording: Add checkpoint, Stop & save) instead of starting at once.

async function applyIconMode() {
  const { scenarioMode } = await getSettings();
  await chrome.action.setPopup({ popup: scenarioMode ? 'popup.html' : '' });
}
chrome.storage.onChanged.addListener((changes) => { if (changes.settings) applyIconMode(); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // From the scenario panel only (popup.html, also when opened in a tab).
  if (!msg?.type?.startsWith('panel-') || sender.id !== chrome.runtime.id || !sender.url?.includes('/popup.html')) return;
  (async () => {
    switch (msg.type) {
      case 'panel-status':
        return session ? {
          recording: true, scenario: session.scenario, startedAt: session.startedAt,
          calls: session.done.length, steps: session.actions.filter((a) => STEP_KINDS.includes(a.kind)).length,
          checkpoints: session.actions.filter((a) => a.kind === 'checkpoint').length,
        } : { recording: false };
      case 'panel-start': {
        if (session) return { error: 'Already recording.' };
        // Opened by the shortcut: record the tab it was pressed in (the panel
        // may be a window of its own, which would otherwise count as active).
        const { panelTabId } = await chrome.storage.session.get('panelTabId');
        await chrome.storage.session.remove('panelTabId');
        let tab = panelTabId !== undefined ? await chrome.tabs.get(panelTabId).catch(() => null) : null;
        if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const error = await start(tab, msg.scenario);
        return error ? { error } : { ok: true };
      }
      case 'panel-checkpoint':
        if (!session) return { error: 'Not recording.' };
        session.actions.push({ tabId: session.rootTabId, kind: 'checkpoint', label: String(msg.text || '').slice(0, 200), t: Date.now() });
        return { ok: true };
      case 'panel-stop':
        await stop('button');
        return { ok: true };
    }
    return {};
  })().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

// After a browser or extension restart nothing is recording: clear the badge.
chrome.runtime.onStartup.addListener(() => { showBadge(); applyIconMode(); });
chrome.runtime.onInstalled.addListener(() => { showBadge(); applyIconMode(); });
applyIconMode();
