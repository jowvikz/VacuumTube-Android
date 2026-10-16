// Two questions from device feedback, answered against the live page:
//   1. why does the video keep a border on one side (what is the video's ancestor chain?)
//   2. do the VacuumTube settings toggles actually write config and flip in the UI?
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

const VIEWPORT = { width: 1560, height: 720 }
const COBALT_UA = 'Mozilla/5.0 (Linux; Android 14) Cobalt/27.lts.3.1040976-gold (unlike Gecko) v8/13.8.258.54-jit gles Starboard/18, '
    + `VacuumTube_DESKTOP_arm64_${new Date().getFullYear()}/2.0.0-android (VacuumTube, Android) rocks.shy.vacuumtube.android/2.0.0-android`

const CONFIG = {
    adblock: true,
    hide_shorts: false,
    fullscreen: true,
    touch_overlay: false,
    controller_support: false,
    device_discoverability: false,
    userstyles: false,
    disabled_userstyles: [],
    disabled_tabs: [],
    android_full_bleed: true,
    android_video_fill: true
}

const bridgeScript = `
window.__vtProbeConfig = ${JSON.stringify(CONFIG)};
window.__vtProbeCalls = [];
window.VacuumTube = {
  sendSync: function (channel, arg) {
    window.__vtProbeCalls.push('sendSync:' + channel + (arg ? ':' + arg.slice(0, 120) : ''));
    if (channel === 'get-config') return JSON.stringify(window.__vtProbeConfig);
    if (channel === 'set-config') {
      var patch = arg ? JSON.parse(arg) : {};
      for (var key in patch) window.__vtProbeConfig[key] = patch[key];
      var merged = JSON.stringify(window.__vtProbeConfig);
      setTimeout(function () { if (window.__vtEmit) window.__vtEmit('config-update', merged); }, 0);
      return merged;
    }
    if (channel === 'can-auto-update') return 'false';
    return 'null';
  },
  invoke: function (channel, arg, id) {
    var value = channel === 'is-steam' ? false : null;
    setTimeout(function () { if (window.__vtResolve) window.__vtResolve(id, JSON.stringify(value)); }, 0);
  },
  send: function () {},
  deviceName: function () { return 'probe'; }, deviceRelease: function () { return '14'; },
  deviceArch: function () { return 'arm64'; }, appVersion: function () { return '2.0.0-android'; },
  getStarboardInput: function () { return 'true'; }, setStarboardInput: function () {},
  toast: function (m) { window.__vtProbeCalls.push('toast:' + m); },
  openExternal: function () {}, setClipboard: function () {}, getClipboard: function () { return ''; },
  randomUUID: function () { return '11111111-2222-4333-8444-555555555555'; },
  showKeyboard: function () {}, showKeyboardSink: function () {}, hideKeyboard: function () {},
  dialStart: function () {}, dialStop: function () {}, exitApp: function () {},
  log: function (tag, m) { window.__vtProbeCalls.push('log:' + tag + ':' + m); }
};
`

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
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        })
        request.on('error', reject)
        request.end()
    })
}

function injectBundle(html, code) {
    const tag = '<script>' + code + '</script>'
    const head = html.toLowerCase().indexOf('<head')
    if (head >= 0) {
        const end = html.indexOf('>', head)
        if (end > 0) return html.slice(0, end + 1) + tag + html.slice(end + 1)
    }
    return tag + html
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] })
const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    hasTouch: true,
    userAgent: COBALT_UA,
    extraHTTPHeaders: {
        'sec-ch-ua': '"VacuumTube";v="27"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Starboard"'
    }
})
await context.route('**/*', async (route) => {
    const request = route.request()
    if (request.resourceType() !== 'document' || !/youtube\.com/.test(request.url())) {
        await route.continue()
        return
    }
    try {
        const document = await fetchDocument(request.url())
        await route.fulfill({
            status: document.status,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: injectBundle(document.body, bundle)
        })
    } catch (err) {
        await route.continue()
    }
})
await context.addInitScript(bridgeScript)
const page = await context.newPage()
page.on('pageerror', (error) => console.log('  page error:', String(error).slice(0, 160)))

