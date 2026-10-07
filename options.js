// API Recorder - options page. Every change is saved straight away.

const $ = (id) => document.getElementById(id);
let settings;
let savedTimer;

async function load() {
  const { settings: stored } = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  document.querySelector(`input[name=scope][value=${settings.scope}]`).checked = true;
  for (const id of ['include', 'exclude', 'filename']) $(id).value = settings[id];
  for (const id of ['skipUi', 'followTabs', 'bodies', 'redact', 'outputHar', 'outputSummary']) $(id).checked = settings[id];
  $('summaryLines').value = settings.summaryLines;
  $('uiPatterns').textContent = UI_PATTERNS.split('\n').join('  ');
  $('maxBodyKB').value = settings.maxBodyKB;
  showExample();
}

function showExample() {
  $('example').textContent = harFilename($('filename').value, 'https://salep.sce.manh.com/');
  $('noOutput').hidden = $('outputHar').checked || $('outputSummary').checked;
}

async function save() {
  settings = {
    scope: document.querySelector('input[name=scope]:checked')?.value === 'all' ? 'all' : 'api',
    include: $('include').value,
    exclude: $('exclude').value,
    skipUi: $('skipUi').checked,
    followTabs: $('followTabs').checked,
    bodies: $('bodies').checked,
    maxBodyKB: Math.min(102400, Math.max(1, Number($('maxBodyKB').value) || DEFAULT_SETTINGS.maxBodyKB)),
    redact: $('redact').checked,
    filename: $('filename').value.trim() || DEFAULT_SETTINGS.filename,
    outputHar: $('outputHar').checked,
    outputSummary: $('outputSummary').checked,
    summaryLines: Math.min(100000, Math.max(10, Number($('summaryLines').value) || DEFAULT_SETTINGS.summaryLines)),
  };
  await chrome.storage.local.set({ settings });
  showExample();
  $('saved').classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $('saved').classList.remove('show'), 1500);
}

document.addEventListener('change', save);
$('filename').addEventListener('input', showExample);
load();
