// End-to-end rehearsal of the Android client inside a real Chromium:
//   * the production bundle from app/src/main/assets/vt/preload.bundle.js
//   * injected the same way VTWebViewClient does (rewrite the document's CSP, insert the bundle as
//     the first <script> in <head>)
//   * with a stub for the native bridge contract of VTBridge.java
// Then it measures the real Leanback layout and screenshots it.
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const out = path.join(root, 'build', 'tv-probe')
fs.mkdirSync(out, { recursive: true })
const bundle = fs.readFileSync(path.join(root, 'app/src/main/assets/vt/preload.bundle.js'), 'utf8')

const VIEWPORT = { width: 1560, height: 720 } // 20:9 phone in landscape
const COBALT_UA = 'Mozilla/5.0 (Linux; Android 14) Cobalt/27.lts.3.1040976-gold (unlike Gecko) v8/13.8.258.54-jit gles Starboard/18, '
    + `VacuumTube_DESKTOP_arm64_${new Date().getFullYear()}/2.0.0-android (VacuumTube, Android) rocks.shy.vacuumtube.android/2.0.0-android`

const CONFIG = {
    volume: 100,
    adblock: true,
    sponsorblock: false,
    sponsorblock_uuid: 'probe-uuid',
    dearrow: false,
    dislikes: false,
    h264ify: false,
    unlock_resolution: false,
    fullscreen: true,
    features_enabled: false,
    ultrawide_feature: false,
    touch_overlay: false,
    controller_support: false,
    device_discoverability: false,
    userstyles: false,
    disabled_userstyles: [],
    disabled_tabs: [],
    android_full_bleed: true,
    android_letterbox: false
}

// Same initialisation the native bridge provides (VTBridge.java) — see tools/smoke-test.mjs.
const bridgeScript = `
window.__vtProbeCalls = [];
window.VacuumTube = {
  sendSync: function (channel, arg) {
    window.__vtProbeCalls.push('sendSync:' + channel);
    if (channel === 'get-config') return ${JSON.stringify(JSON.stringify(CONFIG))};
    if (channel === 'can-auto-update') return 'false';
    if (channel === 'set-config') return ${JSON.stringify(JSON.stringify(CONFIG))};
    return 'null';
  },
  invoke: function (channel, arg, id) {
    window.__vtProbeCalls.push('invoke:' + channel);
    var value = channel === 'is-steam' ? false : null;
    setTimeout(function () {
      if (window.__vtResolve) window.__vtResolve(id, JSON.stringify(value));
    }, 0);
  },
  send: function (channel) { window.__vtProbeCalls.push('send:' + channel); },
  deviceName: function () { return 'Chromium probe'; },
  deviceRelease: function () { return '14'; },
  deviceArch: function () { return 'arm64'; },
  appVersion: function () { return '2.0.0-android'; },
  getStarboardInput: function () { return 'true'; },
  setStarboardInput: function () {},
  toast: function (message) { window.__vtProbeCalls.push('toast:' + message); },
  openExternal: function (url) { window.__vtProbeCalls.push('openExternal:' + url); },
  setClipboard: function () {}, getClipboard: function () { return ''; },
  randomUUID: function () { return '11111111-2222-4333-8444-555555555555'; },
  showKeyboard: function () { window.__vtProbeCalls.push('showKeyboard'); },
  showKeyboardSink: function () { window.__vtProbeCalls.push('showKeyboardSink'); },
  hideKeyboard: function () {},
  dialStart: function () {}, dialStop: function () {},
  log: function (tag, message) { window.__vtProbeCalls.push('log:' + tag + ':' + message); }
};
`

// Port of VtCsp.injectBundle (app/src/main/java/.../VtCsp.java)
function injectBundle(html, code) {
    const tag = '<script>' + code + '</script>'
    const head = html.toLowerCase().indexOf('<head')
    if (head >= 0) {
        const end = html.indexOf('>', head)
        if (end > 0) return html.slice(0, end + 1) + tag + html.slice(end + 1)
    }
    const rootTag = html.toLowerCase().indexOf('<html')
    if (rootTag >= 0) {
        const end = html.indexOf('>', rootTag)
        if (end > 0) return html.slice(0, end + 1) + tag + html.slice(end + 1)
    }
    return tag + html
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    hasTouch: true, // reproduce phone taps (touchstart/touchend + compatibility mouse events)
    userAgent: COBALT_UA,
    extraHTTPHeaders: {
        'sec-ch-ua': '"VacuumTube";v="27"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Starboard"'
    }
})

