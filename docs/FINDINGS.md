# Reverse-engineering findings and evidence ledger

Target: the installed Electron app in this workspace — `VacuumTube.exe` + `resources/app.asar`.
Method: **REA** (`reverse-engineer-anything`) for the shipped artifact, plus targeted static reading,
a live server probe, and three offline verification harnesses.
Convention: **Observation** = directly returned by a tool/command (path given). **Inference** =
conclusion drawn from observations. **Unknown** = not established.

## 1. Target identity

| Fact | Evidence | Type |
|---|---|---|
| `resources/app.asar` = 4,507,561 bytes | `resources/app-update.yml`, extraction | Observation |
| Package `vacuumtube` **2.0.0**, `main: src/index.js`, MIT | `rea-work/app-extracted/package.json` | Observation |
| Upstream `shy1132/VacuumTube`, electron-updater (GitHub provider) | `resources/app-update.yml`, `src/updater.js` | Observation |
| Electron host: `nodeIntegration:false`, `contextIsolation:false`, `sandbox:false`, `nodeIntegrationInSubFrames:true`, preload = `src/preload/index.js` | `src/index.js:355-362` | Observation |
| The app is a **wrapper of YouTube Leanback** (`https://www.youtube.com/tv`), not a custom client | `src/index.js:45`, `README.md` | Observation |

The Electron/Node boundaries above are exactly what the port had to replace.

## 2. REA run

REA MCP tools were **not connected** in this session, so the skill's documented CLI fallback was used
(`references/connection-and-recovery.md`, "Continue through an installed CLI"):

```
npx -y rea-agents@6.5.0 analyze-javascript-application <workspace>\rea-work\app-js --json
  > rea-work\rea-evidence.json
```

* `rea-work/rea-evidence.json` — **33,868,656 bytes**, operation
  `analyze_javascript_application`, 100 progress phases ending
  `"Application graph and Electron boundaries reconstructed"`, semantic graph
  `jsrg_2d7ddf323d3bceedbfa7d6d5f69131e8c6faf53861e1499f2bd4d2c115510bd0`.
* Coverage declared by REA itself (`limitations`): CommonJS/ESM bindings recovered from **inert
  syntax**; dynamic IPC channel expressions unresolved; Electron relationships are *derived*, never
  proven at runtime; "JavaScript and HTML were parsed as inert text; bundle bootstrap code was never
  executed".
* Consequence for this port: REA establishes the **shape** of the Electron/Node surface (what has to
  be replaced and where), while which main-process facilities actually matter was corroborated by
  reading `src/index.js`, `src/ua.js`, `src/permissions.js`, `src/userstyles.js`, `src/updater.js`
  and by the live probe in §4.

## 3. The Node/Electron surface that had to be re-created

`rea-work/census.md` (all 74 files under `src/preload/`, 70 `.js` + 4 `.css`) records per-file
verdicts. Summary:

* **Reusable as-is, given main-world document-start execution (23 JS + 4 CSS)** — e.g.
  `util/xhrModifiers.js`, `util/jsonModifiers.js`, `util/configOverrides.js`,
  `util/resolveCommandModifiers.js`, `modules/media-capabilities.js`, the settings overlay files.
* **Reusable with a shim (majority)** — every config reader, locale consumer, CSS-from-disk module
  and IPC consumer.
* **Needs native replacement (8 files)** — `preload/index.js` (module loader/asset access),
  `h5vcc/dial/{constants,discover,http,net,server}.js`, and the updater half of
  `settings/pages/about.js`.

Complete API list used by the preload tree (from the census; each one is implemented):

| API | Symbols used | Port |
|---|---|---|
| `electron.ipcRenderer` | `sendSync('get-config'/'set-config'/'can-auto-update')`, `invoke(...)` ×20 channels, `on('config-update'/'focus'/'blur'/'deeplink'/'userstyle-*'/'update-state-changed')` | `VTBridge` + `tools/shims/electron.js` |
| `electron.shell` | `openExternal` | `Intent.ACTION_VIEW` |
| `events` | `EventEmitter` (controller) | `tools/shims/events.js` |
| `fs` | `readdirSync({withFileTypes})`, `readFileSync` (+`.toString('base64')`), `promises.readdir/readFile` | virtual FS over the asset table |
| `path` | `join`, `__dirname` | `tools/shims/path.js` |
| `os` | `hostname`, `platform`, `release`, `networkInterfaces` | bridge device info; DIAL native |
| `crypto` | `randomUUID` | `UUID.randomUUID()` |
| `dgram`, `http`, `Buffer` | SSDP + HTTP server + body concat | `VtDial.java` |
| `process` | `platform`, `arch` | injected per-module parameters (`android` / device ABI) |

