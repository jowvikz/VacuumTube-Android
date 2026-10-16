// VacuumTube-Android smoke test.
//
// Loads the generated preload bundle (the ported VacuumTube 2.0.0 modules) into a jsdom page that
// pretends to be https://www.youtube.com/tv, with a JavaScript stub that implements the same
// native bridge contract as VTBridge.java. It then asserts that the REA-derived behaviour really
// is live: JSON.parse/XHR patched, adblock filtering, window.h5vcc, the settings overlay rendered
// from the bundled locale, the Android input translation, and the DIAL dispatch path.
//
// This is static+runtime evidence for the port, not a substitute for testing on a device.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const bundlePath = process.env.VT_BUNDLE || path.join(root, 'app', 'src', 'main', 'assets', 'vt', 'preload.bundle.js')
const bundle = fs.readFileSync(bundlePath, 'utf8')

// Defaults copied from the shipped app's src/config.js:16-58 (see census.md §4.1).
const DEFAULTS = {
    volume: 100,
    adblock: true,
    sponsorblock: false,
    sponsorblock_uuid: '00000000-0000-4000-8000-000000000000',
    sponsorblock_skip_sponsor: true,
    sponsorblock_skip_selfpromo: false,
    sponsorblock_skip_interaction: false,
    sponsorblock_skip_intro: false,
    sponsorblock_skip_outro: false,
    sponsorblock_skip_preview: false,
    sponsorblock_skip_hook: false,
    sponsorblock_skip_filler: false,
    dearrow: false,
    dislikes: false,
    remove_super_resolution: false,
    hide_shorts: false,
    block_continue_watching: false,
    h264ify: false,
    h264ify_disable_webm: true,
    h264ify_disable_vp8: true,
    h264ify_disable_vp9: true,
    h264ify_disable_av1: true,
    unlock_resolution: false,
    hardware_decoding: true,
    wayland_hdr: false,
    low_memory_mode: false,
    fullscreen: false,
    features_enabled: false,
    music_mode_feature: false,
    music_mode: false,
    ultrawide_feature: false,
    remaining_time_feature: false,
    no_window_decorations: false,
    keep_on_top: false,
    pause_on_blur: false,
    userstyles: false,
    disabled_userstyles: [],
    touch_overlay: true,
    controller_support: true,
    device_discoverability: true,
    auto_update: true,
    disabled_tabs: []
}

const log = []
const moduleFailures = []
const pageErrors = []

// Page-side async failures are evidence, not a reason to abort the run.
process.on('uncaughtException', (err) => pageErrors.push('uncaught: ' + (err && err.message ? err.message : String(err))))
process.on('unhandledRejection', (err) => pageErrors.push('unhandledRejection: ' + (err && err.message ? err.message : String(err))))

