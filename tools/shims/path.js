// Android port shim for `require('path')`.
// Only the members VacuumTube's preload uses are needed (join + the __dirname it is joined with,
// plus a little more so the surface does not surprise callers): census.md §3.
const norm = __VT__.norm

function join() {
    const parts = []
    for (let i = 0; i < arguments.length; i++) {
        if (arguments[i] === undefined || arguments[i] === null || arguments[i] === '') continue
        parts.push(String(arguments[i]))
    }
    return norm(parts.join('/'))
}

function dirname(p) {
    const normalized = norm(String(p))
    const index = normalized.lastIndexOf('/')
    if (index < 0) return '.'
    if (index === 0) return '/'
    return normalized.slice(0, index)
}

function basename(p, ext) {
    const normalized = norm(String(p))
    let name = normalized.slice(normalized.lastIndexOf('/') + 1)
    if (ext && name.endsWith(ext)) name = name.slice(0, -ext.length)
    return name
}

function extname(p) {
    const name = basename(p)
    const index = name.lastIndexOf('.')
    return index <= 0 ? '' : name.slice(index)
}

module.exports = {
    join,
    resolve() {
        let resolved = ''
        for (let i = arguments.length - 1; i >= 0; i--) {
            const part = String(arguments[i])
            resolved = resolved ? part + '/' + resolved : part
            if (part.charAt(0) === '/') break
        }
        return norm(resolved || '/')
    },
    normalize: norm,
    dirname,
    basename,
    extname,
    isAbsolute: (p) => String(p).charAt(0) === '/',
    relative(from, to) {
        const a = norm(String(from)).split('/')
        const b = norm(String(to)).split('/')
        let i = 0
        while (i < a.length && i < b.length && a[i] === b[i]) i++
        return b.slice(i).join('/')
    },
    parse(p) {
        const base = basename(p)
        const ext = extname(p)
        return { root: String(p).charAt(0) === '/' ? '/' : '', dir: dirname(p), base, ext, name: base.slice(0, base.length - ext.length) }
    },
    format(obj) {
        return join(obj.dir || '', (obj.name || '') + (obj.ext || ''))
    },
    sep: '/',
    delimiter: ':'
}
