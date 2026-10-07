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

async function start(tab) {
  if (!/^https?:/i.test(tab.url || '')) {
    flash('!', "API Recorder: this page can't be recorded (only http/https pages)");
    return;
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
    settings: await getSettings(),
    startedAt: Date.now(),
  };
  try {
    await attach(tab);
  } catch (e) {
    session = null;
    flash('!', `API Recorder: couldn't start recording (${e.message || e})`);
    return;
  }
  // The service worker must stay awake while recording: quiet periods would
  // otherwise let Chrome stop it and lose what was captured.
  keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  showBadge();
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
// A small listener in the recorded page reports clicks, Enter and screen
// changes through a debugger binding. It reads labels (button text, field
// names) and the value of a field you press Enter in, never password-like
// fields. Installed for the current page and every page loaded afterwards.

const BINDING = '__apiRecorderAction';

function pageTracker() {
  if (window.__apiRecorderTracker) return;
  window.__apiRecorderTracker = true;
  const report = (o) => {
    try { window.__apiRecorderAction(JSON.stringify({ ...o, t: Date.now(), title: document.title })); } catch (e) { /* binding gone */ }
  };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const CLICKABLE = 'button, a, [role=button], [role=menuitem], [role=tab], [role=option], [role=row], [role=gridcell], ion-item, ion-button, mat-option, li, tr, td, label, summary, input, select';
  const labelOf = (el) => clean(el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || el.tagName.toLowerCase());
  addEventListener('click', (e) => {
    const path = e.composedPath().filter((n) => n instanceof Element);
    const el = path.find((n) => n.matches(CLICKABLE)) || path[0];
    // Clicking into a text box only places the cursor: Enter there is the step.
    if (!el || (el.matches('textarea, input') && !/^(button|submit|checkbox|radio|reset|image|file|color|range)$/i.test(el.type))) return;
    report({ kind: 'click', label: labelOf(el) });
  }, true);
  addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = e.composedPath().find((n) => n instanceof Element && n.matches('input, textarea, select')) || e.composedPath()[0];
    if (!(el instanceof Element)) return;
    const field = clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || el.tagName.toLowerCase());
    const secret = el.type === 'password' || /pass|pin|secret|token/i.test(field);
    report({ kind: 'enter', label: field, value: secret ? '' : clean(el.value).slice(0, 40) });
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
  const source = `(${pageTracker})();`;
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
  // A page load becomes a step named after the screen ("Opened …").
  session.actions.push({ tabId, kind: a.kind, label: a.kind === 'load' ? '' : a.label, value: a.value || '', title: a.title || '', t: a.t });
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
  // Let body fetches that are already running finish, then let go of the tabs.
  await Promise.allSettled([...s.pending]);
  for (const tabId of s.tabs) await chrome.debugger.detach({ tabId }).catch(() => {});
  // Requests still in flight with a response are kept (no timing end yet).
  for (const rec of s.records.values()) if (rec.response) s.done.push(rec);
  for (const page of s.pages.values()) {
    const tab = await chrome.tabs.get(page.tabId).catch(() => null);
    if (tab) Object.assign(page, { url: tab.url || page.url, title: tab.title || page.title });
  }
  const har = buildHar(s.done, [...s.pages.values()], s.settings, chrome.runtime.getManifest().version, s.actions);
  const rootUrl = s.pages.get(s.rootTabId)?.url || '';
  // Full details (HAR) and/or the summary report, with matching names.
  const harName = harFilename(s.settings.filename, rootUrl);
  const saveHar = s.settings.outputHar || !s.settings.outputSummary;
  if (saveHar) await download(JSON.stringify(har, null, 2), harName);
  if (s.settings.outputSummary) {
    const html = buildSummaryHtml(har, { startedAt: s.startedAt, endedAt: Date.now(), harName: saveHar ? harName : null, maxLines: s.settings.summaryLines, relevantOnly: s.settings.relevantOnly });
    await download(html, harName.replace(/\.har$/i, '.html'));
  }
  flash(String(s.done.length > 999 ? '999+' : s.done.length), `API Recorder: saved ${s.done.length} call(s) to Downloads${reason === 'button' ? '' : ` (${reason.replace(/_/g, ' ')})`}`);
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

async function download(text, filename) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  // octet-stream, so Chrome keeps the .har extension (with JSON it renames it .json).
  const url = `data:application/octet-stream;base64,${btoa(binary)}`;
  nextFilenames.push(filename);
  await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
}

// After a browser or extension restart nothing is recording: clear the badge.
chrome.runtime.onStartup.addListener(showBadge);
chrome.runtime.onInstalled.addListener(showBadge);
