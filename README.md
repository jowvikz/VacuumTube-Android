# VacuumTube for Android

An Android port of **[VacuumTube 2.0.0](https://github.com/shy1132/VacuumTube)** (an Electron wrapper of
YouTube Leanback, `https://www.youtube.com/tv`), produced by reverse engineering the shipped
`resources/app.asar` with **REA** and re-hosting the decompiled page-side code inside an Android
`WebView` instead of rewriting the features by hand.

* **APK:** [`dist/VacuumTube-Android.apk`](dist/VacuumTube-Android.apk) — 238.528 bytes, signed (APK Signature v2+v3, debug key)
* **App id:** `rocks.shy.vacuumtube.android` · versionName `2.0.0-android` · minSdk 24 · targetSdk 35
* **No dependencies:** platform `WebView`, `org.json` and `java.net` only — no AndroidX, no Gradle needed to build

---

## 1. What it does

The same thing the desktop app does, on Android:

| VacuumTube feature (from the shipped app) | Ported how |
|---|---|
| Serves the YouTube **Leanback (TV)** surface by impersonating a Cobalt 27 TV device (`src/ua.js`) | WebView UA + `sec-ch-ua*` on the document request, plus a page-world `navigator.userAgentData` override |
| 70 preload modules that patch Leanback (`adblock`, `sponsorblock`, `dearrow`, `dislikes`, `h264ify`, `media-capabilities`, `hide-shorts`, `guide-tabs`, `music-mode`, `remaining-time`, `ultrawide`, `touch-support`, `speed/volume-control`, settings overlay, …) | Embedded **verbatim** in one page-world bundle injected as the *first* script in `<head>` (document-start) |
| CSP rewriting so userstyles/SponsorBlock/DeArrow/RYD work, and Trusted Types removal (`src/index.js:165-233`) | Native rewrite of the response CSP by `VtCsp` (merging the 2 real policies) |
| `window.h5vcc` (`dial`, `runtime`, `system.getVideoContainerSizeOverride`) that Leanback expects (`h5vcc/index.js`) | Same JS modules; deeplinks and screen size supplied by the native bridge |
| DIAL / SSDP so the phone YouTube app can cast to it (`h5vcc/dial/**`, Node `dgram`+`http`) | Native `VtDial` (MulticastSocket + ServerSocket); Leanback's own DIAL handlers stay in JS and are called back through `__vtDialDispatch` |
| `ipcRenderer` config store, focus/blur, reload, exit, clipboard, microphone, userstyles, about page | `VTBridge` (`@JavascriptInterface`), channel-for-channel identical |
| Starboard controller input (`touch-support.js`, `util/controller.js`: keycodes 32768/32769/32785-32788) | Android D-pad/Enter/Back translated to the same Starboard keycodes; the original touch overlay still runs for phones |
| — (Cobalt devices have a system IME; VacuumTube's search only draws its own letter grid) | **Android soft keyboard**: field path (WebView IME) with an automatic native fallback so typing works on the search screen |
| 16:9 window lock, `#282828` background, fullscreen (`src/index.js:350,366-407`) | Edge-to-edge WebView + a **full-bleed CSS injection**: the TV surface is a fixed 16:9 rem stage (see below), which the port anchors to the viewport width |
| Deep links (`vacuumtube --deeplink`, `youtu.be` normalisation) | `intent-filter`s for youtube.com/watch, youtu.be, `/tv` and `vacuumtube://` |

**Settings** have four entry points, so one of them always works:

| Entry point | Where | Notes |
|---|---|---|
| **VT button** | native Android view, top-left corner | Outside the page, so nothing in the WebView can block it. Tap = open settings, long-press = diagnostics toast |
| **Gear** | in-page, top-right corner | Same as the desktop `Ctrl+O` |
| **MENU key** | remote | Calls the same toggle |
| **"Open VacuumTube Settings"** | inside YouTube's own settings screen | The row the shipped app injects; dead code upstream, wired here (see below) |

Below the gear there is an **ABC** button that opens the Android keyboard. Long-pressing the gear
toggles the Starboard key translation (escape hatch if a future Leanback build handles plain keys
itself).

If the ported settings overlay never finishes initialising — its async body cannot be caught by the
module loader, so a failure there is silent — the port says so (toast after 12 s), logs the reason,
and opens its own **fallback settings panel** (plain DOM, same config bridge, no dependency on the
module that failed) instead of doing nothing. The diagnostics then report `overlay=fallback`.

**Diagnostics:** long-press the ABC button (or the native VT button) toasts
`v=… stage=<width>/<viewport> bleed=on video=on vid=<w>x<h>@<left>,<width> overlay=ready|fallback
updates=<n> errors=<last page error>`. That single line is what makes a device problem reportable.

The row inside YouTube's settings is dead code in the shipped app (its own comment says *"unused
since settings are now in custom menu"*): it relies on YouTube's command bus reaching a
`navigationEndpoint` modifier, and on `window.vtOpenSettingsOverlay` already existing. The port makes
it work regardless — it proxies those globals (queuing a request made before the overlay module is
ready, capturing the real implementation exactly once) and detects the row from the DOM (click/tap on
the button) and from the focused element on select, matching its own localised label.

### Display: why the sides used to be empty

Measured in a real browser against the live page: YouTube's TV surface is a **fixed 16:9 rem stage** —
`#container`/`#app-background` are `80rem × 45rem` with `html { font-size: height / 45 }`. On a
1560×720 viewport (a 20:9 phone in landscape) that renders a 1280×720 stage centred at `x=140`,
leaving 140 px of background on each side. It only ever fills a 16:9 screen.

The shipped *Ultrawide Support* feature widens the content containers but **not `#app-background`**,
so a border survives. The port injects its own `#vt-android-fullbleed` stylesheet (`!important`) that
anchors both stage layers *and* the content containers to the viewport:

```css
div#container, div#app-background, ytlr-app-background-container, yt-route {
    width: 100vw !important; min-width: 100vw !important; max-width: 100vw !important;
    left: 0 !important; right: auto !important; margin-left: 0 !important; margin-right: 0 !important;
}
```

Verified with the production bundle injected into a real Chromium: `#container` and `#app-background`
end up `[0, 0, 1560, 720]` — no borders, no distortion, no cropping (`tools/verify-runtime.mjs`).
Set `android_full_bleed` to `false` in the config to go back to the raw 16:9 stage.

### Video fill

The application UI fills the screen, but a 16:9 video inside a wider player is still letterboxed —
measured on the live page, the app sizes the `<video>` element to the **whole player box**
(1560×720 in the probe) and letterboxes the picture *inside it* with `object-fit: contain`. That is
also why a leftover offset on any ancestor shows up as a border on one side only.

With `android_video_fill` (default on) the video is pinned to the viewport itself
(`position: fixed; inset 0; 100vw × 100vh; object-fit: cover; object-position: center center`), and
the runtime pass additionally neutralises only those ancestors of the video that are measurably
off-centre, too narrow or transformed. `cover` keeps the aspect ratio, so the picture is cropped, not
stretched. Portrait sources (Shorts) are deliberately left contained — blowing a 9:16 video up to
fill a 16:9 player would show a narrow strip. Set `android_video_fill` to `false` to restore plain
letterboxing.

### Settings that only apply to future data

Several options are XHR/JSON **response** modifiers in the shipped code (`hide-shorts.js`,
`adblock.js`, `dearrow.js`, `return-youtube-dislike.js`, `guide-tabs.js`, …): they filter what
arrives *next*, so flipping the switch changes nothing on the already rendered feed — which looks
like "the option does nothing". After such a key changes, the port reloads the page once (1.5 s
later, with a toast naming the keys) so the switch is visibly effective.
`android_reload_on_feed_change` turns that off.

### Back gesture

Gesture navigation (and the three-button bar) delivers BACK through `onBackPressed()`, never as a
`KeyEvent`, which is why the swipe-to-go-back gesture did nothing before. The activity now handles
`onBackPressed()`, registers an `OnBackInvokedCallback` on API 33+, and forwards BACK to the page as
the Starboard BACK code (`32769`) — the same signal a real TV remote sends, so it leaves the player,
closes popups and goes up screens. A second BACK within 2.5 s exits the app.

### Typing (Android soft keyboard)

The Leanback search screen renders its own letter grid and leaves no *visible* editable element,
which is why the system keyboard never appeared (and why a hidden input could silently swallow the
request). The port covers both cases:

1. **Field path** — a **visible** text field is focused and the IME is attached to the WebView
   (`InputMethodManager.showSoftInput`).
2. **Sink path** — otherwise a slim native input bar appears at the top and the keyboard opens for
   it; every edit is forwarded into the page (`__vtInjectText` / `__vtBackspace` / `__vtEnter`).
   Text goes to the page's field when one exists, otherwise the matching key of Leanback's own
   letter grid is clicked for each character.

The keyboard is raised automatically when the search screen is detected, and any time you tap the
**ABC** button or focus a field. Path 1 is preferred, and the native side switches to path 2 by
itself when the IME window does not actually appear (checked through window insets, not through the
unreliable `isActive()`), so the keyboard always opens. BACK closes it.

## 2. Architecture

```
MainActivity ── AspectFrameLayout (16:9) ── WebView
     │                                         ▲
     │  VTWebViewClient.shouldInterceptRequest │  rewritten document:
     │   • fetch youtube.com/*/tv with the Cobalt UA + client hints
     │   • persist Set-Cookie into CookieManager
     │   • merge the real CSP headers (VtCsp) and add our nonce
     │   • inject assets/vt/preload.bundle.js as first <script nonce> ──┘ (document-start)
     │
     ├─ VTBridge  (@JavascriptInterface "VacuumTube")  ←→  bundled page-world shims
     │     get-config/set-config (sync) · deeplink · reload · fullscreen · clipboard · mic
     │     userstyles · about/updates · focus/blur · toast · randomUUID · DIAL control
     └─ VtDial    SSDP :1900 + HTTP / apps/*  ──→  window.__vtDialDispatch(app, method, path, body)
```

Everything the Electron main process used to do for the web surface is either in
`VTWebViewClient` (UA, CSP, document-start injection, cookie mirroring) or in `VTBridge`.

## 3. What is reused, what is shimmed, what is new

* **Reused verbatim (70 files):** every `src/preload/**` module from the shipped `app.asar`, embedded
  as-is — including the module loader `preload/index.js` (its `fs.readdirSync` + dynamic `require`
  still work, against the virtual filesystem and the packaged directory order).
* **Shims (6 files, `tools/shims/`):** `electron` (ipcRenderer/shell), `fs` (virtual, read-only),
  `path`, `os`, `crypto`, `events` — the smallest subset Node gave the original (list in
  `docs/FINDINGS.md` §3).
* **Replaced natively (3 files):** `h5vcc/dial/{http,server,discover}.js` only, because a WebView
  page cannot own sockets. The DIAL *semantics* stay in JS.
* **New page-side code (1 file, `tools/android-glue.js`):** Cobalt `navigator.userAgentData`,
  D-pad→Starboard translation, the MENU/gear entry point for settings, `window.close()`→exit.
* **New native code (7 Java files, ~1.5k lines):** the Activity/WebView host, bridge, CSP/injection,
  config store, native DIAL, 16:9 layout.

## 4. Building

Requirements (already present in this workspace):

| Tool | Path used |
|---|---|
| Android SDK build-tools 35.0.0 | `..\rea-work\android-sdk\build-tools\35.0.0` |
| Android platform android-35 | `..\rea-work\android-sdk\platforms\android-35\android.jar` |
| JDK 17+ (27 used) | `C:\Program Files\Java\jdk-27` |
| Node.js (for the bundler) | `C:\Program Files\nodejs` |

```powershell
# Full pipeline: bundle -> aapt2 compile/link -> javac -> d8 -> package assets+dex -> zipalign -> apksigner
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-apk.ps1

# Or: tools\build.cmd   (wrapper that sets -ExecutionPolicy Bypass; the default policy blocks .ps1)

# Static verification of the produced APK (contents, asset identity, dex classes, manifest, signature)
powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-apk.ps1

# Verification of the ported page code itself (jsdom, no device needed)
cd tools; npm install; node smoke-test.mjs

# Verification of the CSP/injection port against the real headers youtube.com/tv sends
javac -d build\verify-csp tools\verify-csp\CspCheck.java app\src\main\java\rocks\shy\vacuumtube\android\VtCsp.java
java -cp build\verify-csp CspCheck ..\rea-work\csp-headers-cobalt-ua.txt ..\rea-work\served-cobalt-ua.html
```

Optional Gradle/Android Studio build: see `app/build.gradle.kts` — note the one-line manifest
difference explained in `build.gradle.kts` (aapt2 requires `package=`, AGP 8 forbids it).

## 5. Installing / running

```powershell
adb install -r dist\VacuumTube-Android.apk
# or copy the APK to the device and open it (sideload)
```

* **Android TV / boxes:** appears in the TV launcher (Leanback banner included); remote D-pad, Enter
  and Back work; a gamepad works through `navigator.getGamepads()` as in the original.
* **Phones/tablets:** landscape, edge-to-edge (no letterbox bars), the original touch overlay appears
  on touch, gear button opens VacuumTube settings, ABC button opens the Android keyboard.
* **Upgrading an older build:** port-level defaults are applied once through a config-version marker
  (currently v3: `fullscreen`, `android_full_bleed`; the upstream experimental *Ultrawide Support* is
  restored to its default because the port now owns the display fix). Your own settings are never
  overwritten afterwards.
* **First run:** YouTube asks to sign in with a TV code (`youtube.com/tv` behaviour) — normal for
  Leanback, and cookies persist across launches.
* **Casting:** with *Device Discoverability* enabled (default), the service answers SSDP/Dial and
  serves `http://<device>:<port>/` so the YouTube mobile app can find it.

## 6. Known limitations (honest list)

1. **Not tested on a real device or emulator here.** There is no emulator or device in this
   environment, so runtime behaviour on hardware is *unverified*; the verification performed is
   static + jsdom + live-server evidence (see `docs/FINDINGS.md` §5).
2. **Video codecs/DRM:** playback uses the HTML5/MSE path of the system WebView. Widevine-protected
   content (purchased movies) will not play; codec support depends on the device. If a device lacks
   VP9/AV1, enable *Filter Video Codecs* → keep H.264 only.
3. **Client hints on sub-resources:** the main document request carries Cobalt `sec-ch-ua*`; XHRs
   issued by the page carry the WebView's own Chromium hints (a WebView cannot rewrite per-request
   headers). The UA that gates the TV surface is correct everywhere.
