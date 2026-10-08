// API Recorder - turning Chrome's Network events into a HAR 1.2 file.
//
// Pure functions (no chrome.* calls), shared by the service worker
// (importScripts) and the tests. A "record" is what background.js collects
// for one request from the debugger's Network events:
//   { tabId, sent, extraRequestHeaders, response, extraResponseHeaders,
//     finishedAt, encodedLength, failed: { errorText, canceled }, body: { text, base64Encoded },
//     postData, redirectResponse }
// where sent is the Network.requestWillBeSent params.

const API_TYPES = ['XHR', 'Fetch'];

// Default settings (the options page edits these).
const DEFAULT_SETTINGS = {
  scope: 'api',                 // 'api' = XHR/fetch calls only, 'all' = every request
  include: '',                  // URL patterns, one per line, * = anything; empty = all
  exclude: '',
  skipUi: true,                 // skip the WMS screen framework's own calls (UI_PATTERNS)
  bodies: true,                 // save response bodies
  maxBodyKB: 1024,              // skip bodies bigger than this
  redact: true,                 // mask secrets (headers, cookies, token fields)
  followTabs: true,             // also record tabs opened from the recorded tab
  filename: 'API_{host}_{timestamp}.har',
  outputHar: true,              // save the full HAR
  outputSummary: true,          // save the HTML summary report (summary.js)
  summaryLines: 200,            // longest body shown in the summary, in lines
  trackClicks: true,            // note clicks / Enter / screen changes to group calls into steps
  relevantOnly: true,           // the summary opens showing relevant calls only
  alwaysShow: '',               // URL patterns always treated as relevant (summary)
  alwaysHide: '',               // URL patterns always treated as background (summary)
  scenarioMode: true,          // ask for a scenario (name, tier, area) before recording
  screenshots: true,            // screenshot after each step (scenario mode)
  hideOverlays: true,           // hide other tools' overlays (e.g. Claude in Chrome's glow and cursor) in screenshots
  overlaySelectors: '#claude-agent-glow-border, #claude-phantom-cursor',
  hideBezel: false,             // hide Device Frame's phone bezel and toolbar in screenshots
  videoLink: true,              // scenario mode: Device Frame records its device video along (framed tabs)
  videoIdleSkip: 2,             // ...and skips idle time in it: pause after this many seconds of no activity (0 = off)
  cropToDevice: true,           // in a Device Frame: crop to the phone (or its screen), transparent around it (PNG)
  scenarioFolder: 'scenario_library_inbox', // under Downloads
};

const TIERS = { gold: 'Gold / Base', standard: 'Standard', custom: 'Custom' };

// Manhattan WMS screen-framework calls: menus, translations, provisioning,
// chatbot, screen configuration and metadata. Large and rarely what you're
// investigating; skipped while "Skip WMS screen-framework calls" is on.
const UI_PATTERNS = [
  '*/commonui-facade/menu/*',
  '*/commonui-facade/menuTab/*',
  '*/i18n/translate/*',
  '*/activeProvisioningProfile*',
  '*/chatbot/*',
  '*/dmui-facade/config/*',
  '*.metadata.json*',
  '*/userFilter/search*',
].join('\n');

// ---- relevance (summary report) ----------------------------------------------
// Every call is "data" (what you clicked for: searches, screen data, mobile
// transactions, anything that creates or changes data), "lookup" (supporting
// reference data, e.g. dropdown code lists) or "background" (the app's own
// chatter: feature flags, chat, permissions, preferences, settings, pings,
// icons). Learned from WMS recordings; your own patterns in the options win.

const BACKGROUND_PATTERNS = [
  '*/feature-flags/*', '*/featureFlags*', '*/accessRequest/*',
  '*/messenger/*', '*/chatbot/*', '*/assistant/*', '*/agent/configurations*',
  '*/grant/list/*', '*/grantsForMe*',
  '*/authserver/*', '*/zuulserver/*', '*/readtimeout*',
  '*/getValueForProperty/*', '*/commonConfigParam/*', '*/warehouseConfigParam/*', '*/isBUSetupEnabled*',
  '*/userFontSize/*', '*/userVoicePreference/*', '*/userDefaults/*', '*/userPreferredFilter/*',
  '*/employeeActivityTracking/*', '*/facilityConfigData*',
  '*/listLocationsForUser*', '*/organization/user/search*', '*/organization/location/*',
  '*/initLoginServer*', '*/activitystream*', '*/heartbeat*', '*/keepalive*',
].join('\n');
const LOOKUP_PATTERNS = ['*/reference-data*', '*/entity/lookup*', '*/codes/*'].join('\n');
const DATA_PATTERNS = [
  '*/entity/search*', '*/entity/invoke*', '*/entity/save*', '*/entity/create*', '*/entity/update*',
  '*/hierarchy/*', '*/workflow/init*', '*/workflow/execute/*',
].join('\n');
const STATIC_FILE = /\.(svg|png|jpe?g|gif|ico|webp|woff2?|ttf|css|js)(\?|$)/i;
const PING = /\/ping(\?|$)/i;
// A GET within this long after a click or Enter counts as triggered by it.
const TRIGGER_MS = 5000;

