// Android port shim for `require('events')`.
// Only `new EventEmitter()` + on/emit/removeListener are used (util/controller.js) — census.md §3.
class EventEmitter {
    constructor() {
        this._events = {}
    }
    on(name, listener) {
        (this._events[name] = this._events[name] || []).push(listener)
        return this
    }
    addListener(name, listener) {
        return this.on(name, listener)
    }
    once(name, listener) {
        const wrapper = (...args) => {
            this.removeListener(name, wrapper)
            listener.apply(this, args)
        }
        return this.on(name, wrapper)
    }
    prependListener(name, listener) {
        (this._events[name] = this._events[name] || []).unshift(listener)
        return this
    }
    removeListener(name, listener) {
        const list = this._events[name]
        if (!list) return this
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
        return this
    }
    off(name, listener) {
        return this.removeListener(name, listener)
    }
    removeAllListeners(name) {
        if (name) delete this._events[name]
        else this._events = {}
        return this
    }
    listeners(name) {
        return (this._events[name] || []).slice()
    }
    listenerCount(name) {
        return (this._events[name] || []).length
    }
    emit(name) {
        const list = this._events[name]
        if (!list || !list.length) return false
        const args = Array.prototype.slice.call(arguments, 1)
        for (const listener of list.slice()) {
            try { listener.apply(this, args) } catch (err) { console.error('[vt] EventEmitter listener failed', name, err) }
        }
        return true
    }
    setMaxListeners() {
        return this
    }
}

module.exports = { EventEmitter, default: EventEmitter }
