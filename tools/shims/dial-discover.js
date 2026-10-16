// Android port shim replacing src/preload/modules/h5vcc/dial/discover.js (census.md §1.4, §6.4).
// The original opened a dgram UDP socket, joined 239.255.255.250:1900 and answered M-SEARCH from
// the page — impossible in a WebView. SSDP now lives in VtDial.java; h5vcc/index.js still calls
// discover.start() exactly as before.
module.exports = {
    start() {
        const VT = __VT__.native
        if (VT && typeof VT.dialStart === 'function') {
            try { VT.dialStart() } catch (err) { console.error('[vt] DIAL: native discover start failed', err) }
        }
    },
    stop() {
        const VT = __VT__.native
        if (VT && typeof VT.dialStop === 'function') {
            try { VT.dialStop() } catch (err) { /* ignore */ }
        }
    }
}
