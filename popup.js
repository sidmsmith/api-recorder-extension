// API Recorder - the scenario panel (scenario mode). Before recording: name,
// tier, area, customer, notes, then Start. While recording: counts,
// checkpoints, Stop & save. The recording itself runs in background.js.

const $ = (id) => document.getElementById(id);
// Built into Demo Scenario Recorder (the panel is rec/popup.html): its name and icon.
if (location.pathname.includes('/rec/')) {
  const h1 = document.querySelector('h1');
  h1.querySelector('img').src = '../icons/icon32.png';
  h1.lastChild.textContent = chrome.runtime.getManifest().name;
}
const TIER_NAMES = { gold: 'Gold / Base', standard: 'Standard', custom: 'Custom' };
const ask = async (msg) => (await chrome.runtime.sendMessage(msg).catch(() => null)) || {};
// The tab this panel is for: the active tab of its window (a panel opened in a window of
// its own, by the shortcut, has none - the background then knows which tab it was for).
async function panelTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  return tab && /^https?:/i.test(tab.url || '') ? tab.id : undefined;
}
let timer;

async function show() {
  const status = await ask({ type: 'panel-status' });
  $('startForm').hidden = status.recording;
  $('recording').hidden = !status.recording;
  if (status.recording) showRecording(status);
  else await showForm();
}

async function showForm() {
  // Remember the last tier, area and customer: scenarios are usually recorded in batches.
  const { panel = {}, settings = {} } = await chrome.storage.local.get(['panel', 'settings']);
  $('tier').value = panel.tier || 'standard';
  $('area').value = panel.area || '';
  $('customer').value = panel.customer || '';
  $('device').value = panel.device ?? '';
  // The next part of a scenario recorded in parts: the same scenario name, a new part.
  if (panel.part && panel.name) $('name').value = panel.name;
  $('folder').textContent = settings.scenarioFolder || 'scenario_library_inbox';
  $('customerRow').hidden = $('tier').value !== 'custom';
  $('name').focus();
  // A framed tab: say so, and offer to take the frame off (the icon is ours when built in).
  const f = await ask({ type: 'panel-frame', tabId: await panelTab() });
  $('framedRow').hidden = !f.framed;
  $('framedDevice').textContent = f.device ? DEVICE_NAMES[f.device] || f.device : '';
}

const DEVICE_NAMES = { motoG4: 'Phone – Moto G4', desktop720: 'Desktop 1280×720', desktop: 'Desktop – fit the screen' };
$('unframe').addEventListener('click', async () => {
  await ask({ type: 'panel-frame', unframe: true, tabId: await panelTab() });
  window.close();
});

function showRecording(status) {
  const sc = status.scenario;
  $('recName').textContent = sc ? sc.name : 'Quick recording';
  $('recMeta').textContent = sc ? [sc.part && `Part: ${sc.part}`, TIER_NAMES[sc.tier], sc.area, sc.customer].filter(Boolean).join(' · ') : '';
  showVideo(status.video);
  $('steps').textContent = status.steps;
  $('calls').textContent = status.calls;
  $('checks').textContent = status.checkpoints;
  const tick = () => {
    const s = Math.floor((Date.now() - status.startedAt) / 1000);
    $('elapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  clearInterval(timer);
  timer = setInterval(async () => {
    tick();
    const now = await ask({ type: 'panel-status' });
    if (!now.recording) return window.close();
    showVideo(now.video);
    $('steps').textContent = now.steps;
    $('calls').textContent = now.calls;
    $('checks').textContent = now.checkpoints;
  }, 1000);
}

// Device Frame video status (it starts with the recording when the tab is framed).
function showVideo(v) {
  $('recVideo').textContent = !v ? ''
    : v.ok ? '🎥 Device Frame video: recording'
    : v.error === 'not-framed' ? '🎥 No video: this tab is not framed by Device Frame'
    : `🎥 Video didn't start (${v.error}) - press Alt+Shift+V to record it`;
}

$('tier').addEventListener('change', () => { $('customerRow').hidden = $('tier').value !== 'custom'; });

$('startForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const scenario = {
    name: $('name').value.trim(),
    ...($('part').value.trim() ? { part: $('part').value.trim() } : {}),
    ...($('device').value ? { device: $('device').value } : {}),
    tier: $('tier').value,
    area: $('area').value.trim(),
    ...($('tier').value === 'custom' && $('customer').value.trim() ? { customer: $('customer').value.trim() } : {}),
    ...($('notes').value.trim() ? { notes: $('notes').value.trim() } : {}),
  };
  if (!scenario.name) return;
  await chrome.storage.local.set({ panel: { tier: scenario.tier, area: scenario.area, customer: $('customer').value.trim(), name: scenario.name, part: scenario.part || '', device: $('device').value } });
  const res = await ask({ type: 'panel-start', scenario, tabId: await panelTab() });
  if (res?.error) { $('err').textContent = res.error; return; }
  // Recording started; if the device video didn't, say why (and stay open to read it).
  if (res?.video && !res.video.ok && res.video.error !== 'not-framed') {
    $('startForm').hidden = true;
    $('recording').hidden = false;
    showVideo(res.video);
    return;
  }
  window.close();
});

async function addCheckpoint() {
  const text = $('cpText').value.trim();
  if (!text) return;
  const res = await ask({ type: 'panel-checkpoint', text });
  if (res?.error) { $('cpOk').textContent = res.error; return; }
  $('cpText').value = '';
  $('cpOk').textContent = `✔ Added: ${text}`;
  $('checks').textContent = Number($('checks').textContent) + 1;
}
$('cpAdd').addEventListener('click', addCheckpoint);
$('cpText').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCheckpoint(); });

$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  $('stop').textContent = 'Saving…';
  await ask({ type: 'panel-stop' });
  window.close();
});

show();

// Combo boxes (Area, Part): any value can be typed; the ▾ button or a click in the box
// shows the whole list (a <datalist> would only show entries matching what's already in
// the box - with "Putaway" filled in, nothing else). Typing narrows the list.
function combo(input) {
  const options = input.dataset.options.split('|');
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  input.replaceWith(wrap);
  const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'cbtn', textContent: '▾', tabIndex: -1, title: 'Show the list' });
  const list = document.createElement('ul');
  list.hidden = true;
  wrap.append(input, btn, list);
  let active = -1;
  const show = (all) => {
    const q = input.value.trim().toLowerCase();
    const shown = all || !q ? options : options.filter((o) => o.toLowerCase().includes(q));
    list.replaceChildren(...shown.map((o) => {
      const li = document.createElement('li');
      li.textContent = o;
      if (o.toLowerCase() === q) li.className = 'cur';
      li.addEventListener('mousedown', (e) => { e.preventDefault(); input.value = o; hide(); input.dispatchEvent(new Event('change')); });
      return li;
    }));
    active = -1;
    list.hidden = !shown.length;
  };
  const hide = () => { list.hidden = true; active = -1; };
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); if (list.hidden) { input.focus(); show(true); } else hide(); });
  input.addEventListener('click', () => show(true));
  input.addEventListener('input', () => show(false));
  input.addEventListener('blur', hide);
  input.addEventListener('keydown', (e) => {
    const items = [...list.children];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return show(true);
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.classList.toggle('on', i === active));
      items[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !list.hidden && active >= 0) {
      e.preventDefault();
      input.value = items[active].textContent;
      hide();
    } else if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault();
      hide();
    }
  });
}
document.querySelectorAll('input[data-options]').forEach(combo);
