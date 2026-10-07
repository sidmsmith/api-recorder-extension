# API Recorder

A Chrome extension that records a tab's API calls, like DevTools' Network
panel, without opening DevTools: one click to start, one click to stop and
download a **HAR** file.

## Use

1. Open the page to test (e.g. the WMS) and click the **API Recorder** icon.
   Recording starts with an empty log; the icon shows a red badge with the
   number of calls captured. Chrome shows a bar saying API Recorder "started
   debugging this browser" while recording – that's expected.
2. Run your test. Page loads, logins and redirects are kept in the same log.
   Tabs the page opens (e.g. **WM Mobile**) are recorded too.
3. Click the icon again (or **Cancel** on Chrome's debugging bar). The HAR
   file is saved to **Downloads**, e.g. `API_salep_20261007141530.har`, and the
   badge turns green with the number of calls saved.

Open the HAR in DevTools (Network panel → drag the file in, or the import
button), or in any HAR viewer.

## Options

Right-click the icon → **Options**:

- **What to record** – API calls only (XHR/fetch, default) or everything;
  URL patterns to include or skip (one per line, `*` = anything).
- **Follow new tabs** – also record tabs opened from the recorded tab (on).
- **Bodies** – save response bodies (on), skipping bodies over a size (1 MB).
  Request bodies (payloads) are always saved.
- **Redact secrets** – on by default; see Privacy.
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