// Steps = your actions in time order. Clicks, Enter, keys (F2, Ctrl+S) and a
// page opening start a step. Field values you typed ("input") belong to the
// next step (the click or key that submits them; the field is left just
// before it); your checkpoints belong to the step they were added in.
// actions: [{ tabId, kind: 'click'|'enter'|'key'|'load'|'input'|'checkpoint', label, value, title, target, t }]
const STEP_KINDS = ['click', 'enter', 'key', 'load'];
function stepsFrom(actions) {
  const steps = [];
  let current = null;
  let typed = []; // values typed since the last step, waiting for the next one
  for (const a of [...(actions || [])].sort((x, y) => x.t - y.t)) {
    if (a.kind === 'input') { typed.push({ label: a.label || '', value: a.value || '', t: a.t }); continue; }
    if (STEP_KINDS.includes(a.kind) || !current) {
      const kind = STEP_KINDS.includes(a.kind) ? a.kind : 'start';
      current = {
        n: steps.length + 1, t: a.t, kind, label: kind === 'start' ? '' : a.label || '', value: kind === 'start' ? '' : a.value || '',
        screen: a.title || '', tabId: a.tabId, ...(a.target ? { target: a.target } : {}), ...(a.field ? { field: a.field } : {}), inputs: [], checkpoints: [],
      };
      // A value already shown as the field beside the clicked button isn't repeated.
      if (kind !== 'start') {
        current.inputs.push(...typed.filter((x) => !(a.field && x.label === a.field.label && x.value === a.field.value)));
        typed = [];
      }
      steps.push(current);
      if (kind !== 'start') continue;
    }
    if (a.kind === 'checkpoint') current.checkpoints.push({ text: a.label || '', t: a.t });
  }
  // Typed at the very end with no step after it: keep it on the last step.
  if (typed.length && current) current.inputs.push(...typed);
  return steps;
}

function classify(entry, step, settings) {
  const url = entry.request.url;
  const path = (() => { try { return new URL(url).pathname; } catch { return url; } })();
  const match = (patterns) => patternList(patterns).some((re) => re.test(url));
  if (match(settings.alwaysShow)) return 'data';
  if (match(settings.alwaysHide)) return 'background';
  if (STATIC_FILE.test(path) || PING.test(path) || match(BACKGROUND_PATTERNS)) return 'background';
  if (match(LOOKUP_PATTERNS)) return 'lookup';
  if (match(DATA_PATTERNS)) return 'data';
  if (entry.request.method !== 'GET') return 'data'; // creates or changes something
  const started = new Date(entry.startedDateTime).getTime();
  return step && started - step.t <= TRIGGER_MS ? 'data' : 'background';
}

// Adds _step (0 = before your first action), _category and keeps _screen.
function annotate(entries, steps, settings) {
  for (const e of entries) {
    const started = new Date(e.startedDateTime).getTime();
    let step = null;
    for (const s of steps) { if (s.t <= started + 50) step = s; else break; }
    e._step = step ? step.n : 0;
    e._category = classify(e, step, settings);
  }
}

const SECRET_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-auth-token', 'x-api-key', 'x-csrf-token', 'x-xsrf-token'];
// Field names whose values are secrets (in JSON bodies and URL parameters),
// e.g. access_token, tokenValue, idToken, password, ClientSecret, sessionId.
const SECRET_FIELD = /^((access|refresh|id|auth)?_?token(_?value)?|pass(word|wd)?|(client_?)?secret|api_?key|session_?id|credentials?)$/i;
// Sign-in tokens (JWTs: three base64url parts, the first starting "eyJ"),
// masked wherever they appear, whatever the field is called.
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const REDACTED = '[REDACTED]';

