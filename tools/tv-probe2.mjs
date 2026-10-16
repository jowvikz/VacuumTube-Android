// Determines how the Leanback TV surface sizes itself, and which repair actually removes the side
// borders on a 20:9 screen. Produces screenshots so the result can be judged visually.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', 'build', 'tv-probe')
fs.mkdirSync(out, { recursive: true })

const COBALT_UA = 'Mozilla/5.0 (Linux; Android 14) Cobalt/27.lts.3.1040976-gold (unlike Gecko) v8/13.8.258.54-jit gles Starboard/18, '
    + `VacuumTube_DESKTOP_arm64_${new Date().getFullYear()}/2.0.0-android (VacuumTube, Android) rocks.shy.vacuumtube.android/2.0.0-android`

// The CSS the shipped app injects for its "Ultrawide Support" feature (vendor/.../modules/ultrawide.js)
const ULTRAWIDE_CSS = `
div#container,
yt-virtual-list,
ytlr-section-list-renderer,
ytlr-horizontal-list-renderer,
ytlr-tv-surface-content-renderer,
div[idomkey="shadow"],
ytlr-two-column-renderer,
yt-route,
ytlr-welcome-immersive-value-prop
{
    width: 100vw !important;
    max-width: 100vw !important;
    box-sizing: border-box !important;
    min-width: 100vw !important;
}`

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })

async function open(width, height) {
    const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
        userAgent: COBALT_UA,
        extraHTTPHeaders: {
            'sec-ch-ua': '"VacuumTube";v="27"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Starboard"'
        }
    })
    // Same job the Android client does in VTWebViewClient: drop the response CSP so injected <style>
    // is honoured (and, incidentally, prove that the stock CSP really does block it).
    await context.route('**/*', async (route) => {
        try {
            const response = await route.fetch()
            const headers = { ...response.headers() }
            delete headers['content-security-policy']
            delete headers['content-security-policy-report-only']
            await route.fulfill({ response, headers })
        } catch (err) {
            await route.continue()
        }
    })
    const page = await context.newPage()
    // Style injection is CSP-gated; the Android client solves that by rewriting the header, the probe
    // just bypasses it (and the stock run above proved the gate is real).
    const cdp = await context.newCDPSession(page)
    await cdp.send('Page.setBypassCSP', { enabled: true })
    await page.goto('https://www.youtube.com/tv', { waitUntil: 'domcontentloaded', timeout: 90000 })
    await page.waitForTimeout(8000)
    return { context, page }
}

/** Which CSS rules decide the stage size? */
const findStageRules = (page) => page.evaluate(() => {
    const hits = []
    for (const sheet of document.styleSheets) {
        let rules
        try {
            rules = sheet.cssRules
        } catch (err) {
            continue
        }
        for (const rule of rules) {
            if (!rule.selectorText || !rule.style) continue
            if (!/#container|#app-background|app-background-container|tv-surface-content/.test(rule.selectorText)) continue
            const interesting = ['width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'aspect-ratio', 'left', 'right', 'margin', 'position']
            const declared = {}
            for (const property of interesting) {
                const value = rule.style.getPropertyValue(property)
                if (value) declared[property] = value
            }
            if (Object.keys(declared).length) hits.push({ selector: rule.selectorText.slice(0, 160), declared })
        }
    }
    return hits.slice(0, 25)
})

const measure = (page) => page.evaluate(() => {
    const pick = (selector) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return {
            rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
            inline: (el.getAttribute('style') || '').slice(0, 200),
            cssWidth: style.width,
            transform: style.transform,
            parentTransform: el.parentElement ? getComputedStyle(el.parentElement).transform : null
        }
    }
    return {
        viewport: [window.innerWidth, window.innerHeight],
        screen: [window.screen.width, window.screen.height],
        dpr: window.devicePixelRatio,
        container: pick('div#container'),
        background: pick('div#app-background'),
        route: pick('yt-route'),
        home: pick('ytlr-welcome'),
        scaledAncestors: (() => {
            const found = []
            for (const el of document.querySelectorAll('body *')) {
                const transform = getComputedStyle(el).transform
                if (transform && transform !== 'none' && transform.indexOf('matrix') === 0) {
                    const parts = transform.replace(/matrix\(|\)/g, '').split(',').map(Number)
                    if (parts.length >= 4 && Math.abs(parts[0] - 1) > 0.01) {
                        found.push({ tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), transform })
                    }
                }
            }
            return found.slice(0, 8)
        })()
    }
})

const report = async (label, page, shot) => {
    const data = await measure(page)
    console.log(`\n== ${label} ==`)
    console.log(`viewport ${data.viewport} screen ${data.screen} dpr ${data.dpr}`)
    console.log(`#container      rect=${JSON.stringify(data.container && data.container.rect)} cssWidth=${data.container && data.container.cssWidth} inline="${data.container && data.container.inline}"`)
    console.log(`#app-background rect=${JSON.stringify(data.background && data.background.rect)} cssWidth=${data.background && data.background.cssWidth} inline="${data.background && data.background.inline}"`)
    console.log(`yt-route        rect=${JSON.stringify(data.route && data.route.rect)} cssWidth=${data.route && data.route.cssWidth}`)
    console.log(`ytlr-welcome    rect=${JSON.stringify(data.home && data.home.rect)}`)
    console.log(`non-identity transforms: ${JSON.stringify(data.scaledAncestors)}`)
    if (shot) await page.screenshot({ path: path.join(out, shot) })
    return data
}

// 1) reference: what the app does per viewport
for (const [w, h, label] of [[1560, 720, 'stock-20x9'], [1280, 720, 'stock-16x9'], [1920, 1080, 'stock-fhd']]) {
    const { context, page } = await open(w, h)
    await report(label, page, label + '.png')
    if (label === 'stock-20x9') {
        const rules = await findStageRules(page)
        console.log('\nCSS rules that size the stage:')
        for (const rule of rules) console.log('  ' + rule.selector + '  ' + JSON.stringify(rule.declared))
    }
    await context.close()
}

// 2) repair candidates on the 20:9 screen
// Full-bleed: every element the app pins to the 80rem (16:9) stage, plus the background layer that
// the shipped ultrawide feature forgets about (#app-background is not in its selector list).
const FULL_BLEED_CSS = `
div#container,
div#app-background,
ytlr-app-background-container,
yt-route {
    width: 100vw !important;
    min-width: 100vw !important;
    max-width: 100vw !important;
    left: 0 !important;
    right: auto !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    box-sizing: border-box !important;
}`

const candidates = [
    ['a-ultrawide-feature', ULTRAWIDE_CSS, null],
    ['b-full-bleed', FULL_BLEED_CSS + ULTRAWIDE_CSS, null],
    ['c-native-stretch-sim', '', (vw) => `div#container, div#app-background { transform: scaleX(${(vw / 1280).toFixed(4)}) !important; transform-origin: center center !important; width: 100vw !important; }`]
]

for (const [label, css, styleFn] of candidates) {
    const { context, page } = await open(1560, 720)
    const viewport = await page.evaluate(() => ({ vw: window.innerWidth, vh: window.innerHeight }))
    if (css) await page.addStyleTag({ content: css })
    if (styleFn) await page.addStyleTag({ content: styleFn(viewport.vw) })
    await page.waitForTimeout(1200)
    await report(label, page, label + '.png')
    await context.close()
}

await browser.close()
console.log('\nscreenshots in', out)