function makeBridge(window, config) {
    const calls = []
    const bridge = {
        __calls: calls,
        __config: config,
        sendSync(channel, arg) {
            calls.push({ kind: 'sendSync', channel, arg })
            const payload = arg ? JSON.parse(arg) : null
            switch (channel) {
                case 'get-config':
                    return JSON.stringify(config)
                case 'set-config': {
                    Object.assign(config, payload || {})
                    // mirrors VTBridge: the update is pushed back to the page asynchronously
                    window.setTimeout(() => {
                        if (typeof window.__vtEmit === 'function') window.__vtEmit('config-update', JSON.stringify(config))
                    }, 0)
                    return JSON.stringify(config)
                }
                case 'can-auto-update':
                    return 'false'
                default:
                    return 'null'
            }
        },
        invoke(channel, arg, id) {
            calls.push({ kind: 'invoke', channel, arg, id })
            const answer = (value) => window.setTimeout(() => {
                if (typeof window.__vtResolve === 'function') window.__vtResolve(id, JSON.stringify(value))
            }, 0)
            switch (channel) {
                case 'get-deeplink': return answer(null)
                case 'is-steam': return answer(false)
                case 'get-userstyles': return answer([])
                case 'reload': return answer(true)
                case 'set-fullscreen': return answer(true)
                case 'set-on-top': return answer(true)
                case 'get-about-info':
                    return answer({ status: 'unsupported', currentVersion: '2.0.0-android', latestVersion: '', platform: 'android', arch: 'arm64', installationType: 'sideload', canAutoUpdate: false, progress: null })
                case 'request-microphone-permission': return answer('granted')
                case 'get-microphone-permission-status': return answer('granted')
                case 'check-for-updates': return answer({ status: 'unsupported', currentVersion: '2.0.0-android', latestVersion: '', platform: 'android', arch: 'arm64', installationType: 'sideload', canAutoUpdate: false, progress: null })
                default: return answer(null)
            }
        },
        send(channel, arg) { calls.push({ kind: 'send', channel, arg }) },
        deviceName: () => 'Android TV',
        deviceRelease: () => '14',
        deviceArch: () => 'arm64',
        deviceModel: () => 'smoke-test',
        appVersion: () => '2.0.0-android',
        getStarboardInput: () => 'true',
        setStarboardInput: (value) => { bridge.__starboard = String(value) },
        toast: (message) => log.push('toast: ' + message),
        openExternal: (url) => calls.push({ kind: 'openExternal', url }),
        setClipboard: (text) => calls.push({ kind: 'setClipboard', text }),
        getClipboard: () => '',
        showKeyboard: () => { bridge.__keyboard.push('webview') },
        showKeyboardSink: () => { bridge.__keyboard.push('sink') },
        hideKeyboard: () => { bridge.__keyboard.push('hide') },
        __keyboard: [],
        dialStart: () => calls.push({ kind: 'dialStart' }),
        dialStop: () => calls.push({ kind: 'dialStop' }),
        randomUUID: () => '11111111-2222-4333-8444-555555555555',
        log: (tag, message) => log.push(tag + ': ' + message)
    }
    return bridge
}

const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', (err) => pageErrors.push('jsdomError: ' + (err && err.message ? err.message : String(err))))
virtualConsole.on('error', (...args) => {
    const text = args.map((a) => (a && a.stack) ? a.stack : String(a)).join(' ')
    if (text.includes('a module experienced failure while loading')) moduleFailures.push(text.split('\n')[0])
    else pageErrors.push('console.error: ' + text)
})
virtualConsole.on('warn', (...args) => log.push('warn: ' + args.map(String).join(' ')))
virtualConsole.on('log', (...args) => log.push('log: ' + args.map(String).join(' ')))

const html = '<!DOCTYPE html><html><head><title>YouTube</title></head><body><div id="app"></div></body></html>'
const dom = new JSDOM(html, { url: 'https://www.youtube.com/tv', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole })
const window = dom.window
const document = window.document

// Browser APIs jsdom lacks but Leanback/VacuumTube touch.
window.matchMedia = window.matchMedia || ((query) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }))
window.navigator.getGamepads = () => []
window.MediaSource = window.MediaSource || class MediaSourceStub { static isTypeSupported() { return true } }
if (window.MediaSource && !window.MediaSource.isTypeSupported) window.MediaSource.isTypeSupported = () => true
window.HTMLMediaElement.prototype.play = function () { return Promise.resolve() }
window.fetch = window.fetch || (() => Promise.reject(new Error('smoke test: no network')))
// jsdom has no CSS.escape (settings/focus.js uses it; every real Chromium/WebView has it).
window.CSS = window.CSS || {}
window.CSS.escape = window.CSS.escape || ((value) => String(value).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, (ch) => '\\' + ch))
window.CSS.supports = window.CSS.supports || (() => false)
// jsdom performs no layout, so every getBoundingClientRect() is 0x0; the ported Android glue (and
// the TV-keyboard heuristic) filters on real geometry, so give the test page a plausible box.
// Elements may pin their own box through __vtTestRect to model the player layout.
window.Element.prototype.getBoundingClientRect = function () {
    const custom = this.__vtTestRect
    if (custom) {
        return {
            x: custom[0], y: custom[1], width: custom[2], height: custom[3],
            left: custom[0], top: custom[1], right: custom[0] + custom[2], bottom: custom[1] + custom[3],
            toJSON() { return this }
        }
    }
    return { x: 120, y: 80, width: 28, height: 28, top: 80, left: 120, right: 148, bottom: 108, toJSON() { return this } }
}