// youtube.com/tv sends very large response headers (Playwright's route.fetch throws "Header
// overflow"), so the document is fetched directly — which is also exactly what VTWebViewClient does
// with HttpURLConnection.
function fetchDocument(url, depth = 0) {
    return new Promise((resolve, reject) => {
        const request = https.request(url, {
            headers: {
                'User-Agent': COBALT_UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
                'Accept-Encoding': 'identity',
                'sec-ch-ua': '"VacuumTube";v="27"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Starboard"'
            },
            maxHeaderSize: 8 << 20
        }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && depth < 5) {
                response.resume()
                resolve(fetchDocument(new URL(response.headers.location, url).toString(), depth + 1))
                return
            }
            const chunks = []
            response.on('data', (chunk) => chunks.push(chunk))
            response.on('end', () => resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks).toString('utf8')
            }))
        })
        request.on('error', reject)
        request.end()
    })
}

let injected = 0
await context.route('**/*', async (route) => {
    const request = route.request()
    const url = request.url()
    if (request.resourceType() !== 'document' || !/youtube\.com/.test(url)) {
        await route.continue()
        return
    }
    try {
        const document = await fetchDocument(url)
        const body = injectBundle(document.body, bundle)
        injected++
        // Only the essentials: the CSP is intentionally absent, like the Android client's rewrite.
        await route.fulfill({
            status: document.status,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body
        })
    } catch (err) {
        console.log('route failed:', err.message.slice(0, 160))
        await route.continue()
    }
})

await context.addInitScript(bridgeScript)
const page = await context.newPage()
const pageErrors = []
// YouTube's own code produces these in stock Chromium too (verified against the untouched page), so
// they are noise, not port defects.
const BENIGN = [
    'Refused to set unsafe header',
    "invalid source: ''cobalt-insecure",
    'Unrecognized Content-Security-Policy directive'
]
const isBenign = (text) => BENIGN.some((needle) => text.indexOf(needle) >= 0)
page.on('console', (message) => {
    if (message.type() === 'error' && !isBenign(message.text())) pageErrors.push(message.text().slice(0, 200))
})
page.on('pageerror', (error) => {
    const text = String(error)
    if (!isBenign(text)) pageErrors.push('pageerror: ' + text.slice(0, 200))
})

await page.goto('https://www.youtube.com/tv', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(10000)

const state = await page.evaluate(() => {
    const box = (selector) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const rect = el.getBoundingClientRect()
        return [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]
    }
    return {
        viewport: [window.innerWidth, window.innerHeight],
        loaded: window.__vtLoaded === true,
        fullBleedStyle: !!document.getElementById('vt-android-fullbleed'),
        settingsButton: !!document.getElementById('vt-android-settings-button'),
        keyboardButton: !!document.getElementById('vt-android-keyboard-button'),
        h5vcc: !!window.h5vcc,
        jsonParsePatched: String(JSON.parse).indexOf('function') >= 0 && !!window.__vtLoaded,
        container: box('div#container'),
        background: box('div#app-background'),
        calls: (window.__vtProbeCalls || []).slice(0, 12)
    }
})

await page.screenshot({ path: path.join(out, 'bundle-fullbleed-20x9.png') })

// ---- settings overlay: device report said tapping the gear does nothing ----------------
const overlayState = () => page.evaluate(() => {
    const root = document.getElementById('vt-settings-overlay-root')
    return {
        present: !!root,
        visible: root ? !root.classList.contains('vt-settings-hidden') : false,
        className: root ? root.className : null
    }
})

const overlayApi = await page.evaluate(() => ({
    toggle: typeof window.vtToggleSettingsOverlay,
    open: typeof window.vtOpenSettingsOverlay,
    rootPresent: !!document.getElementById('vt-settings-overlay-root')
}))
console.log('\nsettings overlay API:', JSON.stringify(overlayApi))
console.log('overlay before tap:', JSON.stringify(await overlayState()))

const gear = await page.$('#vt-android-settings-button')
const gearBox = gear ? await gear.boundingBox() : null
if (gearBox) {
    await page.touchscreen.tap(gearBox.x + gearBox.width / 2, gearBox.y + gearBox.height / 2)
}
await page.waitForTimeout(700)
const afterTap = await overlayState()
console.log('after ONE touchscreen tap ->', JSON.stringify(afterTap))

