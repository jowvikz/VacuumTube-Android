// Scratch harness used while wiring the Android keyboard bridge. Kept because it is the quickest
// way to check the glue's DOM helpers (open/inject/backspace/enter) in isolation.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const bundle = fs.readFileSync(path.join(root, 'app/src/main/assets/vt/preload.bundle.js'), 'utf8')

const vc = new VirtualConsole()
vc.on('jsdomError', (e) => console.log('JSDOM ERROR', e.message))
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>', {
    url: 'https://www.youtube.com/tv', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc
})
const w = dom.window
w.matchMedia = w.matchMedia || ((q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
w.navigator.getGamepads = () => []
w.MediaSource = w.MediaSource || class { static isTypeSupported() { return true } }
w.HTMLMediaElement.prototype.play = () => Promise.resolve()
w.fetch = () => Promise.reject(new Error('offline'))
w.Element.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, toJSON() { return this } } }
w.localStorage.setItem('yt.leanback.default::mdx-device-id', JSON.stringify({ data: 'x' }))
const calls = []
w.VacuumTube = {
    sendSync: () => 'null',
    invoke: () => {},
    deviceName: () => 'debug',
    showKeyboard: () => calls.push('webview'),
    showKeyboardSink: () => calls.push('sink'),
    hideKeyboard: () => calls.push('hide')
}

w.eval(bundle)

const seen = []
w.document.addEventListener('keydown', (e) => seen.push('keydown:' + e.keyCode + ' synthetic=' + !!e.__vtSynthetic), true)
w.document.addEventListener('keyup', (e) => seen.push('keyup:' + e.keyCode + ' synthetic=' + !!e.__vtSynthetic), true)

console.log('glue entry points:', ['__vtStarboardKey', '__vtEnter', '__vtOpenIme', '__vtInjectText', '__vtBackspace']
    .map((name) => name + '=' + typeof w[name]).join(' '))
console.log('__vtEnter() ->', w.__vtEnter && w.__vtEnter())
console.log('seen:', JSON.stringify(seen))

const field = w.document.createElement('input')
field.type = 'search'
w.document.body.appendChild(field)
console.log('__vtOpenIme() ->', w.__vtOpenIme(), 'native calls:', calls.join(','))
console.log('__vtInjectText("abc") ->', w.__vtInjectText('abc'), 'field.value=', field.value)
console.log('__vtBackspace() ->', w.__vtBackspace(), 'field.value=', field.value)

process.exit(0)