await page.goto('https://www.youtube.com/tv', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(9000)

// ---------------------------------------------------------------- 1. settings toggles
const overlayState = () => page.evaluate(() => {
    const root = document.getElementById('vt-settings-overlay-root')
    return { present: !!root, visible: root ? !root.classList.contains('vt-settings-hidden') : false }
})

await page.evaluate(() => window.vtOpenSettingsOverlay && window.vtOpenSettingsOverlay())
await page.waitForTimeout(900)

const toggleResult = await page.evaluate(async () => {
    const before = JSON.parse(JSON.stringify(window.__vtProbeConfig))
    const rows = [...document.querySelectorAll('#vt-settings-overlay-root .vt-row')]
    const target = rows.find((row) => /shorts/i.test(row.textContent || '')) || rows[0]
    const focusable = target ? (target.closest('.vt-focusable') || target) : null
    const pillBefore = target ? (target.querySelector('.vt-toggle') || {}).className : null
    if (focusable) focusable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const again = [...document.querySelectorAll('#vt-settings-overlay-root .vt-row')]
    const after = again.find((row) => /shorts/i.test(row.textContent || '')) || again[0]
    const setConfigCalls = (window.__vtProbeCalls || []).filter((call) => call.indexOf('sendSync:set-config') === 0)
    return {
        rowText: target ? (target.textContent || '').slice(0, 60) : null,
        pillBefore,
        pillAfter: after ? (after.querySelector('.vt-toggle') || {}).className : null,
        configBefore: before,
        configAfter: JSON.parse(JSON.stringify(window.__vtProbeConfig)),
        setConfigCalls: setConfigCalls.slice(0, 3)
    }
})
console.log('\n== settings toggle test ==')
console.log('row:', toggleResult.rowText)
console.log('pill class before/after:', toggleResult.pillBefore, '->', toggleResult.pillAfter)
console.log('set-config calls:', JSON.stringify(toggleResult.setConfigCalls))
const changedKeys = Object.keys(toggleResult.configAfter).filter((key) => JSON.stringify(toggleResult.configBefore[key]) !== JSON.stringify(toggleResult.configAfter[key]))
console.log('config keys changed:', JSON.stringify(changedKeys), 'hide_shorts now:', toggleResult.configAfter.hide_shorts)
await page.screenshot({ path: path.join(out, 'settings-toggle.png') })

// ---------------------------------------------------------------- 2. video element chain
for (const url of ['https://www.youtube.com/tv#/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(9000)
    const video = await page.evaluate(() => {
        const videos = [...document.querySelectorAll('video')]
        const info = videos.map((video) => {
            const chain = []
            let node = video
            for (let depth = 0; node && depth < 7; depth++) {
                const rect = node.getBoundingClientRect()
                const style = getComputedStyle(node)
                chain.push({
                    tag: node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (node.className && node.className.toString ? '.' + node.className.toString().split(' ').slice(0, 3).join('.') : ''),
                    rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
                    left: style.left,
                    marginLeft: style.marginLeft,
                    transform: style.transform === 'none' ? undefined : style.transform,
                    position: style.position,
                    objectFit: style.objectFit,
                    width: style.width,
                    height: style.height
                })
                node = node.parentElement
            }
            return {
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                hasFillClass: video.classList.contains('vt-android-video-fill'),
                rect: (() => { const r = video.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })(),
                chain
            }
        })
        return { count: videos.length, viewport: [window.innerWidth, window.innerHeight], info }
    })
    console.log(`\n== video probe after ${url} ==`)
    console.log('videos:', video.count, 'viewport:', video.viewport)
    for (const item of video.info) {
        console.log(`video ${item.videoWidth}x${item.videoHeight} fill=${item.hasFillClass} rect=${JSON.stringify(item.rect)}`)
        for (const [index, node] of item.chain.entries()) {
            console.log(`   ${'  '.repeat(index)}${node.tag} rect=${JSON.stringify(node.rect)} left=${node.left} ml=${node.marginLeft} pos=${node.position} w=${node.width} h=${node.height} fit=${node.objectFit}${node.transform ? ' transform=' + node.transform : ''}`)
        }
    }
    await page.screenshot({ path: path.join(out, 'video-' + url.replace(/[^a-z0-9]/gi, '').slice(-24) + '.png') })
    if (video.count > 0) break
}

await browser.close()
console.log('\ndone')
