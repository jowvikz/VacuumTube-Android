// Android port shim replacing src/preload/modules/h5vcc/dial/server.js (census.md §1.4, §6.4).
// Same public surface as the original class (constructor(appName), onGet/onPost/onDelete using
// `basePath = /apps/<appName>`, callbacks receiving ({host, path, body}, {addHeader}) and setting
// mimeType/responseCode/body). The difference is transport only: native DIAL frames arrive via
// window.__vtDialDispatch instead of an in-page HTTP server.
const http = require('./http')

function fullPath(server, path) {
    return (server.basePath + path).replace(/\/+$/, '') || '/'
}

class DialServer {
    constructor(appName) {
        this.appName = appName
        this.basePath = '/apps/' + appName
    }

    onGet(path, callback) {
        http.route('GET', fullPath(this, path), callback)
    }

    onPost(path, callback) {
        http.route('POST', fullPath(this, path), callback)
    }

    onDelete(path, callback) {
        http.route('DELETE', fullPath(this, path), callback)
    }
}

module.exports = DialServer
