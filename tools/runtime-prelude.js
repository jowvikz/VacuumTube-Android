/* ---------------------------------------------------------------------------------------------
 * VacuumTube-Android — embedded CommonJS runtime (verbatim part of the generated bundle).
 *
 * The Electron build loaded src/preload/** with Node's module system in the page's main world
 * (src/index.js:355-362, contextIsolation:false). A WebView has no require/fs/__dirname, so this
 * prelude re-creates the smallest faithful subset of Node needed by that tree:
 *   - a module registry keyed by virtual path (/vt/...), loaded lazily like Node's require
 *   - Node resolution semantics for relative requests (.js, /index.js, .json)
 *   - a virtual filesystem backed by the asset table (CSS, locale JSON, package.json, icon.png)
 *   - the native JavascriptInterface bridge (window.VacuumTube) exposed as __VT__.native
 * Nothing here changes the behaviour of the ported modules; it only supplies what Node supplied.
 * ------------------------------------------------------------------------------------------- */
function __vtNormalize(input) {
    var raw = String(input).replace(/\\/g, '/')
    var absolute = raw.charAt(0) === '/'
    var parts = raw.split('/')
    var out = []
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i]
        if (part === '' || part === '.') continue
        if (part === '..') {
            if (out.length && out[out.length - 1] !== '..') out.pop()
            else if (!absolute) out.push('..')
            continue
        }
        out.push(part)
    }
    return (absolute ? '/' : '') + out.join('/')
}

function __vtJoin() {
    var parts = []
    for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i]
        if (a === undefined || a === null || a === '') continue
        parts.push(String(a))
    }
    return __vtNormalize(parts.join('/'))
}

var __VT__ = {
    assets: __VT_ASSETS__,
    dirs: __VT_DIRS__,
    modules: {},
    cache: {},
    shims: {},
    listeners: {},
    pendingInvokes: {},
    pendingInvokeSeq: 0,
    dialRoutes: [],
    norm: __vtNormalize,
    join: __vtJoin,
    native: (typeof window !== 'undefined' && window.VacuumTube) ? window.VacuumTube : null,
    debug: true
}

__VT__.log = function (message) {
    if (!__VT__.debug) return
    try { console.log('[vt] ' + message) } catch (e) { /* ignore */ }
}

/* --- native bridge helpers ---------------------------------------------------------------- */
__VT__.nativeSync = function (channel, payload) {
    var VT = __VT__.native
    var arg = payload === undefined ? null : JSON.stringify(payload)
    if (!VT || typeof VT.sendSync !== 'function') return null
    var raw = VT.sendSync(String(channel), arg)
    if (raw === null || raw === undefined) return null
    try { return JSON.parse(raw) } catch (e) { return raw }
}

__VT__.nativeInvoke = function (channel, payload) {
    var VT = __VT__.native
    return new Promise(function (resolve, reject) {
        if (!VT || typeof VT.invoke !== 'function') { resolve(null); return }
        var id = 'i' + (++__VT__.pendingInvokeSeq)
        __VT__.pendingInvokes[id] = { resolve: resolve, reject: reject }
        try {
            VT.invoke(String(channel), payload === undefined ? null : JSON.stringify(payload), id)
        } catch (err) {
            delete __VT__.pendingInvokes[id]
            reject(err)
        }
    })
}

__VT__.resolveInvoke = function (id, payloadJson) {
    var entry = __VT__.pendingInvokes[id]
    if (!entry) return
    delete __VT__.pendingInvokes[id]
    var value = null
    if (payloadJson !== null && payloadJson !== undefined && payloadJson !== '') {
        try { value = JSON.parse(payloadJson) } catch (e) { value = payloadJson }
    }
    if (value && typeof value === 'object' && value.__vtError) entry.reject(new Error(String(value.__vtError)))
    else entry.resolve(value)
}

/* Event bus mirroring ipcRenderer's on/emit side (native -> page). */
__VT__.on = function (channel, listener) {
    var list = __VT__.listeners[channel] || (__VT__.listeners[channel] = [])
    list.push(listener)
    return listener
}
__VT__.off = function (channel, listener) {
    var list = __VT__.listeners[channel]
    if (!list) return
    var index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
}
__VT__.emit = function (channel, payload) {
    var list = __VT__.listeners[channel]
    if (!list || !list.length) return
    var snapshot = list.slice()
    for (var i = 0; i < snapshot.length; i++) {
        try { snapshot[i]({ sender: null, channel: channel }, payload) }
        catch (err) { console.error('[vt] listener for "' + channel + '" failed', err) }
    }
}
__VT__.listenerCount = function (channel) {
    return __VT__.listeners[channel] ? __VT__.listeners[channel].length : 0
}