const config = JSON.parse(JSON.stringify(DEFAULTS))
const bridge = makeBridge(window, config)
window.VacuumTube = bridge

const nativeJsonParse = window.JSON.parse
const nativeXhr = window.XMLHttpRequest

// modules/h5vcc/index.js waits for Leanback's persisted device id before starting DIAL.
window.localStorage.setItem('yt.leanback.default::mdx-device-id', JSON.stringify({ data: 'smoke-device-id' }))

const results = []
function check(name, condition, detail) {
    results.push({ name, pass: !!condition, detail: detail === undefined ? '' : String(detail) })
}

let evalError = null
try {
    window.eval(bundle)
} catch (err) {
    evalError = err
}

// Leanback installs ytcfg/locale info from its own bootstrap script; util/configOverrides.js hooks
// the assignment, so it has to happen after the bundle ran (same order as in the real page).
try {
    window.ytcfg = {
        data_: { HL: 'en', INNERTUBE_CLIENT_NAME: 'TVHTML5', INNERTUBE_CONTEXT: {} },
        get: (key) => (key === 'HL' ? 'en' : undefined),
        set: (values) => Object.assign(window.ytcfg.data_, values)
    }
} catch (err) {
    pageErrors.push('ytcfg bootstrap: ' + err.message)
}

// collect synthetic Starboard keys emitted by the glue.
// capture: true matters — the settings overlay swallows key events with stopImmediatePropagation()
// in the capture phase (settings/input.js:55-65), which is exactly what it does on device.
const starboardSeen = []
document.addEventListener('keydown', (event) => {
    if (event.__vtSynthetic) starboardSeen.push('keydown:' + event.keyCode)
}, true)
document.addEventListener('keyup', (event) => {
    if (event.__vtSynthetic) starboardSeen.push('keyup:' + event.keyCode)
}, true)

// simulate a D-pad press the way Android delivers it (plain ArrowUp)
window.setTimeout(() => {
    const event = new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    const up = new window.KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true, cancelable: true })
    document.dispatchEvent(up)
}, 300)

await new Promise((resolve) => setTimeout(resolve, 2000))

check('bundle evaluates without a top-level throw', !evalError, evalError ? evalError.stack : '')
check('window.__vtLoaded', window.__vtLoaded === true)
check('JSON.parse hook installed', window.JSON.parse !== nativeJsonParse)
check('XMLHttpRequest replaced', window.XMLHttpRequest !== nativeXhr)
check('window.h5vcc installed', !!window.h5vcc && !!window.h5vcc.dial && !!window.h5vcc.runtime && !!window.h5vcc.system)

let maxResolution = null
try { maxResolution = window.h5vcc.system.getVideoContainerSizeOverride() } catch (err) { pageErrors.push('getVideoContainerSizeOverride: ' + err.message) }
check('h5vcc.system.getVideoContainerSizeOverride returns WxH', typeof maxResolution === 'string' && /^\d+x\d+$/.test(maxResolution), maxResolution)

// adblock: the JSON.parse modifier empties ad payloads (modules/adblock.js:49-61)
let adblockResult = null
try {
    const parsed = window.JSON.parse('{"adPlacements":[{"ad":"x"}],"adSlots":[1],"other":1}')
    adblockResult = parsed
} catch (err) { pageErrors.push('adblock probe: ' + err.message) }
check('adblock empties adPlacements/adSlots in parsed JSON',
    adblockResult && Array.isArray(adblockResult.adPlacements) && adblockResult.adPlacements.length === 0
    && Array.isArray(adblockResult.adSlots) && adblockResult.adSlots.length === 0 && adblockResult.other === 1,
    JSON.stringify(adblockResult))

check('settings overlay root created', !!document.getElementById('vt-settings-overlay-root'))
check('settings overlay rendered tabs from bundled locale', document.querySelectorAll('#vt-settings-overlay-root .vt-tab').length > 0,
    document.querySelectorAll('#vt-settings-overlay-root .vt-tab').length + ' tabs')