4. **Resolution reporting:** `h5vcc.system.getVideoContainerSizeOverride()` derives from
   `window.screen` (CSS px), exactly like the desktop app, so on high-DPI panels the reported ceiling
   is conservative — *Unlock Resolution* exists for that.
5. **Desktop-only settings** are still shown but have no Android meaning: *Keep on Top*,
   *No Window Decorations*, *Wayland HDR*, *Hardware Decoding* (always on), *Automatic Updates*
   (the About page reports `unsupported` and links to the releases page).
6. **DIAL is implemented but unexercised** (no second device to test discovery with).
7. **Voice search** needs the microphone runtime permission; the WebView permission prompt path is
   implemented but untested.
8. **Soft keyboard on device** — the two keyboard paths are exercised offline (jsdom: field focus,
   text injection, backspace, letter-grid clicking, Starboard submit) but the on-device IME
   behaviour was not verified here. If the sink path is used, accents/uppercase only reach the TV
   keyboard if it has those keys; the field path has no such limit.
9. **Video aspect** — with `android_video_fill` on, landscape videos are cropped to fill the screen
   (nothing is distorted, but the top/bottom of the picture is cut, like a TV "zoom" mode). Portrait
   videos keep their letterboxing on purpose.

## 7. Attribution and licence

The ported page-side code is VacuumTube by **shy1132** (MIT — `vendor/vacuumtube-preload/LICENSE`),
extracted from the shipped `app.asar`. The Android host, shims and tooling in this directory are a
derivative work under the same licence; see [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md).
VacuumTube itself is an unofficial wrapper of YouTube Leanback; nothing here is affiliated with
YouTube or Google.