// "*" wildcard patterns, one per line; case-insensitive, matched anywhere in the URL.
function patternList(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
    .map((p) => new RegExp(p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i'));
}

// Should this request be recorded? type is the debugger's resource type.
function wanted(url, type, settings) {
  if (!/^https?:/i.test(url)) return false;
  if (settings.scope !== 'all' && !API_TYPES.includes(type)) return false;
  if (settings.skipUi && patternList(UI_PATTERNS).some((re) => re.test(url))) return false;
  const include = patternList(settings.include);
  if (include.length && !include.some((re) => re.test(url))) return false;
  return !patternList(settings.exclude).some((re) => re.test(url));
}

const headerList = (headers) => Object.entries(headers || {}).flatMap(([name, value]) =>
  String(value).split('\n').map((v) => ({ name, value: v })));

function queryString(url) {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

const statusLine = (protocol) => (protocol && /^h(2|3)|^http\/2/i.test(protocol) ? 'HTTP/2.0' : 'HTTP/1.1');

// One HAR entry from a record. Times: the debugger gives seconds (monotonic
// timestamp) plus wallTime for the start; HAR wants ISO dates and ms.
function buildEntry(rec) {
  const { sent } = rec;
  const req = sent.request;
  const res = rec.redirectResponse || rec.response;
  const started = new Date((sent.wallTime || Date.now() / 1000) * 1000);
  const end = rec.finishedAt ?? sent.timestamp;
  const total = Math.max(0, (end - sent.timestamp) * 1000);

  const t = res?.timing;
  const span = (a, b) => (t && t[a] >= 0 && t[b] >= 0 ? Math.max(0, t[b] - t[a]) : -1);
  const timings = t ? {
    blocked: t.dnsStart >= 0 ? t.dnsStart : t.connectStart >= 0 ? t.connectStart : Math.max(0, t.sendStart),
    dns: span('dnsStart', 'dnsEnd'),
    connect: span('connectStart', 'connectEnd'),
    ssl: span('sslStart', 'sslEnd'),
    send: Math.max(0, t.sendEnd - t.sendStart),
    wait: Math.max(0, t.receiveHeadersEnd - t.sendEnd),
    receive: Math.max(0, (end - t.requestTime) * 1000 - t.receiveHeadersEnd),
  } : { blocked: 0, dns: -1, connect: -1, ssl: -1, send: 0, wait: total, receive: 0 };

  const requestHeaders = { ...req.headers, ...(rec.extraRequestHeaders || {}) };
  const responseHeaders = { ...(res?.headers || {}), ...(rec.extraResponseHeaders || {}) };
  const postText = rec.postData ?? req.postData;
  const mimeType = res?.mimeType || '';
  const content = { size: rec.body?.size ?? (rec.encodedLength ?? 0), mimeType };
  if (rec.body?.text !== undefined) {
    content.text = rec.body.text;
    if (rec.body.base64Encoded) content.encoding = 'base64';
  }
  if (rec.bodySkipped) content.comment = rec.bodySkipped;

  return {
    pageref: `tab_${rec.tabId}`,
    startedDateTime: started.toISOString(),
    time: total,
    request: {
      method: req.method,
      url: req.url,
      httpVersion: statusLine(res?.protocol),
      cookies: [],
      headers: headerList(requestHeaders),
      queryString: queryString(req.url),
      ...(postText !== undefined ? {
        postData: { mimeType: requestHeaders['Content-Type'] || requestHeaders['content-type'] || '', text: postText },
      } : {}),
      headersSize: -1,
      bodySize: postText !== undefined ? postText.length : 0,
    },
    response: {
      status: res?.status ?? 0,
      statusText: res?.statusText ?? (rec.failed ? rec.failed.errorText : ''),
      httpVersion: statusLine(res?.protocol),
      cookies: [],
      headers: headerList(responseHeaders),
      content,
      redirectURL: rec.redirectResponse ? (responseHeaders.location || responseHeaders.Location || '') : '',
      headersSize: -1,
      bodySize: rec.encodedLength ?? -1,
      ...(rec.failed ? { _error: rec.failed.errorText } : {}),
    },
    cache: {},
    timings,
    serverIPAddress: res?.remoteIPAddress || '',
    _resourceType: (sent.type || '').toLowerCase(),
  };
}

// Mask secret values in a JSON text (keys like access_token, password).
function redactJson(text) {
  text = text.replace(JWT, REDACTED);
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/g, `$1 ${REDACTED}`); // tokens echoed anywhere
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return text.replace(/((?:^|[?&])(?:access_?token|refresh_?token|id_?token|password|client_?secret)=)[^&\s]*/gi, `$1${REDACTED}`);
  }
  let changed = false;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => {
        if (SECRET_FIELD.test(k) && (typeof x === 'string' || typeof x === 'number')) { changed = true; return [k, REDACTED]; }
        return [k, walk(x)];
      }));
    }
    return v;
  };
  const out = walk(data);
  return changed ? JSON.stringify(out) : text;
}