## 4. Observations from the live endpoint (the UA gate, and why CSP had to be rewritten)

Probes: `rea-work/probe-ua.mjs` → `rea-work/served-{cobalt,chrome}-ua.html`,
`rea-work/csp-headers-{cobalt,chrome}-ua.{json,txt}`.

| Observation | cobalt UA | chrome UA |
|---|---|---|
| HTTP status / bytes of `https://www.youtube.com/tv` | 200 / **194,874 B** | 200 / **5,709 B** |
| Leanback markers in the response | `TVHTML5`×28, `mdx`×45, `ytlr`×30, `cobalt`×22, `leanback`×18 | none |
| `Content-Security-Policy` headers | **2** (14 KB total) | 3 |
| `require-trusted-types-for 'script'` | present, as its **own** header | present |

* **Observation:** impersonating the Cobalt UA is what earns the TV surface; a Chrome UA gets a
  different, much smaller page. **Inference:** UA spoofing alone is the gate, matching the upstream
  README ("you *can* just use it in your browser by spoofing your user agent").
* **Observation:** policy #1 contains `connect-src ... 'cobalt-insecure-private-range' ...` and none
  of `sponsor.ajay.app`, `returnyoutubedislikeapi.com`, `dearrow-thumb.ajay.app`, while
  `src/index.js:186-224` adds exactly those. **Inference:** the CSP rewrite is required for
  SponsorBlock/DeArrow/RYD/userstyles — it is not cosmetic.
* **Observation:** the served document has 14 `<script>` tags, **all** carrying a `nonce` (2 distinct
  values). **Inference:** an injected inline bootstrap needs a nonce of its own in `script-src`.
* **Observation:** duplicate `Content-Security-Policy` headers exist (Node's `http` joins them with
  `", "`; `rawHeaders` shows them separately). **Inference:** merging them by comma would silently
  drop directives, so `VtCsp` unions the policies instead.

## 5. Verification performed (all offline, all reproducible)