check('preload/style.css injected via virtual fs', !!document.getElementById('vt-patches'))
check('settings stylesheet injected via virtual fs', !!document.querySelector('style[id^="vt-settings"]'))

const fullBleed = document.getElementById('vt-android-fullbleed')
check('full-bleed stage style injected', !!fullBleed)
check('full-bleed anchors the stage and the background layer',
    !!fullBleed && fullBleed.textContent.includes('div#container')
    && fullBleed.textContent.includes('div#app-background')
    && fullBleed.textContent.includes('100vw'))
check('android settings button installed', !!document.getElementById('vt-android-settings-button'))
check('window.vtToggleSettingsOverlay exposed', typeof window.vtToggleSettingsOverlay === 'function')
check('native bridge received get-config', bridge.__calls.some((c) => c.channel === 'get-config'))
check('DIAL requested the native transport', bridge.__calls.some((c) => c.kind === 'dialStart'))

let dialResult = null
try { dialResult = window.__vtDialDispatch('YouTube', 'POST', '/', '') } catch (err) { pageErrors.push('dialDispatch: ' + err.message) }
check('__vtDialDispatch answers (404 with no app routes)', typeof dialResult === 'string' && dialResult.includes('404'), dialResult)

check('D-pad ArrowUp translated to Starboard 32785/32786', starboardSeen.includes('keydown:32785') && starboardSeen.includes('keyup:32785'), starboardSeen.join(' '))

// config write path: click a real toggle row in the ported settings overlay and let it travel
// through settings/input.js -> settings/render.js -> configManager.set -> ipcRenderer.sendSync.
let configWriteOk = false
let toggledKey = null
try {
    const before = JSON.stringify(bridge.__config)
    window.vtToggleSettingsOverlay()
    await new Promise((resolve) => setTimeout(resolve, 250)) // input.js ignores clicks for 100ms after opening
    const toggle = document.querySelector('#vt-settings-overlay-root .vt-toggle')
    const target = toggle ? (toggle.closest('.vt-focusable') || toggle) : null
    if (target) {
        target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
        await new Promise((resolve) => setTimeout(resolve, 300))
    }
    configWriteOk = bridge.__calls.some((c) => c.channel === 'set-config' && c.arg)
    const after = JSON.stringify(bridge.__config)
    if (configWriteOk && before !== after) toggledKey = 'config changed'
    check('settings overlay toggle writes config through the bridge', configWriteOk, target ? target.className : 'no toggle row found')
    check('config value actually changed', before !== after)
} catch (err) {
    pageErrors.push('config write: ' + err.message)
    check('settings overlay toggle writes config through the bridge', false, err.message)
    check('config value actually changed', false)
}

// ---------- Android soft keyboard (IME) bridge ----------
check('keyboard button installed', !!document.getElementById('vt-android-keyboard-button'))
check('__vtOpenIme exposed', typeof window.__vtOpenIme === 'function')

const field = document.createElement('input')
field.type = 'search'
document.body.appendChild(field)
const openResult = window.__vtOpenIme()
check('__vtOpenIme focuses a page field and asks for the WebView IME',
    openResult === 'field' && bridge.__keyboard.includes('webview'), openResult + ' / ' + bridge.__keyboard.join(','))

let inputEvents = 0
field.addEventListener('input', () => inputEvents++)
window.__vtInjectText('va')
window.__vtInjectText('cuum')
check('__vtInjectText types into the focused field', field.value === 'vacuum', field.value)
check('__vtInjectText dispatches input events', inputEvents >= 2, String(inputEvents))
window.__vtBackspace()
check('__vtBackspace deletes the last character', field.value === 'vacuu', field.value)

// Nothing editable left: Leanback's own letter grid must be clicked instead.
field.disabled = true
const grid = document.createElement('div')
document.body.appendChild(grid)
const clickedLetters = []
for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    const key = document.createElement('div')
    key.textContent = letter
    key.addEventListener('click', () => clickedLetters.push(letter))
    grid.appendChild(key)
}
const sinkCalls = () => bridge.__keyboard.filter((k) => k === 'sink').length
const beforeSink = sinkCalls()
const injectedMode = window.__vtInjectText('abc')
check('__vtInjectText falls back to clicking the TV keyboard grid',
    injectedMode === 'keys' && clickedLetters.join('') === 'abc', injectedMode + ' -> ' + clickedLetters.join(''))
