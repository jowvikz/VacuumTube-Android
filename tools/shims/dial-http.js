// Android port shim replacing src/preload/modules/h5vcc/dial/http.js (census.md §1.4, §6.4).
// The original started a Node http server inside the preload (http.createServer + listen). A
// WebView page cannot listen on a socket, so the HTTP transport lives in VtDial.java and only the
// route table stays here; the native side dispatches requests back into the page through
// window.__vtDialDispatch -> __VT__.dialDispatch (see runtime-prelude.js).
const routes = __VT__.dialRoutes

module.exports = {
    route(method, path, callback) {
        routes.push({ method: String(method).toUpperCase(), path: String(path), callback })
    },
    // called by h5vcc/index.js startDial(); native owns the socket
    listen() {
        const VT = __VT__.native
        if (VT && typeof VT.dialStart === 'function') {
            try { VT.dialStart() } catch (err) { console.error('[vt] DIAL: native start failed', err) }
        }
        return Promise.resolve(0)
    },
    baseFor() {
        return __VT__.dialHost || ''
    },
    get port() {
        return 0
    }
}
