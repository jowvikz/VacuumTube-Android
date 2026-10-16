# tools/

Build and verification tooling for the port. Everything here is used either by
`build-apk.ps1` or by one of the four verification harnesses described in the README.

## Building

| script | what it does |
|---|---|
| `bundle-preload.mjs` | Takes `vendor/vacuumtube-preload/` (the preload tree extracted from the shipped `app.asar`) and emits `app/src/main/assets/vt/preload.bundle.js`: a CommonJS runtime, the virtual filesystem for the assets the modules read with `fs`/`__dirname`, six Node/Electron shims, the three native-DIAL replacements, `android-glue.js`, and all 70 upstream modules **verbatim**. Refuses to emit if the result could break out of an inline `<script>`. |
| `dump-asar-order.mjs` | Reads the directory order straight out of the `app.asar` header into `vendor/vacuumtube-preload/.readdir-order.json`, so the bundled `fs.readdirSync()` reproduces the order the Electron build saw. |
| `make-icons.ps1` | Generates the launcher icons and the Android TV banner (320×180 dp) from the app's own `assets/icon.png`. |
| `build-apk.ps1` | The whole build, no Gradle: `aapt2 compile` → `aapt2 link` → `javac --release 17` → `d8` → package `classes.dex` + assets with forward slashes → `zipalign` → `apksigner` (debug key). |
| `build.cmd` | Wrapper that re-invokes the script with `-ExecutionPolicy Bypass` (the default policy blocks `.ps1`). |

## Shims (`shims/`)

`electron`, `fs`, `path`, `os`, `crypto`, `events` — the smallest faithful subset of Node that the
upstream preload used. `dial-http.js`, `dial-server.js` and `dial-discover.js` replace the three
modules that owned sockets; the DIAL *semantics* stay in JavaScript and are driven by the native
transport. `runtime-prelude.js` is the module system and the bridge plumbing.

`android-glue.js` is the only genuinely new page-side code: Cobalt client hints, Starboard key
translation, the two-path Android keyboard bridge, the full-bleed stage and the video fill, the
settings entry points and the runtime diagnostics.

## Verifying

| script | needs | what it proves |
|---|---|---|
| `smoke-test.mjs` | `npm install` (jsdom) | Loads the built bundle into a page that pretends to be `https://www.youtube.com/tv`, with a stub implementing `VTBridge`'s contract, and asserts behaviour: modules load, adblock filters a parsed payload, `window.h5vcc` exists, the settings overlay renders from the bundled locale, a toggle writes config, the config event round-trip is delivered, the keyboard bridge types, the letter grid is clicked, the full-bleed and video-fill styles exist, off-centre ancestors are neutralised, the fallback panel works. |
| `verify-csp` | a JDK | `CspCheck.java` runs `VtCsp` (no Android imports) against the **real** CSP headers recorded from `youtube.com/tv` and checks the merge, the relaxations and the document injection. |
| `verify-apk.ps1` | the SDK | Static checks on the produced APK: entries, asset name (no backslashes) and sha256 against the bundle manifest, dex classes, manifest attributes, signature. |
| `verify-runtime.mjs` | `npx playwright install chromium` | The highest-fidelity offline check: runs the **production bundle** in a real Chromium against the live Leanback page, injected exactly like `VTWebViewClient` does (document fetched directly, CSP removed, bundle first in `<head>`), then measures the layout and taps the UI. |

## Measurement probes

These are the scripts that answered the questions with evidence instead of guesses; the screenshots
they write land in `build/tv-probe/`.

| script | question it answered |
|---|---|
| `tv-probe.mjs` | Does the Cobalt user agent still earn the TV surface, and how big is that response? (Yes: ~195 KB of Leanback HTML vs ~5.7 KB for a Chrome UA, plus the CSP the client has to rewrite.) |
| `tv-probe2.mjs` | Why are the sides of the screen empty? (The TV surface is a fixed 16:9 **rem** stage — `80rem × 45rem` with `html{font-size: height/45}` — and which repair actually removes the border.) |
| `tv-probe3.mjs` | Do the VacuumTube settings toggles work? (Yes: the pill flips and `set-config` is sent.) What is the `<video>` element's ancestor chain, and who letterboxes the picture? (The app sizes `<video>` to the whole player and uses `object-fit: contain`.) |
| `debug-enter.mjs` | Scratch harness for the glue's DOM helpers (`__vtOpenIme`, `__vtInjectText`, `__vtBackspace`, `__vtEnter`). |
