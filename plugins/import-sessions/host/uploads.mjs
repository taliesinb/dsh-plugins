/**
 * Uploaded transcript stores — for clients whose pi / Claude Code sessions
 * live on THEIR machine, not the server's (a remote Dock app (macOS) or DSH Remote (Linux) on a laptop
 * talking to a shared host). The browser picks a folder or a transcript with
 * the standard HTML chooser, keeps only transcript files, gzips each and sends
 * it in base64 chunks through the JSON control channel (prefix-safe behind
 * the tailnet mount, bounded memory per chunk); the server materializes them
 * here and `scan` / `import` treat the directory like any other selection.
 *
 *   $DSH_HOME/import-sessions/uploads/<uploadId>/<relative path>
 *
 * Relative paths are sanitized (no absolute, no `..`, no empty segments); only
 * names that look like transcripts of the declared source are accepted, so the
 * server never stores arbitrary client files. Uploads are swept after a day.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { join, posix, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { isSessionFile } from './sources.mjs'

const SWEEP_AGE_MS = 24 * 60 * 60 * 1000
const ID_RE = /^up-[0-9a-f-]{36}$/

/** Accept a relative transcript path for `source`; return its normalized posix form. */
export function sanitizeRelativePath(source, relative) {
  if (typeof relative !== 'string' || relative === '') throw new Error('upload path is empty')
  const normalized = posix.normalize(relative.replace(/\\/g, '/'))
  if (normalized.startsWith('/') || normalized.startsWith('../') || normalized === '..' || normalized.includes('/../') || normalized.includes('\0')) {
    throw new Error(`upload path escapes the upload: ${relative}`)
  }
  const segments = normalized.split('/').filter(s => s !== '' && s !== '.')
  if (segments.length === 0 || segments.length > 8) throw new Error(`upload path has an unexpected depth: ${relative}`)
  const name = segments.at(-1)
  const isSubagent = source === 'claude' && segments.length >= 3 && segments.at(-2) === 'subagents' && /^agent-[^/]+\.jsonl$/.test(name)
  if (!isSessionFile(source, name) && !isSubagent) throw new Error(`not a transcript file for this source: ${relative}`)
  return segments.join('/')
}

export class UploadStore {
  constructor(root) {
    this.root = root
    /** @type {Map<string, {id:string, source:string, dir:string, createdAt:number, files:Map<string,{handle:any, encoding:string, bytes:number}>}>} */
    this.uploads = new Map()
  }

  async begin(source) {
    const id = `up-${randomUUID()}`
    const dir = join(this.root, id)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if (this.realRoot === undefined) { try { this.realRoot = await realpath(this.root) } catch { this.realRoot = resolve(this.root) } }
    const upload = { id, source, dir, createdAt: Date.now(), files: new Map() }
    this.uploads.set(id, upload)
    return upload
  }

  get(id) {
    if (!ID_RE.test(String(id))) return undefined
    return this.uploads.get(id)
  }

  /**
   * Append one chunk of a file. Chunks arrive in order per file; `encoding`
   * is 'gzip' or 'identity' and must be the same for every chunk of a file.
   */
  async chunk(id, relative, data, { encoding = 'identity', offset } = {}) {
    const upload = this.get(id)
    if (upload === undefined) throw new Error(`unknown upload ${String(id)}`)
    const clean = sanitizeRelativePath(upload.source, relative)
    let file = upload.files.get(clean)
    if (file === undefined) {
      const target = join(upload.dir, ...clean.split('/'))
      if (!resolve(target).startsWith(resolve(upload.dir) + sep)) throw new Error('upload path escapes the upload')
      await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 })
      const handle = await open(encoding === 'gzip' ? `${target}.gz.part` : `${target}.part`, 'w', 0o600)
      file = { handle, encoding, bytes: 0, target }
      upload.files.set(clean, file)
    }
    if (offset !== undefined && offset !== file.bytes) throw new Error(`chunk offset ${offset} does not continue ${clean} at ${file.bytes}`)
    await file.handle.write(data)
    file.bytes += data.length
    return { bytes: file.bytes }
  }

  /** Close every file; gunzip the compressed ones. Returns the directory to scan. */
  async finish(id) {
    const upload = this.get(id)
    if (upload === undefined) throw new Error(`unknown upload ${String(id)}`)
    let files = 0
    let bytes = 0
    for (const [clean, file] of upload.files) {
      await file.handle.close()
      if (file.encoding === 'gzip') {
        const part = `${file.target}.gz.part`
        await pipeline((await open(part, 'r')).createReadStream(), createGunzip(), createWriteStream(file.target, { mode: 0o600 }))
        await rm(part, { force: true })
      } else {
        await rename(`${file.target}.part`, file.target)
      }
      files++
      bytes += (await stat(file.target)).size
      upload.files.set(clean, { ...file, handle: undefined })
    }
    return { dir: upload.dir, files, bytes }
  }

  async discard(id) {
    const upload = this.get(id)
    if (upload === undefined) return false
    for (const file of upload.files.values()) { try { await file.handle?.close() } catch { /* closed */ } }
    this.uploads.delete(id)
    await rm(upload.dir, { recursive: true, force: true })
    return true
  }

  /** Does `path` lie inside an upload of this store? (Both spellings of the root: as configured and canonical.) */
  owns(path) {
    const canonical = resolve(path)
    return canonical.startsWith(resolve(this.root) + sep) || (this.realRoot !== undefined && canonical.startsWith(this.realRoot + sep))
  }

  /** Remove upload directories older than a day (a restart forgets in-flight ones). */
  async sweep(now = Date.now()) {
    let removed = 0
    let entries
    try { entries = await readdir(this.root) } catch { return 0 }
    for (const name of entries) {
      if (!ID_RE.test(name) || this.uploads.has(name)) continue
      const dir = join(this.root, name)
      try {
        const info = await stat(dir)
        if (now - info.mtimeMs > SWEEP_AGE_MS) { await rm(dir, { recursive: true, force: true }); removed++ }
      } catch { /* gone */ }
    }
    return removed
  }
}