const sinkResult = window.__vtOpenIme()
check('__vtOpenIme uses the native sink when nothing editable exists',
    sinkResult === 'sink' && sinkCalls() > beforeSink, sinkResult)
window.__vtEnter()
check('__vtEnter emits Starboard select (32768)', starboardSeen.includes('keydown:32768'), starboardSeen.join(' '))

// ---------- display fixes, settings entry row, button activation ----------
check('video-fill style injected', !!document.getElementById('vt-android-videofill'))

const landscape = document.createElement('video')
Object.defineProperty(landscape, 'videoWidth', { value: 1920 })
Object.defineProperty(landscape, 'videoHeight', { value: 1080 })
document.body.appendChild(landscape)
const portrait = document.createElement('video')
Object.defineProperty(portrait, 'videoWidth', { value: 720 })
Object.defineProperty(portrait, 'videoHeight', { value: 1280 })
document.body.appendChild(portrait)
window.__vtApplyVideoFill()
check('landscape video is cropped to fill the player', landscape.classList.contains('vt-android-video-fill'))
check('portrait video (Shorts) is left contained', !portrait.classList.contains('vt-android-video-fill'))

// A video can sit off-centre when an ancestor is offset; only wrong ancestors may be touched.
const stage = document.createElement('div')
stage.__vtTestRect = [140, 0, 744, 393]
const wrapper = document.createElement('div')
wrapper.__vtTestRect = [140, 0, 744, 393]
const offsetVideo = document.createElement('video')
Object.defineProperty(offsetVideo, 'videoWidth', { value: 1920 })
Object.defineProperty(offsetVideo, 'videoHeight', { value: 1080 })
offsetVideo.__vtTestRect = [140, 0, 744, 419]
wrapper.appendChild(offsetVideo)
stage.appendChild(wrapper)
document.body.appendChild(stage)
window.__vtApplyVideoFill()
check('off-centre ancestors of the video are neutralised',
    parseFloat(stage.style.getPropertyValue('left')) === 0 && wrapper.style.getPropertyValue('width') === '100vw',
    'stage.left=' + stage.style.getPropertyValue('left') + ' wrapper.width=' + wrapper.style.getPropertyValue('width'))
check('video geometry is reported in the diagnostics', String(window.__vtDiagnostics()).indexOf('vid=1920x1080') >= 0,
    String(window.__vtDiagnostics()))

// Settings that only affect future responses need one reload, otherwise they look inert.
bridge.sendSync('set-config', JSON.stringify({ hide_shorts: true }))
await new Promise((resolve) => setTimeout(resolve, 150))
bridge.sendSync('set-config', JSON.stringify({ hide_shorts: false }))
await new Promise((resolve) => setTimeout(resolve, 2200))
check('a feed-affecting setting change asks the host to reload',
    bridge.__calls.some((call) => call.kind === 'invoke' && call.channel === 'reload'),
    bridge.__calls.filter((call) => call.kind === 'invoke').map((call) => call.channel).join(','))

// Native -> page events must reach the ported modules (the config-update round trip is what makes a
// toggle render its new state and lets sponsorblock/userstyles/ultrawide react live). The glue counts
// the events it receives, which also shows up in the on-device diagnostics.
const updatesBefore = Number((String(window.__vtDiagnostics()).match(/updates=(\d+)/) || [])[1])
bridge.sendSync('set-config', JSON.stringify({ adblock: !(bridge.__config.adblock !== false) }))
await new Promise((resolve) => setTimeout(resolve, 400))
const diagnosticsAfter = String(window.__vtDiagnostics())
const updatesAfter = Number((diagnosticsAfter.match(/updates=(\d+)/) || [])[1])
check('a host-side config change reaches the page (config-update delivered)',
    updatesAfter > updatesBefore, 'updates ' + updatesBefore + ' -> ' + updatesAfter + ' | ' + diagnosticsAfter)
