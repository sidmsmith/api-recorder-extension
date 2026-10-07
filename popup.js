// API Recorder - the scenario panel (scenario mode). Before recording: name,
// tier, area, customer, notes, then Start. While recording: counts,
// checkpoints, Stop & save. The recording itself runs in background.js.

const $ = (id) => document.getElementById(id);
const TIER_NAMES = { gold: 'Gold / Base', standard: 'Standard', custom: 'Custom' };
const ask = async (msg) => (await chrome.runtime.sendMessage(msg).catch(() => null)) || {};
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
  $('folder').textContent = settings.scenarioFolder || 'scenario_library_inbox';
  $('customerRow').hidden = $('tier').value !== 'custom';
  $('name').focus();
}

function showRecording(status) {
  const sc = status.scenario;
  $('recName').textContent = sc ? sc.name : 'Quick recording';
  $('recMeta').textContent = sc ? [TIER_NAMES[sc.tier], sc.area, sc.customer].filter(Boolean).join(' · ') : '';
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
    $('steps').textContent = now.steps;
    $('calls').textContent = now.calls;
    $('checks').textContent = now.checkpoints;
  }, 1000);
}

$('tier').addEventListener('change', () => { $('customerRow').hidden = $('tier').value !== 'custom'; });

$('startForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const scenario = {
    name: $('name').value.trim(),
    tier: $('tier').value,
    area: $('area').value.trim(),
    ...($('tier').value === 'custom' && $('customer').value.trim() ? { customer: $('customer').value.trim() } : {}),
    ...($('notes').value.trim() ? { notes: $('notes').value.trim() } : {}),
  };
  if (!scenario.name) return;
  await chrome.storage.local.set({ panel: { tier: scenario.tier, area: scenario.area, customer: $('customer').value.trim() } });
  const res = await ask({ type: 'panel-start', scenario });
  if (res?.error) { $('err').textContent = res.error; return; }
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
