// Android port shim for `require('fs')`.
// The Electron build read the packaged app's own files (CSS, locale JSON, package.json, icon.png)
// and listed the modules directory (src/preload/index.js:9). Those are build-time assets here, so
// this shim serves them from the virtual asset table generated into the bundle.
function makeBufferish(text, base64) {
    return {
        __vtBuffer: true,
        length: text ? text.length : 0,
        toString(encoding) {
            if (encoding === 'base64') return base64
            if (encoding === 'utf-8' || encoding === 'utf8' || encoding === undefined) return text
            return text
        }
    }
}

function readFileSync(filePath, encoding) {
    const asset = __VT__.asset(String(filePath))
    if (!asset) {
        const err = new Error("ENOENT: no such file or directory, open '" + String(filePath) + "'")
        err.code = 'ENOENT'
        throw err
    }
    if (encoding) return asset.text !== undefined ? asset.text : ''
    return makeBufferish(asset.text !== undefined ? asset.text : '', asset.base64)
}

function dirents(entries) {
    return entries.map((entry) => ({
        name: entry.name,
        parentPath: '',
        isDirectory: () => !!entry.dir,
        isFile: () => !entry.dir,
        isSymbolicLink: () => false
    }))
}

function readdirSync(dirPath, options) {
    const entries = __VT__.dirEntries(String(dirPath))
    if (options && options.withFileTypes) return dirents(entries)
    return entries.map((entry) => entry.name)
}

const promises = {
    readdir(dirPath, options) {
        try { return Promise.resolve(readdirSync(dirPath, options)) } catch (err) { return Promise.reject(err) }
    },
    readFile(filePath, encoding) {
        try { return Promise.resolve(readFileSync(filePath, encoding)) } catch (err) { return Promise.reject(err) }
    }
}

function unsupported(name) {
    return function () {
        throw new Error('[vt] fs.' + name + ' is not available in the Android port (the virtual filesystem is read-only)')
    }
}

module.exports = {
    readFileSync,
    readdirSync,
    promises,
    existsSync: (p) => !!__VT__.asset(String(p)) || __VT__.dirEntries(String(p)).length > 0,
    statSync: (p) => {
        const asset = __VT__.asset(String(p))
        if (asset) return { isFile: () => true, isDirectory: () => false, size: asset.text ? asset.text.length : 0 }
        return { isFile: () => false, isDirectory: () => true, size: 0 }
    },
    realpathSync: (p) => __VT__.norm(String(p)),
    writeFileSync: unsupported('writeFileSync'),
    mkdirSync: unsupported('mkdirSync'),
    renameSync: unsupported('renameSync'),
    openSync: unsupported('openSync'),
    writeSync: unsupported('writeSync'),
    fsyncSync: unsupported('fsyncSync'),
    closeSync: unsupported('closeSync'),
    watch: () => ({ on() {}, close() {} }),
    constants: { F_OK: 0, R_OK: 4 }
}
