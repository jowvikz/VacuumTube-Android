// Dumps the true directory-entry order of the packaged app.asar so the Android bundle can
// reproduce `fs.readdirSync(modulesPath)` exactly as the Electron build saw it.
// asar layout: [uint32=4][uint32=headerPickleSize][headerPickle: uint32=payloadSize][uint32=jsonLen][json]
import fs from 'node:fs'
import path from 'node:path'

const asar = process.argv[2]
const out = process.argv[3]
if (!asar || !out) {
  console.error('usage: node dump-asar-order.mjs <app.asar> <out.json>')
  process.exit(2)
}

const buf = fs.readFileSync(asar)
const headerPickleSize = buf.readUInt32LE(4)
const jsonLen = buf.readUInt32LE(12)
const json = buf.subarray(16, 16 + jsonLen).toString('utf8')
const header = JSON.parse(json)

function entriesOf(node) {
  const files = node && node.files
  if (!files) return null
  return Object.entries(files).map(([name, v]) => ({ name, dir: !!v.files }))
}

const modules = header.files?.src?.files?.preload?.files?.modules
const preload = header.files?.src?.files?.preload
const locale = header.files?.locale

const order = {}
if (modules) order['/vt/src/preload/modules'] = entriesOf(modules)
if (preload) order['/vt/src/preload'] = entriesOf(preload)
if (locale) order['/vt/locale'] = entriesOf(locale)

fs.writeFileSync(out, JSON.stringify(order, null, 2))
console.log('wrote', out)
for (const [k, v] of Object.entries(order)) console.log(k, '->', v.length, 'entries:', v.map(e => e.name + (e.dir ? '/' : '')).join(' '))
