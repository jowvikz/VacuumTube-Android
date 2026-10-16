// Android port shim for `require('electron')`.
// VacuumTube's preload only uses ipcRenderer (sendSync / invoke / on) and shell.openExternal;
// see rea-work/census.md §3. The native side is the @JavascriptInterface object `window.VacuumTube`.
const VT = __VT__.native

// Listeners MUST live on the runtime's own bus (__VT__.on / __VT__.off): that is what
// `__VT__.emit` — reached from Java through window.__vtEmit(...) — dispatches to. Keeping a private
// map here silently swallowed every native -> page event (config-update, focus, blur, deeplink,
// userstyle-updated, update-state-changed).
const ipcRenderer = {
    sendSync(channel, payload) {
        return __VT__.nativeSync(channel, payload)
    },
    send(channel, payload) {
        if (VT && typeof VT.send === 'function') VT.send(String(channel), payload === undefined ? null : JSON.stringify(payload))
    },
    invoke(channel, payload) {
        return __VT__.nativeInvoke(channel, payload)
    },
    on(channel, listener) {
        __VT__.on(String(channel), listener)
        return ipcRenderer
    },
    once(channel, listener) {
        const wrapper = function (...args) {
            __VT__.off(String(channel), wrapper)
            listener.apply(null, args)
        }
        __VT__.on(String(channel), wrapper)
        return ipcRenderer
    },
    off(channel, listener) {
        __VT__.off(String(channel), listener)
        return ipcRenderer
    },
    removeListener(channel, listener) {
        __VT__.off(String(channel), listener)
        return ipcRenderer
    },
    removeAllListeners(channel) {
        if (channel) __VT__.listeners[String(channel)] = []
        else __VT__.listeners = {}
        return ipcRenderer
    },
    setMaxListeners() {
        return ipcRenderer
    },
    listenerCount(channel) {
        return __VT__.listenerCount(String(channel))
    }
}

const shell = {
    openExternal(url) {
        if (VT && typeof VT.openExternal === 'function') VT.openExternal(String(url))
    },
    openPath() {
        return Promise.resolve('')
    },
    showItemInFolder() {}
}

module.exports = {
    ipcRenderer,
    shell,
    ipcMain: { on() {}, handle() {} },
    app: {
        getVersion: () => (VT && VT.appVersion ? VT.appVersion() : '2.0.0-android'),
        getPath: () => '/vt'
    },
    clipboard: {
        writeText(text) {
            if (VT && typeof VT.setClipboard === 'function') VT.setClipboard(String(text))
            return Promise.resolve()
        },
        readText() {
            return Promise.resolve(VT && typeof VT.getClipboard === 'function' ? VT.getClipboard() : '')
        }
    }
}
