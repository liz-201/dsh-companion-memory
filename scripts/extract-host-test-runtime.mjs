/** Read-only extraction for isolated protocol tests; never patches the installed application. */
import fs from 'node:fs'
import path from 'node:path'
const file = process.argv[2] ?? 'D:/dsh/resources/app.asar'
const destination = path.resolve('artifacts/desktop-v03-runtime/node_modules')
const fd = fs.openSync(file, 'r')
try {
  const prefix = Buffer.alloc(16)
  fs.readSync(fd, prefix, 0, 16, 0)
  const headerBytes = Buffer.alloc(prefix.readUInt32LE(12))
  fs.readSync(fd, headerBytes, 0, headerBytes.length, 16)
  const header = JSON.parse(headerBytes.toString())
  const dataOffset = 8 + prefix.readUInt32LE(4)
  function nodeAt(name) {
    let node = header
    for (const part of name.split('/').filter(Boolean)) node = node?.files?.[part]
    if (node?.link) return nodeAt(node.link)
    return node
  }
  function bytes(name) {
    const node = nodeAt(name)
    if (!node || node.files || node.unpacked) throw new Error(`Cannot extract ${name}`)
    const buffer = Buffer.alloc(node.size)
    fs.readSync(fd, buffer, 0, buffer.length, dataOffset + Number(node.offset))
    return buffer
  }
  const copied = new Set()
  function copyPackage(name) {
    if (copied.has(name)) return
    const source = nodeAt(`dsh/node_modules/${name}`) ? `dsh/node_modules/${name}` : `node_modules/${name}`
    const pkg = JSON.parse(bytes(`${source}/package.json`))
    copied.add(name)
    function visit(relative) {
      const node = nodeAt(`${source}/${relative}`)
      if (node.files) { for (const entry of Object.keys(node.files)) visit(relative ? `${relative}/${entry}` : entry); return }
      const target = path.resolve(destination, name, relative)
      if (!target.startsWith(destination + path.sep)) throw new Error('Unsafe extraction target')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, bytes(`${source}/${relative}`))
    }
    visit('')
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) copyPackage(dependency)
  }
  copyPackage('@deepseek-ai/dsh-session')
  copyPackage('@deepseek-ai/dsh-llm')
  console.log(JSON.stringify({ file, destination, packages: [...copied] }))
} finally { fs.closeSync(fd) }
