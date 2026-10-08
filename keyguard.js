// API Recorder - key guard (content script, document_start, all pages).
//
// Chrome runs the extension's keyboard shortcut (Alt+Shift+B by default) but
// still delivers the key press to the page, so WM Mobile (which routes key
// presses into its scan/search field) would get a "B". Loading at
// document_start registers this listener before the app's own, so it can stop
// exactly that combination first. The shortcut comes from the background
// (whatever is set on chrome://extensions/shortcuts).

(() => {
  let combos = [];
  const swallowed = new Set(); // keys whose keydown was blocked; block their keyup too

  const parse = (text) => {
    const parts = text.split('+');
    const key = parts.pop();
    return {
      alt: parts.includes('Alt'), shift: parts.includes('Shift'), ctrl: parts.includes('Ctrl'),
      // e.code is layout-independent (Alt+Shift can switch keyboard layouts on Windows).
      code: /^[A-Z]$/.test(key) ? `Key${key}` : /^[0-9]$/.test(key) ? `Digit${key}` : key,
    };
  };

  const block = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onKey = (e) => {
    if (!combos.length) return;
    if (e.type === 'keyup' && swallowed.has(e.code)) {
      swallowed.delete(e.code);
      return block(e);
    }
    const hit = combos.some((k) => k.code === e.code && k.alt === e.altKey && k.shift === e.shiftKey && k.ctrl === e.ctrlKey);
    if (!hit) return;
    if (e.type === 'keydown') swallowed.add(e.code);
    block(e);
  };
  for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, onKey, true);

  chrome.runtime.sendMessage({ type: 'keyguard-get' })
    .then((res) => { combos = (res?.shortcuts ?? []).filter(Boolean).map(parse); })
    .catch(() => { /* extension reloaded: the page's next load picks it up */ });
})();