/* --- virtual filesystem ------------------------------------------------------------------- */
__VT__.asset = function (virtualPath) {
    var key = __VT__.norm(virtualPath)
    return __VT__.assets[key] || null
}
__VT__.dirEntries = function (virtualPath) {
    var key = __VT__.norm(virtualPath)
    var entries = __VT__.dirs[key]
    if (entries) return entries
    // synthesize a listing from the asset table so ad-hoc readdir calls still work
    var prefix = key === '/' ? '/' : key + '/'
    var seen = {}
    var out = []
    for (var assetPath in __VT__.assets) {
        if (assetPath.indexOf(prefix) !== 0) continue
        var rest = assetPath.slice(prefix.length)
        var slash = rest.indexOf('/')
        var name = slash === -1 ? rest : rest.slice(0, slash)
        if (seen[name]) continue
        seen[name] = true
        out.push({ name: name, dir: slash !== -1 })
    }
    out.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0 })
    return out
}

/* --- module system ------------------------------------------------------------------------ */
__VT__.load = function (id) {
    var cached = __VT__.cache[id]
    if (cached) return cached.exports

    var factory = __VT__.modules[id] || __VT__.shims[id]
    if (!factory) throw new Error("Cannot find module '" + id + "'")

    var module = { id: id, exports: {}, loaded: false }
    __VT__.cache[id] = module
    var dir = id.charAt(0) === '/' ? (id.slice(0, id.lastIndexOf('/')) || '/') : null
    var localRequire = function (request) { return __VT__.requireFrom(dir, request) }
    localRequire.resolve = function (request) { return __VT__.resolveFrom(dir, request) }
    localRequire.cache = __VT__.cache

    // process/Buffer/global are passed as parameters so the ported modules see Node's globals
    // without polluting window (YouTube itself probes for Electron through window.process).
    factory.call(module.exports, module, module.exports, localRequire, dir, id, __VT__.process, __VT__.Buffer, window)
    module.loaded = true
    return module.exports
}

__VT__.resolveFrom = function (dir, request) {
    request = String(request)
    if (request.charAt(0) !== '.') {
        if (__VT__.shims[request] || __VT__.modules[request]) return request
        throw new Error("Cannot find module '" + request + "'")
    }
    var base = __vtNormalize(__vtJoin(dir || '/', request))
    var candidates = [base, base + '.js', base + '/index.js', base + '.json']
    for (var i = 0; i < candidates.length; i++) {
        if (__VT__.modules[candidates[i]] || __VT__.shims[candidates[i]]) return candidates[i]
    }
    throw new Error("Cannot find module '" + request + "' from '" + dir + "'")
}

__VT__.requireFrom = function (dir, request) {
    return __VT__.load(__VT__.resolveFrom(dir, request))
}

/* --- uuid (dial/constants.js called node:crypto's randomUUID) ------------------------------ */
__VT__.uuid = function () {
    var VT = __VT__.native
    if (VT && typeof VT.randomUUID === 'function') {
        try { return VT.randomUUID() } catch (e) { /* fall through */ }
    }
    var bytes = new Uint8Array(16)
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
    else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    var hex = []
    for (var j = 0; j < 16; j++) hex.push((bytes[j] + 0x100).toString(16).slice(1))
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10, 16).join('')
}

/* --- DIAL: native transport (VtDial.java) dispatches into the page's registered routes ---- */
__VT__.dialDispatch = function (appName, method, path, body) {
    var basePath = '/apps/' + appName
    var full = (basePath + path).replace(/\/+$/, '') || '/'
    var route = null
    for (var i = 0; i < __VT__.dialRoutes.length; i++) {
        var candidate = __VT__.dialRoutes[i]
        if (candidate.method === method && candidate.path === full) { route = candidate; break }
    }
    if (!route) return JSON.stringify({ responseCode: 404, body: null, headers: {} })
    var headers = {}
    var data = {
        addHeader: function (key, value) { headers[String(key)] = String(value) },
        mimeType: null,
        responseCode: null,
        body: null
    }
    try {
        var handled = route.callback({ host: __VT__.dialHost || '', path: basePath, body: body || '' }, data)
        if (!handled) return JSON.stringify({ responseCode: 400, body: null, headers: {} })
        return JSON.stringify({ responseCode: data.responseCode || 200, body: data.body || null, headers: headers, mimeType: data.mimeType || null })
    } catch (err) {
        console.error('[vt] DIAL route failed', method, full, err)
        return JSON.stringify({ responseCode: 500, body: null, headers: {} })
    }
}
