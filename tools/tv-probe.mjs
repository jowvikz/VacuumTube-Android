// Runtime evidence for two device-reported problems, gathered against the real Leanback page:
//   1. which element letterboxes the TV UI on a 20:9 screen (the "borders")
//   2. what the search screen actually puts in the DOM (why the Android IME never appeared)
// Run: node tv-probe.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', 'build', 'tv-probe')
fs.mkdirSync(out, { recursive: true })

const COBALT_UA = 'Mozilla/5.0 (Linux; Android 14) Cobalt/27.lts.3.1040976-gold (unlike Gecko) v8/13.8.258.54-jit gles Starboard/18, '
    + `VacuumTube_DESKTOP_arm64_${new Date().getFullYear()}/2.0.0-android (VacuumTube, Android) rocks.shy.vacuumtube.android/2.0.0-android`

// A phone in landscape: 20:9 CSS pixels (2340x1080 at dpr 1.5 would be ~1560x720).
const VIEWPORT = { width: 1560, height: 720 }

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    userAgent: COBALT_UA,
    extraHTTPHeaders: {
        'sec-ch-ua': '"VacuumTube";v="27"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Starboard"'
    }
})
const page = await context.newPage()
page.on('console', (message) => {
    if (message.type() === 'error') console.log('  page error:', message.text().slice(0, 160))
})

console.log('viewport', VIEWPORT.width + 'x' + VIEWPORT.height, '(20:9)')
await page.goto('https://www.youtube.com/tv', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(9000)

const layout = await page.evaluate(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const offenders = []
    const nodes = document.querySelectorAll('body *')
    for (const el of nodes) {
        const rect = el.getBoundingClientRect()
        if (rect.width < vw * 0.97 && rect.width > vw * 0.4 && rect.height > vh * 0.5) {
            const style = getComputedStyle(el)
            offenders.push({
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                cls: el.className && el.className.toString ? el.className.toString().slice(0, 70) : undefined,
                rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
                cssWidth: style.width,
                maxWidth: style.maxWidth,
                minWidth: style.minWidth,
                aspectRatio: style.aspectRatio,
                padding: style.padding,
                margin: style.margin,
                position: style.position,
                transform: style.transform === 'none' ? undefined : style.transform
            })
        }
    }
    const inputs = [...document.querySelectorAll('input, textarea, [contenteditable]')].map((el) => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return {
            tag: el.tagName.toLowerCase(),
            type: el.type,
            id: el.id || undefined,
            cls: el.className && el.className.toString ? el.className.toString().slice(0, 60) : undefined,
            rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
            visible: rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.display !== 'none',
            placeholder: el.placeholder || undefined
        }
    })
    const wide = [...document.querySelectorAll('body *')].filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.width >= window.innerWidth * 0.97 && rect.height > window.innerHeight * 0.5
    }).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')).slice(0, 12)
    return {
        viewport: [vw, vh],
        documentScroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
        bodyScroll: [document.body.scrollWidth, document.body.clientWidth],
        htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        fullWidthContainers: wide,
        offenders,
        inputs
    }
})

console.log('\n== layout on a 20:9 screen ==')
console.log('document scroll/client width:', layout.documentScroll, ' body:', layout.bodyScroll)
console.log('html/body background:', layout.htmlBackground, '/', layout.bodyBackground)
console.log('containers already full width:', layout.fullWidthContainers.join(', ') || '(none)')
console.log('\nelements narrower than the screen but taller than half of it (the letterbox candidates):')
for (const item of layout.offenders.slice(0, 25)) {
    console.log(`  ${item.tag}${item.id ? '#' + item.id : ''}${item.cls ? '.' + item.cls.split(' ').join('.') : ''} rect=${JSON.stringify(item.rect)} width=${item.cssWidth} max-width=${item.maxWidth} aspect=${item.aspectRatio} pad=${item.padding} pos=${item.position}${item.transform ? ' transform=' + item.transform : ''}`)
}
console.log('\ninputs on the home screen:', JSON.stringify(layout.inputs))

await page.screenshot({ path: path.join(out, 'home-20x9.png') })
console.log('\nscreenshot:', path.join(out, 'home-20x9.png'))

// Try to reach the search surface and inspect what it exposes (that is where the IME should appear).
for (const hash of ['#/search', '#search', '/tv#/search']) {
    try {
        await page.goto('https://www.youtube.com' + (hash.startsWith('/tv') ? hash : '/tv' + hash), { waitUntil: 'domcontentloaded', timeout: 60000 })
    } catch (err) {
        console.log('navigation failed for', hash, err.message.slice(0, 120))
        continue
    }
    await page.waitForTimeout(6000)
    const state = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll('input, textarea, [contenteditable]')].map((el) => {
            const rect = el.getBoundingClientRect()
            const style = getComputedStyle(el)
            return {
                tag: el.tagName.toLowerCase(),
                type: el.type,
                id: el.id || undefined,
                cls: el.className && el.className.toString ? el.className.toString().slice(0, 60) : undefined,
                rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
                opacity: style.opacity,
                visible: rect.width > 2 && rect.height > 2
            }
        })
        // Is there a letter-grid style keyboard on screen?
        const singleCharLeaves = [...document.querySelectorAll('div, span, button')]
            .filter((el) => !el.children.length && (el.textContent || '').trim().length === 1)
            .map((el) => (el.textContent || '').trim())
        return {
            hash: location.hash,
            activeElement: document.activeElement ? document.activeElement.tagName + (document.activeElement.id ? '#' + document.activeElement.id : '') : null,
            inputs,
            singleCharLeaves: singleCharLeaves.length,
            sampleKeys: singleCharLeaves.slice(0, 12).join(''),
            bodyText: (document.body.innerText || '').slice(0, 200).replace(/\s+/g, ' ')
        }
    })
    console.log(`\n== after ${hash} ==`)
    console.log('hash:', state.hash, '| activeElement:', state.activeElement)
    console.log('inputs:', JSON.stringify(state.inputs))
    console.log('single-char leaves:', state.singleCharLeaves, state.sampleKeys ? `(${state.sampleKeys})` : '')
    console.log('body text:', state.bodyText)
    await page.screenshot({ path: path.join(out, 'search-' + hash.replace(/[^a-z]/gi, '') + '.png') })
    break
}

await browser.close()
console.log('\ndone')