// Android fires the compatibility mouse events a few milliseconds after touchend, so the whole
// sequence is replayed synchronously inside the page (a round trip through the driver would add
// hundreds of ms and would not test the guard).
const duplicateSequence = await page.evaluate(async () => {
    const root = document.getElementById('vt-settings-overlay-root')
    const visible = () => !!root && !root.classList.contains('vt-settings-hidden')
    if (visible()) window.vtToggleSettingsOverlay()
    await new Promise((resolve) => setTimeout(resolve, 400)) // settle past the activation guard
    const button = document.getElementById('vt-android-settings-button')
    button.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }))
    button.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }))
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    return visible()
})
console.log('synchronous tap+mouse sequence leaves the overlay open:', duplicateSequence)

if (!duplicateSequence) {
    // re-open for the following steps
    await page.evaluate(() => window.vtToggleSettingsOverlay && window.vtToggleSettingsOverlay())
    await page.waitForTimeout(300)
}

if (gearBox) {
    await page.touchscreen.tap(gearBox.x + gearBox.width / 2, gearBox.y + gearBox.height / 2)
    await page.waitForTimeout(700)
}
const afterSecondTap = await overlayState()
console.log('after SECOND tap ->', JSON.stringify(afterSecondTap))
await page.screenshot({ path: path.join(out, 'bundle-settings-overlay.png') })

// The row leanback-settings.js injects into YouTube's own settings screen ("Open VacuumTube
// Settings"): the shipped handler is dead code, so the port detects the row from the DOM.
const videoFillStyle = await page.evaluate(() => ({
    videoFill: !!document.getElementById('vt-android-videofill'),
    diagnostics: typeof window.__vtDiagnostics === 'function' ? window.__vtDiagnostics() : null
}))
console.log('\nvideo-fill style:', videoFillStyle.videoFill, '| diagnostics:', videoFillStyle.diagnostics)

if (afterSecondTap.visible) {
    await page.evaluate(() => window.vtToggleSettingsOverlay && window.vtToggleSettingsOverlay())
    await page.waitForTimeout(300)
}
const rowOpened = await page.evaluate(async () => {
    const row = document.createElement('button')
    row.textContent = 'Open VacuumTube Settings'
    row.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:2147483647'
    document.body.appendChild(row)
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    return (() => {
        const root = document.getElementById('vt-settings-overlay-root')
        return !!root && !root.classList.contains('vt-settings-hidden')
    })()
})
console.log('injected "Open VacuumTube Settings" row opened the overlay:', rowOpened)
await page.screenshot({ path: path.join(out, 'bundle-settings-row.png') })

const failures = []
const check = (name, ok, detail) => {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : ''))
    if (!ok) failures.push(name)
}

console.log('documents injected:', injected)
console.log('state:', JSON.stringify(state, null, 1))
console.log('')
check('bundle injected into the real document', injected > 0)
check('bundle booted in the real page', state.loaded === true)
check('full-bleed style present', state.fullBleedStyle === true)
check('#container spans the viewport width', state.container && state.container[2] === state.viewport[0], JSON.stringify(state.container) + ' vs ' + state.viewport[0])
check('#app-background spans the viewport width', state.background && state.background[2] === state.viewport[0], JSON.stringify(state.background))
check('both stage boxes start at x=0', state.container && state.container[0] === 0 && state.background && state.background[0] === 0)
check('gear + keyboard buttons installed in the real page', state.settingsButton && state.keyboardButton)
check('window.h5vcc provided', state.h5vcc === true)
check('native bridge was used (get-config)', state.calls.some((call) => call === 'sendSync:get-config'), state.calls.join(','))
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
check('settings overlay API exposed by the ported module', overlayApi.toggle === 'function' && overlayApi.rootPresent, JSON.stringify(overlayApi))
check('one tap on the gear opens the overlay', afterTap.visible === true, JSON.stringify(afterTap))
check('a tap with its compatibility mouse events acts once (stays open)', duplicateSequence === true)
check('a second tap closes the overlay', afterSecondTap.visible === false, JSON.stringify(afterSecondTap))
check('video-fill style injected', videoFillStyle.videoFill === true)
check('diagnostics report a full-bleed stage', !!videoFillStyle.diagnostics && videoFillStyle.diagnostics.indexOf('stage=' + VIEWPORT.width + '/' + VIEWPORT.width) >= 0, String(videoFillStyle.diagnostics))
check('"Open VacuumTube Settings" row opens the overlay in the real page', rowOpened === true)

await browser.close()
console.log('')
console.log(failures.length ? failures.length + ' check(s) failed' : 'all checks passed')
console.log('screenshot:', path.join(out, 'bundle-fullbleed-20x9.png'))
process.exit(failures.length ? 1 : 0)
