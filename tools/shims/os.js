// Android port shim for `require('os')`.
// Used by modules/cast-label.js (hostname for the DIAL cast label) — census.md §3/§6.
const VT = __VT__.native

function call(method, fallback) {
    try {
        if (VT && typeof VT[method] === 'function') return String(VT[method]())
    } catch (err) { /* ignore */ }
    return fallback
}

module.exports = {
    hostname: () => call('deviceName', 'Android'),
    platform: () => 'android',
    type: () => 'Android',
    release: () => call('deviceRelease', ''),
    arch: () => call('deviceArch', 'arm64'),
    cpus: () => [],
    totalmem: () => 0,
    freemem: () => 0,
    homedir: () => '/data',
    tmpdir: () => '/data/local/tmp',
    // DIAL's own net helper (dial/net.js) is replaced on Android; keep the call harmless.
    networkInterfaces: () => ({})
}