function redactEntry(entry) {
  const maskHeaders = (list) => list.map((h) => (SECRET_HEADERS.includes(h.name.toLowerCase()) ? { ...h, value: REDACTED }
    : { ...h, value: h.value.replace(JWT, REDACTED) }));
  entry.request.headers = maskHeaders(entry.request.headers);
  entry.response.headers = maskHeaders(entry.response.headers);
  entry.request.queryString = entry.request.queryString.map((q) => (SECRET_FIELD.test(q.name) || JWT.test(q.value) ? { ...q, value: REDACTED } : q));
  JWT.lastIndex = 0;
  if (entry.request.queryString.some((q) => q.value === REDACTED)) {
    try {
      const u = new URL(entry.request.url);
      for (const q of entry.request.queryString) if (q.value === REDACTED) u.searchParams.set(q.name, REDACTED);
      entry.request.url = u.toString();
    } catch { /* leave the URL */ }
  }
  if (entry.request.postData?.text) entry.request.postData.text = redactJson(entry.request.postData.text);
  const c = entry.response.content;
  if (c.text && !c.encoding) c.text = redactJson(c.text);
  return entry;
}

// The whole HAR. pages: [{ tabId, title, url, startedAt }]. actions: your
// clicks etc. (see stepsFrom); they become log._steps, and each entry gets
// _step, _category and _screen (the screen's title when the call was made).
function buildHar(records, pages, settings, version, actions = [], scenario = null) {
  const steps = stepsFrom(actions);
  const entries = records.map((r) => ({ ...buildEntry(r), ...(r.screen ? { _screen: r.screen } : {}) }))
    .map((e) => (settings.redact ? redactEntry(e) : e))
    .sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime));
  annotate(entries, steps, settings);
  // A click that set nothing off - no call (of any kind), the next step on
  // the same screen, nothing typed, no checkpoint - e.g. clicking a display
  // line before pasting a value. Kept, but marked so the report can hide it.
  steps.forEach((st, i) => {
    const next = steps[i + 1];
    if (st.kind === 'click' && !st.field && !st.inputs.length && !st.checkpoints.length
      && !entries.some((e) => e._step === st.n) && (!next || next.screen === st.screen)) st.noEffect = true;
  });
  return {
    log: {
      version: '1.2',
      creator: { name: 'API Recorder', version },
      pages: pages.map((p) => ({
        startedDateTime: new Date(p.startedAt).toISOString(),
        id: `tab_${p.tabId}`,
        title: p.title || p.url || `Tab ${p.tabId}`,
        pageTimings: {},
      })),
      entries,
      _steps: steps.map((st) => ({
        ...st,
        time: new Date(st.t).toISOString(),
        value: settings.redact ? redactJson(st.value) : st.value,
        inputs: st.inputs.map((x) => ({ ...x, value: settings.redact ? redactJson(x.value) : x.value })),
        ...(st.field ? { field: { ...st.field, value: settings.redact ? redactJson(st.field.value) : st.field.value } } : {}),
      })),
      ...(scenario ? { _scenario: scenario } : {}),
      ...(settings.redact ? { comment: 'Secrets (auth headers, cookies, token/password fields) are replaced with [REDACTED].' } : {}),
    },
  };
}

// File name from the pattern: {host}, {timestamp} (local YYYYMMDDHHMMSS).
function harFilename(pattern, url, date = new Date()) {
  let host = 'page';
  try { host = new URL(url).hostname.split('.')[0] || host; } catch { /* keep default */ }
  const stamp = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((n) => String(n).padStart(2, '0')).join('');
  const name = String(pattern || DEFAULT_SETTINGS.filename).replace(/\{host\}/g, host).replace(/\{timestamp\}/g, stamp)
    .replace(/[\\/:*?"<>|\s]+/g, '_');
  return name.toLowerCase().endsWith('.har') ? name : `${name}.har`;
}

if (typeof module !== 'undefined') module.exports = { DEFAULT_SETTINGS, TIERS, UI_PATTERNS, stepsFrom, classify, annotate, wanted, buildEntry, buildHar, redactEntry, redactJson, harFilename, patternList };