check('runtime diagnostics available', typeof window.__vtDiagnostics === 'function'
    && String(window.__vtDiagnostics()).indexOf('stage=') >= 0, String(window.__vtDiagnostics()))

const overlayRoot = document.getElementById('vt-settings-overlay-root')
const overlayVisible = () => !!overlayRoot && !overlayRoot.classList.contains('vt-settings-hidden')
if (overlayVisible()) window.__vtToggleSettings()
await new Promise((resolve) => setTimeout(resolve, 200))

// The row leanback-settings.js injects into YouTube's own settings screen.
const row = document.createElement('button')
row.textContent = 'Open VacuumTube Settings'
document.body.appendChild(row)
row.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
await new Promise((resolve) => setTimeout(resolve, 250))
check('"Open VacuumTube Settings" row opens the overlay', overlayVisible())

// A tap arrives as touch events plus compatibility mouse events; it must act once, not twice.
if (overlayVisible()) window.__vtToggleSettings()
await new Promise((resolve) => setTimeout(resolve, 200))
const gear = document.getElementById('vt-android-settings-button')
gear.dispatchEvent(new window.Event('touchstart', { bubbles: true, cancelable: true }))
gear.dispatchEvent(new window.Event('touchend', { bubbles: true, cancelable: true }))
gear.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
gear.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((resolve) => setTimeout(resolve, 250))
check('one tap on the gear opens settings (no touch+mouse double fire)', overlayVisible())

// ---------- error visibility + fallback settings panel ----------
const rejection = new window.Event('unhandledrejection')
rejection.reason = new Error('boom-from-test')
window.dispatchEvent(rejection)
check('async page errors are captured for the diagnostics',
    String(window.__vtDiagnostics()).indexOf('boom-from-test') >= 0,
    String(window.__vtDiagnostics()).slice(-80))

if (document.getElementById('vt-android-fallback-settings')) window.__vtToggleSettings()
const fallbackOpened = window.__vtFallbackSettings()
const fallbackRoot = document.getElementById('vt-android-fallback-settings')
check('fallback settings panel opens', fallbackOpened === true && !!fallbackRoot)

const setConfigCalls = () => bridge.__calls.filter((call) => call.channel === 'set-config').length
const callsBefore = setConfigCalls()
let clickedFallbackRow = false
if (fallbackRoot) {
    const card = fallbackRoot.firstElementChild
    const lines = card ? [...card.children].filter((node) => node.style.display === 'flex') : []
    if (lines.length) {
        lines[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        clickedFallbackRow = true
    }
}
await new Promise((resolve) => setTimeout(resolve, 250))
check('a fallback row toggles config through the bridge',
    clickedFallbackRow && setConfigCalls() > callsBefore, 'set-config calls ' + callsBefore + ' -> ' + setConfigCalls())
check('diagnostics can be surfaced as a toast', typeof window.__vtShowDiagnostics() === 'string')
if (document.getElementById('vt-android-fallback-settings')) window.__vtToggleSettings()
check('fallback panel closes again', !document.getElementById('vt-android-fallback-settings'))

const failed = results.filter((r) => !r.pass)
console.log('')
console.log('=== VacuumTube-Android bundle smoke test ===')
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`)
console.log('')
console.log(`checks: ${results.length - failed.length}/${results.length} passed`)
if (moduleFailures.length) {
    console.log(`modules that reported a load failure in jsdom (expected for browser-only APIs): ${moduleFailures.length}`)
    for (const line of moduleFailures) console.log('  - ' + line.slice(0, 200))
}
if (pageErrors.length) {
    console.log(`page errors captured: ${pageErrors.length}`)
    for (const line of pageErrors.slice(0, 12)) console.log('  - ' + line.slice(0, 300))
}
const vtLogs = log.filter((l) => l.includes('[vt]') || l.includes('toast') || l.includes('warn') || l.includes('[h5vcc]'))
if (vtLogs.length) {
    console.log('page log (filtered):')
    for (const line of vtLogs.slice(0, 25)) console.log('  - ' + line.slice(0, 220))
}
process.exit(failed.length ? 1 : 0)
