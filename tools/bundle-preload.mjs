// VacuumTube-Android — preload bundler.
//
// Takes the reverse-engineered preload tree (src/preload/**, extracted from the shipped
// resources/app.asar) and emits one page-world script that the Android WebView injects at
// document-start, recreating what Electron's preload + main process did:
//   * a virtual filesystem for the assets the tree reads with fs/path/__dirname
//   * CommonJS loading of all 70 modules, in the packaged app.asar directory order
//   * shims for the Electron/Node APIs the tree uses (census.md §3)
//   * native DIAL transport replacements for the three socket-owning modules (census.md §1.4)
//   * android-glue.js, the only new page-side code (input/client-hints/settings entry)
// Module bodies are embedded VERBATIM; only the three DIAL modules are substituted.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const VENDOR = process.env.VT_PRELOAD_SRC ? path.resolve(process.env.VT_PRELOAD_SRC) : path.join(root, 'vendor', 'vacuumtube-preload')
const OUT = process.env.VT_BUNDLE_OUT ? path.resolve(process.env.VT_BUNDLE_OUT) : path.join(root, 'app', 'src', 'main', 'assets', 'vt', 'preload.bundle.js')
const MANIFEST = path.join(root, 'build', 'bundle-manifest.json')

const VROOT = '/vt'

const SHIM_MODULES = {
    electron: 'shims/electron.js',
    fs: 'shims/fs.js',
    path: 'shims/path.js',
    os: 'shims/os.js',
    crypto: 'shims/crypto.js',
    events: 'shims/events.js'
}

// Modules whose implementation cannot run in a page (they own sockets) — replaced by
// native-transport shims. See census.md §1.4 and §6.4.
const OVERRIDES = {
    [`${VROOT}/src/preload/modules/h5vcc/dial/http.js`]: 'shims/dial-http.js',
    [`${VROOT}/src/preload/modules/h5vcc/dial/server.js`]: 'shims/dial-server.js',
    [`${VROOT}/src/preload/modules/h5vcc/dial/discover.js`]: 'shims/dial-discover.js'
}

function walk(dir, base = '') {
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? base + '/' + entry.name : entry.name
        if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel))
        else out.push(rel)
    }
    return out
}

const virtualPath = (rel) => VROOT + '/' + rel.split(path.sep).join('/')

