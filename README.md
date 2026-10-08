# API Recorder

A Chrome extension that records a tab's API calls, like DevTools' Network
panel, without opening DevTools: one click to start, one click to stop and
download a **HAR** file.

## Use

**Shortcut: Alt+Shift+B** starts and stops a recording without the icon
(handy when the window is too narrow to show it). While recording it stops and
saves; in scenario mode it opens the scenario panel to start (name, tier,
area). Change it on `chrome://extensions/shortcuts`. The key press is kept
away from the page (keyguard.js), so WM Mobile doesn't type a "B".

1. Open the page to test (e.g. the WMS) and click the **API Recorder** icon.
   Recording starts with an empty log; the icon shows a red badge with the
   number of calls captured. Chrome shows a bar saying API Recorder "started
   debugging this browser" while recording – that's expected.
2. Run your test. Page loads, logins and redirects are kept in the same log.
   Tabs the page opens (e.g. **WM Mobile**) are recorded too.
3. Click the icon again (or **Cancel** on Chrome's debugging bar). Two files
   are saved to **Downloads**, and the badge turns green with the number of
   calls saved:
   - `API_salep_20261007141530.har` – the full details. Open it in DevTools
     (Network panel → drag the file in) or any HAR viewer, or send it for
     analysis.
   - `API_salep_20261007141530.html` – the **summary report** (see below).

## Scenario mode (building a test library)

Turn on **Record scenarios** in the options. The icon then opens a small
panel instead of starting at once:

1. Enter the **scenario name**, **tier** (Gold / Base, Standard, Custom),
   **area** (Receiving, Putaway…), the **customer** for Custom scenarios, and
   optional notes. Tier, area and customer are remembered for the next one.
2. **Start recording** and run the scenario.
3. While recording, the panel shows the steps, calls and checkpoints so far.
   Use **Checkpoint** to note what should be true at that point ("ASN
   created, status Received"); checkpoints become the checks of an automated
   replay.
4. **Stop & save.** Everything goes into one folder:
   `Downloads\scenario_library_inbox\<tier>-<name>_<timestamp>\` with
   `recording.har`, `recording.html` (titled with the scenario) and a
   screenshot after each step (`step-01-2-after.jpg`, … – option, on), plus a
   "before" picture with your value in the field when you typed or pasted
   something for that step (`step-04-1-before.jpg`). The names keep the
   pictures in order in any file list or image viewer. Other tools' overlays
   (by default Claude in Chrome's glowing border and cursor) are hidden for
   the moment each picture is taken (option, on; the elements are listed in
   Options), and so is Device Frame's phone bezel (separate option, on).
   In a Device Frame (0.23.1+), pictures are cropped to the phone – or just
   its screen when the bezel is hidden – with transparent rounded corners,
   saved as .png (option, on).

What a recording notes about you: clicks (the button or menu text, plus
what was clicked – element, id, classes – for a later replay), Enter in a
field and its value, function keys and shortcuts (F2, Ctrl+S), values typed
into fields (attached to the click or key that submits them), and screen
changes. Password-like fields are never read.

## The summary report

- **Steps:** your clicks while recording ("Clicked “Blind Receipt”",
  "Pressed Enter in “ASN” (0000123)", "Opened “WM Mobile”"), each with the
  calls it triggered and the screen you were on.
- **Relevant calls only** (on when it opens): the data you clicked for –
  searches, screen data, mobile transactions, anything that creates or
  changes data. Supporting lookups (dropdown lists) are folded under each
  step ("+ 5 supporting lookups"); the app's background calls (feature flags,
  chat, permissions, preferences, settings, pings, icons) are hidden. Untick
  it to see every call, background ones greyed out. "Showing 4 of 61 calls"
  says how much is hidden.
- Every call is a row (number, time, method, status, screen, endpoint,
  duration); click it for the payload and response side by side, with Copy
  buttons. Search, Errors only, Expand all.
- The HAR keeps everything, plus the steps (`log._steps`) and each call's
  `_step`, `_category` (data / lookup / background) and `_screen`.

Not quite right for a screen? Add URL patterns under **Always relevant** or
**Always background** in the options.

## Options

Right-click the icon → **Options**:

- **What to record** – API calls only (XHR/fetch, default) or everything;
  URL patterns to include or skip (one per line, `*` = anything).
- **Skip WMS screen-framework calls** – on by default: leaves out the WMS
  screens' own plumbing (menus, translations, provisioning profile, chatbot,
  screen configuration and metadata), which is large and rarely what you're
  investigating. Untick to record everything.
- **Follow new tabs** – also record tabs opened from the recorded tab (on).
- **Bodies** – save response bodies (on), skipping bodies over a size (1 MB).
  Request bodies (payloads) are always saved.
- **Redact secrets** – on by default; see Privacy.
- **Scenario mode** – record scenarios (off), screenshot after each step
  (on), the Downloads folder for scenarios.
- **Summary report** – group calls by your clicks (on); open showing relevant
  calls only (on); your own Always relevant / Always background patterns.
- **Files** – full details (HAR) and/or the summary report (HTML), both on;
  how many lines of each payload/response the summary shows (200).
- **File name** – `{host}` and `{timestamp}` (YYYYMMDDHHMMSS) placeholders.

## Privacy

HAR files can contain sign-in tokens and cookies. With **Redact secrets** on
(the default), these are replaced with `[REDACTED]`:

- the `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`,
  `X-Auth-Token`, `X-API-Key` and CSRF token headers;
- fields named like `access_token`, `refresh_token`, `id_token`, `token`,
  `password`, `client_secret`, `secret` or `api_key` in JSON bodies and URLs;
- `Bearer …` / `Basic …` values anywhere in bodies.

Turn it off only when you need the real values, and don't share those files.

## Good to know

- One recording at a time; clicking the icon on any tab stops it.
- Pages that aren't `http`/`https` (e.g. `chrome://`) can't be recorded.
- A tab opened by the recorded page is attached within about a tenth of a
  second; a call it makes in that first instant can be missed (apps like WM
  Mobile load for seconds before calling their APIs, so this rarely matters).
- Closing the recorded tab stops the recording and saves what was captured.

## Install (unpacked)

1. Unzip into a folder outside OneDrive.
2. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** →
   select the folder (the one with `manifest.json` in it).
3. Pin the icon from the puzzle-piece menu.

The extension asks for the **debugger** permission (to read network traffic,
like DevTools), **tabs** and **webNavigation** (to name the file and follow
new tabs), **downloads** and **storage**.
