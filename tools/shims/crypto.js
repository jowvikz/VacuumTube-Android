// Android port shim for `require('crypto')`.
// Used by dial/constants.js for a persisted device UUID (census.md §3).
const randomUUID = () => __VT__.uuid()

function randomBytes(size) {
    const bytes = new Uint8Array(size)
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
    else for (let i = 0; i < size; i++) bytes[i] = Math.floor(Math.random() * 256)
    return {
        length: size,
        toString(encoding) {
            if (encoding === 'hex') return Array.from(bytes).map((b) => (b + 0x100).toString(16).slice(1)).join('')
            if (encoding === 'base64') return btoa(String.fromCharCode.apply(null, Array.from(bytes)))
            return String.fromCharCode.apply(null, Array.from(bytes))
        }
    }
}

module.exports = { randomUUID, randomBytes }