function jsString(value) {
    // Safe as an inline <script> body: '<' never appears raw inside the emitted string literals.
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function read(file) {
    return fs.readFileSync(file, 'utf8')
}

if (!fs.existsSync(path.join(VENDOR, 'src', 'preload', 'index.js'))) {
    console.error(`[bundle] preload sources not found at ${VENDOR}`)
    process.exit(1)
}

// ---------------------------------------------------------------- collect inputs
const files = walk(VENDOR)
const assets = {}
const modules = {}
const skipped = []
let cssBytes = 0
let localeBytes = 0

for (const rel of files) {
    const id = virtualPath(rel)
    const abs = path.join(VENDOR, rel)
    const ext = path.extname(rel).toLowerCase()
    const isPreloadJs = id.startsWith(`${VROOT}/src/preload/`) && ext === '.js'
    const isPackageJson = rel === 'package.json'

    if (ext === '.png') {
        assets[id] = { base64: fs.readFileSync(abs).toString('base64') }
        continue
    }
    if (ext === '.css') {
        const text = read(abs)
        assets[id] = { text }
        cssBytes += text.length
        continue
    }
    if (ext === '.json') {
        const text = read(abs)
        assets[id] = { text }
        if (id.startsWith(`${VROOT}/locale/`)) localeBytes += text.length
        if (isPackageJson) {
            modules[id] = `module.exports = ${jsString(JSON.parse(text))}\n`
        }
        continue
    }
    if (ext === '.js') {
        if (!isPreloadJs) { skipped.push(rel); continue }
        if (OVERRIDES[id]) continue // replaced below
        modules[id] = read(abs)
        continue
    }
    skipped.push(rel)
}

for (const [id, shimFile] of Object.entries(OVERRIDES)) {
    modules[id] = read(path.join(here, shimFile))
}
modules[`${VROOT}/android-glue.js`] = read(path.join(here, 'android-glue.js'))

// ---------------------------------------------------------------- directory listings (readdir emulation)
let dirs = {}
const orderFile = path.join(VENDOR, '.readdir-order.json')
if (fs.existsSync(orderFile)) {
    dirs = JSON.parse(read(orderFile))
} else {
    for (const dir of [`${VROOT}/src/preload/modules`, `${VROOT}/src/preload`, `${VROOT}/locale`]) {
        dirs[dir] = []
    }
    for (const id of Object.keys(assets)) {
        const parent = id.slice(0, id.lastIndexOf('/'))
        const name = id.slice(id.lastIndexOf('/') + 1)
        if (dirs[parent]) dirs[parent].push({ name, dir: false })
    }
    for (const list of Object.values(dirs)) list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

// ---------------------------------------------------------------- emit
const prelude = read(path.join(here, 'runtime-prelude.js'))
const shims = {}
for (const [name, file] of Object.entries(SHIM_MODULES)) shims[name] = read(path.join(here, file))

const parts = []
const sourceSha = crypto.createHash('sha256')

parts.push(`/* VacuumTube-Android — generated preload bundle. DO NOT EDIT.
 * Source: resources/app.asar of VacuumTube 2.0.0 (${VENDOR.replace(/\\/g, '/')})
 * Generated: ${new Date().toISOString()}
 * Modules embedded verbatim: ${Object.keys(modules).length - Object.keys(OVERRIDES).length - 1} (+ ${Object.keys(OVERRIDES).length} native-DIAL replacements + 1 android glue)
 * See tools/bundle-preload.mjs and rea-work/census.md for the mapping. */`)
parts.push('(function () {')
// No 'use strict' on purpose: Electron loaded these files as sloppy-mode CommonJS, and at least one
// ported module relies on that (h5vcc/dial/constants.js: `const package = require('.../package.json')`
// — `package` is a reserved word only in strict mode). Forcing strict mode makes the whole bundle a
// SyntaxError.
parts.push('var __vtStrictModeDisabled = true;')
parts.push('var __VT_ASSETS__ = {' + Object.entries(assets).map(([k, v]) => jsString(k) + ':' + (v.base64 !== undefined ? `{base64:${jsString(v.base64)}}` : `{text:${jsString(v.text)}}`)).join(',') + '};')
parts.push('var __VT_DIRS__ = {' + Object.entries(dirs).map(([k, v]) => jsString(k) + ':' + jsString(v)).join(',') + '};')
parts.push('')
parts.push('/* ==== embedded CommonJS runtime (tools/runtime-prelude.js) ==== */')
parts.push(prelude)
parts.push('')
parts.push('/* ==== Node/Electron API shims (tools/shims/*) ==== */')
for (const [name, source] of Object.entries(shims)) {
    parts.push(`__VT__.shims[${jsString(name)}] = function (module, exports, require, __dirname, __filename, process, Buffer, global) {`)
    parts.push(source)
    parts.push('};')
}
parts.push('')
parts.push('/* ==== ported VacuumTube preload modules (verbatim) ==== */')
for (const [id, source] of Object.entries(modules)) {
    parts.push(`__VT__.modules[${jsString(id)}] = function (module, exports, require, __dirname, __filename, process, Buffer, global) {`)
    parts.push(source)
    parts.push('};')
}
parts.push('')
parts.push(`/* ==== globals + bootstrap (mirrors src/index.js loading the preload) ==== */`)
parts.push(`
var __vtProcess = {
    platform: 'android',
    arch: (__VT__.native && __VT__.native.deviceArch) ? String(__VT__.native.deviceArch()) : 'arm64',
    versions: {},
    argv: [],
    env: {},
    pid: 1,
    browser: false,
    nextTick: function (fn) { setTimeout(fn, 0) },
    cwd: function () { return ${jsString(VROOT)} },
    on: function () {},
    once: function () {},
    off: function () {},
    exit: function () {},
    platformLabel: 'android'
};

function __vtMakeBuffer(value) {
    var text = String(value);
    return {
        __vtBuffer: true,
        length: text.length,
        toString: function (encoding) { return text },
        slice: function (a, b) { return __vtMakeBuffer(text.slice(a, b)) }
    };
}

var __vtBuffer = {
    from: function (value) { return __vtMakeBuffer(value) },
    alloc: function (size) { return __vtMakeBuffer(new Array(size + 1).join('\\u0000')) },
    allocUnsafe: function (size) { return __vtMakeBuffer(new Array(size + 1).join('\\u0000')) },
    concat: function (list) { return __vtMakeBuffer((list || []).map(function (item) { return item && item.toString ? item.toString() : String(item) }).join('')) },
    isBuffer: function (value) { return !!(value && value.__vtBuffer) },
    byteLength: function (value) { return String(value).length }
};

__VT__.process = __vtProcess;
__VT__.Buffer = __vtBuffer;

window.__vtEmit = function (channel, payloadJson) {
    var payload = null;
    if (payloadJson !== null && payloadJson !== undefined && payloadJson !== '') {
        try { payload = JSON.parse(payloadJson) } catch (err) { payload = payloadJson }
    }
    __VT__.emit(String(channel), payload)
};

window.__vtResolve = function (id, payloadJson) {
    __VT__.resolveInvoke(String(id), payloadJson === undefined ? null : payloadJson)
};

window.__vtDialDispatch = function (appName, method, routePath, body, host) {
    __VT__.dialHost = host || '';
    return __VT__.dialDispatch(String(appName), String(method).toUpperCase(), String(routePath), body === undefined ? '' : String(body))
};

window.__vtLoaded = false;
window.__vtBuild = ${jsString({
    product: 'VacuumTube-Android',
    upstream: 'VacuumTube 2.0.0 (shy1132/VacuumTube)',
    source: 'resources/app.asar -> src/preload/**',
    generatedAt: new Date().toISOString()
})};

try {
    __VT__.requireFrom(${jsString(VROOT + '/src/preload')}, './index.js')
} catch (err) {
    console.error('[vt] preload bootstrap failed', err)
    // The original never unblocks on a require-time failure, which would make every XHR hang
    // forever; unblock so the stock Leanback UI still works without the patches.
    try { __VT__.load(${jsString(VROOT + '/src/preload/util/xhrModifiers.js')}).unblock() } catch (e) { /* ignore */ }
}

try {
    __VT__.load(${jsString(VROOT + '/android-glue.js')})
} catch (err) {
    console.error('[vt] android glue failed', err)
}

window.__vtLoaded = true;
console.log('[vt] bundle ready: modules=' + Object.keys(__VT__.modules).length + ' assets=' + Object.keys(__VT__.assets).length)
`)

parts.push('})();')

// ---------------------------------------------------------------- verify + write
const code = parts.join('\n')

const dangerous = []
for (const needle of ['</script', '<script', '<!--']) {
    const index = code.toLowerCase().indexOf(needle.toLowerCase())
    if (index >= 0) dangerous.push(`${needle} at offset ${index}: ...${code.slice(Math.max(0, index - 80), index + 80).replace(/\n/g, '\\n')}...`)
}
// the first entry of __VT_ASSETS__ carries a stray probe expression; make sure it is harmless
if (code.includes('__VT_ASSETS__ = ') === false) dangerous.push('asset table missing')

if (dangerous.length) {
    console.error('[bundle] refusing to emit: the bundle cannot be inlined into <script>:')
    for (const item of dangerous) console.error('  - ' + item)
    process.exit(1)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, code)

const manifest = {
    generatedAt: new Date().toISOString(),
    source: VENDOR.replace(/\\/g, '/'),
    output: OUT.replace(/\\/g, '/'),
    outputBytes: Buffer.byteLength(code),
    outputSha256: crypto.createHash('sha256').update(code).digest('hex'),
    moduleCount: Object.keys(modules).length,
    shimCount: Object.keys(shims).length,
    assetCount: Object.keys(assets).length,
    assets: { cssBytes, localeBytes, totalBytes: Object.values(assets).reduce((sum, a) => sum + (a.text ? a.text.length : (a.base64 ? a.base64.length : 0)), 0) },
    dirListings: Object.fromEntries(Object.entries(dirs).map(([k, v]) => [k, v.length])),
    nativeDialReplacements: Object.keys(OVERRIDES),
    moduleIds: Object.keys(modules).sort()
}
fs.mkdirSync(path.dirname(MANIFEST), { recursive: true })
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2))

console.log(`[bundle] wrote ${OUT} (${(manifest.outputBytes / 1024).toFixed(1)} KiB)`)
console.log(`[bundle] modules=${manifest.moduleCount} shims=${manifest.shimCount} assets=${manifest.assetCount} (css ${(cssBytes / 1024).toFixed(1)} KiB, locale ${(localeBytes / 1024).toFixed(1)} KiB)`)
console.log(`[bundle] sha256=${manifest.outputSha256}`)
if (skipped.length) console.log(`[bundle] not embedded (not needed at runtime): ${skipped.length} file(s)`)
