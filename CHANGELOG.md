# Changelog

All notable changes to the Android port. Each entry lists the APK that was produced and its sha256,
because the APKs are signed with a debug key and are not reproducible byte-for-byte (the generation
timestamp is embedded in the injected bundle).

## 2.0.0-android (build 6)

Device-driven hardening of the settings entry points, after a report that tapping them did nothing.

* **Error visibility**: page `error` and `unhandledrejection` events are captured, logged through the
  native bridge (logcat) and reported by the diagnostics. The shipped module loader only catches
  synchronous failures, so an async module that fails during init was previously silent.
* **Fallback settings panel**: when the ported settings overlay is not available, the port opens its
  own panel (plain DOM, same config bridge) instead of doing nothing — 19 of the most useful options.
* **Native "VT" button** in the Activity: an ordinary Android view outside the WebView, so it cannot
  be blocked by anything the page does. Tap = settings, long-press = diagnostics.
* APK `254,912 bytes` · sha256 `817a121b82c1eac7834675b3cbbf70c4d8ab4d05c56565e727532d2b17464789`

## 2.0.0-android (build 5)

* **Fixed a real bug in the Electron shim**: `ipcRenderer.on()` kept listeners in a private map while
  the native side emits through the runtime bus, so **no native → page event ever reached a ported
  module** (`config-update`, `focus`, `blur`, `deeplink`). Listeners now live on `__VT__`'s bus, and
  the smoke test asserts delivery by counting received events.
* **Settings that only affect future data** (`hide-shorts`, `adblock`, `dearrow`, …) are XHR/JSON
  *response* modifiers upstream, so flipping them looked like it did nothing; the port reloads once
  after such a change (toast naming the keys, `android_reload_on_feed_change` to disable).
* **Video centring**: the app sizes `<video>` to the whole player and letterboxes inside it with
  `object-fit: contain`; the fill now pins the video to the viewport (`object-position: center`) and
  neutralises only ancestors that are measurably off-centre/narrow/transformed.
* APK `250,816 bytes` · sha256 `b971f6ad19b0014dca7e64dd778460b6c43f684dcda32e7d1fecde6a308789a1`

## 2.0.0-android (build 4)

* The **"Open VacuumTube Settings"** row inside YouTube's own settings screen works: the globals are
  proxied (queuing a request made before the module is ready, implementation captured exactly once)
  and the row is also detected from the DOM and from the focused element on select.
* **Video fill** (`android_video_fill`, default on): landscape videos are cropped to fill the player;
  portrait/Shorts sources stay contained on purpose.
* Corner buttons no longer act twice when Android follows `touchend` with compatibility mouse events.
* Diagnostics toast on long-pressing ABC.
* APK `250,816 bytes` · sha256 `aae3fc4eb41eb5115ac4be8e9ee478b25727f1c16e3805b1fd2bd78e6d67f941`

## 2.0.0-android (build 3)

Measured against a real browser (Playwright + Chromium + the live page):

* **Why the sides were empty**: the TV surface is a fixed 16:9 **rem** stage
  (`#container`/`#app-background` = `80rem × 45rem`, `html{font-size: height/45}`), so a 1560-wide
  viewport renders a 1280-wide stage centred at `x=140`. The upstream *Ultrawide Support* feature
  widens the content containers but not `#app-background`, which is why a border survived.
  Fixed with the port's own `#vt-android-fullbleed` stylesheet (`android_full_bleed`).
* **Back gesture**: gesture navigation delivers BACK through `onBackPressed()`, never as a `KeyEvent`,
  which is why swiping did nothing. Now handled, plus an `OnBackInvokedCallback` on API 33+, and BACK
  is forwarded to the page as the Starboard BACK code (`32769`).
* Synthetic input events now also carry `key`/`code`, so a remote can drive VacuumTube's own overlay.
* APK `246,720 bytes` · sha256 `28114a5ab335f63f41ca630e0f706008a04bdfe42bc6284d5f62e10c27adecf1`

## 2.0.0-android (build 2)

* **Full-bleed display**: no letterbox; the app is edge-to-edge and immersive, with the upstream
  *Ultrawide Support* enabled (later replaced by the port's own stylesheet in build 3).
* **Android soft keyboard**: two paths — the WebView IME for a *visible* page field, otherwise a
  native `EditText` sink whose edits are forwarded into the page (typing into Leanback's letter grid
  when there is nothing editable). Auto-raised on the search screen, plus an **ABC** button.
  The fallback is driven by real IME visibility (`WindowInsets.Type.ime()`), not `isActive()`.
* APK `242,624 bytes` · sha256 `be05a05bae76956364c2293d6d1d829acb9e3c6149e9ab9d4823b3bd6d79687a`

## 2.0.0-android (build 1)

First working port of VacuumTube 2.0.0 to Android, produced by reverse engineering the shipped
`resources/app.asar` with REA:

* all 70 page-side preload modules reused **verbatim**, embedded in one page-world bundle injected as
  the first `<script>` in `<head>` (document-start), with a CommonJS runtime, a virtual filesystem for
  the assets the modules read with `fs`/`__dirname`, and six Node/Electron shims;
* native host: WebView, `VTBridge` (`@JavascriptInterface`, channel-for-channel with the original
  `ipcRenderer`), `VTConfig` (41 upstream defaults), `VtCsp` (CSP merge/injection), `VtDial` (SSDP +
  HTTP transport, Leanback's own DIAL handlers called back into the page);
* Cobalt 27 user agent + client hints, deep links, Android TV launcher + banner, 16:9 stage;
* verification: jsdom smoke test, CSP checks against the real headers, APK static checks.
* APK `238,528 bytes` · sha256 `179b7260826b5c2065c202e5897ac3e4f154cecdfc57a884ebb081bbf6d870f1`