| Harness | Command | Result |
|---|---|---|
| Ported page code | `node tools/smoke-test.mjs` (jsdom page at `https://www.youtube.com/tv` + a bridge stub implementing `VTBridge`'s contract) | **45/45 checks pass** |
| CSP + injection | `java -cp build/verify-csp CspCheck rea-work/csp-headers-cobalt-ua.txt rea-work/served-cobalt-ua.html` | **14/14 checks pass** |
| APK artifact | `powershell -File tools/verify-apk.ps1` | **20/20 checks pass** |
| **Runtime rehearsal** | `node tools/verify-runtime.mjs` — real Chromium, the production bundle, injected the way `VTWebViewClient` does (document fetched, CSP removed, bundle as first `<script>` in `<head>`), with a `VTBridge` stub | **17/17 checks pass** |

What the smoke test actually established (not "it parses", but behaviour):

* all **72** modules load (no module reported a load failure);
* `JSON.parse` and `XMLHttpRequest` are replaced in the page world → `adblock` **really empties**
  `adPlacements`/`adSlots` in a parsed payload (the module's own code path, `adblock.js:49-61`);
* `window.h5vcc` exists with `dial`/`runtime`/`system`, and `getVideoContainerSizeOverride()`
  returns a `WxH` string;
* the settings overlay is **rendered from the bundled locale** (5 tabs) and its stylesheet is
  injected by reading `style.css` through the virtual filesystem;
* clicking a toggle row inside that overlay travels
  `input.js → render.js → configManager.set → ipcRenderer.sendSync('set-config')` and the config
  value changes — i.e. the synchronous bridge works end to end;
* a plain `ArrowUp` keydown becomes a synthetic Starboard `32785` keydown/keyup (the mechanism
  `modules/touch-support.js` uses), and `__vtEnter` emits Starboard select `32768`;
* `window.__vtDialDispatch(...)` answers (404 with no app routes registered) — the native DIAL
  transport has a live counterpart in the page;
* the Android keyboard bridge: `__vtOpenIme()` focuses the page's field and asks for the WebView IME,
  `__vtInjectText` writes into that field (with `input`/`change` events), `__vtBackspace` deletes,
  and with nothing editable present the same text is turned into clicks on Leanback's letter grid,
  while `__vtOpenIme()` falls back to the native sink;
* the full-bleed stylesheet is injected and carries the stage **and** background selectors.

On-device feedback that changed the port (all requested by the user after installing the APKs):

| Observation on device | Cause found | Fix |
|---|---|---|
| "the Android keyboard does not open" | Leanback's search screen only draws its own letter grid; nothing editable is focused, so Chromium never attaches the IME. A **hidden** input also hijacked the field path, and `InputMethodManager.isActive(view)` reported success while nothing was on screen | Two-path keyboard bridge: field path only for a **visible** editable; otherwise a native `EditText` sink whose edits are forwarded into the page. The fallback is now driven by real IME visibility (`WindowInsets.Type.ime()`) instead of `isActive()` |
| "grey borders on the sides" (first APK) | `AspectFrameLayout` letterboxed the WebView to 16:9 over a `#282828` root | Edge-to-edge WebView, black background |
| "the grey border is gone but now there is a black one" (second APK) | The border is **YouTube's own 16:9 rem stage**, not the WebView (measured: `#container`/`#app-background` are `80rem × 45rem` with `html{font-size: height/45}` → 1280×720 centred at `x=140` in a 1560-wide viewport). The upstream *Ultrawide Support* CSS widens the content containers but **not `#app-background`**, so a border remained | `#vt-android-fullbleed`: the port injects its own `!important` stylesheet anchoring both stage layers and the content containers to `100vw` (config key `android_full_bleed`). Verified with the production bundle in real Chromium: `#container`/`#app-background` become `[0,0,1560,720]` |
| "the app doesn't obey Android gestures — swiping to leave the video does nothing" | Gesture navigation and the three-button bar deliver BACK through `onBackPressed()`, never as a `KeyEvent`; only `onKeyDown` was handled | `onBackPressed()` now routes to the BACK handler (plus an `OnBackInvokedCallback` on API 33+), which forwards Starboard BACK `32769` to the page — the signal a real remote sends — and exits on a second press within 2.5 s |
| (found while fixing the above) remote input could not drive VacuumTube's own settings overlay | Synthetic Starboard events only carried `keyCode`; `modules/settings/input.js` navigates by `event.key` (`ArrowUp`/`Enter`/`Escape`) | Synthesised events now also set `key`/`code` through a Starboard→key-name map |
| "**Open VacuumTube Settings** does nothing" | That row is injected by `leanback-settings.js:127-136` into YouTube's own settings screen and calls `window.vtOpenSettingsOverlay()`. The shipped source marks the path *"unused since settings are now in custom menu"*: it depends on YouTube's command bus reaching a `navigationEndpoint` modifier **and** on the overlay module having finished loading (otherwise the call is silently dropped) | Three layers: the globals are proxied so a request made too early is queued until the real implementation appears (captured exactly once, so a wrapper of the proxy can never recurse); the row is detected from the DOM on click/tap and from the focused element on select, matched by its own localised `button_label`; the original command-bus path is untouched |
| (found by the probe while testing the row) tapping a button could act twice | Android fires compatibility mouse events right after `touchend`; the gear had `touchend` **and** `mouseup` handlers, so a toggle could open and immediately close | A 350 ms activation guard on every corner button (verified with a synchronous touch+mouse sequence in real Chromium) |
| "if you can't remove the border in the menu, at least remove it in the video" | The player letterboxes 16:9 video itself | `android_video_fill` (default on): player containers pinned to `100vw × 100vh` and landscape `<video>` given `object-fit: cover` (crop, not stretch). Portrait/Shorts sources are left contained on purpose |
| "the VacuumTube settings still don't open, I tap them and nothing happens" (third report) | **Not reproducible offline**: in real Chromium the gear opens on a real touch tap, a duplicate mouse click is absorbed, and an injected "Open VacuumTube Settings" row opens it too. The likely device-side cause is the ported overlay module failing during its **async** init, which the shipped loader cannot catch (`preload/index.js:25-31` only wraps the synchronous call) — a failure there is completely silent on a phone | Instead of guessing again, three things: (1) **error visibility** — `error` and `unhandledrejection` are captured, logged through the bridge (logcat) and reported in the diagnostics (`errors=…`), plus a toast 12 s after load if the overlay never becomes ready; (2) a **fallback settings panel** (plain DOM + the same config bridge) opens when the ported overlay is unavailable, so options stay reachable (`overlay=fallback`); (3) a **native "VT" button** in the Activity — an ordinary Android view outside the WebView, immune to anything the page does — tap opens settings, long-press shows the diagnostics |
| "some VacuumTube settings options don't work (e.g. hide shorts)" | **Two** causes. (1) A port bug: `tools/shims/electron.js` kept `ipcRenderer.on()` listeners in a private map while the native side emits through the runtime bus (`__vtEmit` → `__VT__.emit`), so **no native → page event ever reached a ported module** — `config-update`, `focus`, `blur`, `deeplink` were all silently lost. (2) In the shipped code those options are XHR/JSON **response** modifiers (`hide-shorts.js:8-25` filters `/youtubei/v1/browse` responses), so they only affect what is fetched next; the already rendered feed cannot change | (1) Listeners now live on `__VT__`'s bus (verified by counting delivered events: `updates=4 → 5`). (2) After a key in `RELOAD_KEYS` changes, the port reloads the page once (1.5 s later, toast naming the keys, `android_reload_on_feed_change` to disable) |
| "the right border of the video is gone but the left one remains, it is off-centre" | The app gives the `<video>` the whole player box and letterboxes the picture inside it with `object-fit: contain` (measured: element 1560×720, `contain`). Any offset or transform on an ancestor therefore shifts the cropped picture to one side | `video.vt-android-video-fill` is now pinned to the viewport (`position: fixed`, `inset 0`, `100vw × 100vh`, `object-position: center center`), and `__vtApplyVideoFill()` neutralises only ancestors that are measurably off-centre / narrow / transformed |

Runtime evidence gathered for the layout work (kept in `build/tv-probe/`): stock 20:9, stock 16:9,
stock 1080p, and the repair candidates, plus `bundle-fullbleed-20x9.png` — the production bundle
running full-bleed in a real browser.

Defect found and fixed **because of** verification: `aapt2 link -A assets` stored the nested asset as
`assets/vt\preload.bundle.js` (Windows separator), which `AssetManager.open("vt/…")` cannot resolve —
the injected bundle would have been empty on device. Assets are now packaged explicitly with forward
slashes, and `verify-apk.ps1` asserts the entry name, its sha256 against the generated bundle, and
that no entry contains a backslash.

## 6. Deliverables and hashes

| Artifact | Detail |
|---|---|
| `dist/VacuumTube-Android.apk` | **254,912 bytes**, sha256 `817a121b82c1eac7834675b3cbbf70c4d8ab4d05c56565e727532d2b17464789`, signed (v2+v3, debug key `CN=Android Debug`), `rocks.shy.vacuumtube.android`, versionName `2.0.0-android`, minSdk 24, targetSdk 35 |
| `app/src/main/assets/vt/preload.bundle.js` | 395,237 bytes, 72 modules, 6 shims, 16 assets; sha256 recorded in `build/bundle-manifest.json` (the generation timestamp is embedded, so bundle/APK bytes are not reproducible across runs — the manifest records the identity of each build) |
| `vendor/vacuumtube-preload/` | the extracted upstream preload tree + `.readdir-order.json` (true `app.asar` directory order, so `readdirSync` emulation matches the original) |
| `rea-work/TOOLCHAIN.md` | SDK build-tools 35.0.0 + platform-35 provenance (SHA-1 verified against Google's manifest), and the javac/d8 findings |
| `rea-work/census.md`, `rea-work/rea-evidence.json` (33.8 MB), `rea-work/served-cobalt-ua.html`, `rea-work/csp-headers-cobalt-ua.txt` | the reverse-engineering evidence this port is built from |

## 7. Unknowns (explicitly not established)

1. **Runtime behaviour on real hardware** — no device, emulator or `adb` exists in this environment.
   Everything above is static analysis, jsdom execution of the ported page code, and live-server
   evidence. First-run UX, playback, remote input and casting must be confirmed on a device.
2. **`sec-ch-ua*` on sub-resources** — the document request carries Cobalt hints (we issue it), but
   page XHRs carry the WebView's Chromium hints; whether YouTube's player selection notices this was
   not observed.
3. **DIAL end-to-end** — SSDP/HTTP are implemented, but discovery by a second device was not tested.
4. **DRM/Widevine content** — not testable here; expected to be unavailable through WebView.
5. **Gamepad and voice search** — code paths ported unchanged, unexercised.
6. **`modules/media-capabilities.js` device envelope** — it advertises a TV/Cobalt capability profile
   (8K/60fps/200 Mbps) regardless of the actual device; on weak hardware the user may need
   *Filter Video Codecs*.
7. **On-device IME behaviour** — the keyboard paths are verified offline only; whether a given
   device attaches the IME to the WebView (field path) or needs the native sink is not known here,
   and the sink's letter-grid fallback cannot type characters the TV keyboard does not have.
8. **Video aspect** — landscape videos are cropped to fill (`object-fit: cover`), so the top/bottom
   of the picture is cut like a TV "zoom" mode. The probe reached the real player DOM but signed out
   it never loads media (`videoWidth` 0), so the fill was verified structurally (element styles,
   ancestor neutralisation against a modelled layout) and not against a playing stream.
9. **Signed-in surfaces** — the probes only reached the signed-out welcome screen, so the search
   screen's exact DOM (letter grid vs. hidden input) and YouTube's own settings screen were never
   observed directly. The keyboard design covers both possibilities, and the settings row was
   verified in real Chromium with an injected row carrying the real localised label, not on a
   signed-in device.
