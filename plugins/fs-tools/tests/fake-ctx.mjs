/**
 * A fake plugin Context for tests: a real-filesystem `ctx.fs` under a temp
 * root (resolve/stat/listDir/readText/writeText/editText with an in-memory
 * version counter and the FS_SANDBOX_DENIED / FS_STALE_VERSION codes of
 * dsh-fs-sandbox + dsh-fs-local), a mini read-before-edit policy wired to
 * `fs/edit-intent` (waterfall) and `fs/observed` (emit) like
 * dsh-fs-observation-policy, a `sandboxPolicy` resolver and a bare `tools`.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'

class FsError extends Error {
  constructor(message, code) { super(message); this.code = code }
}

export function fakeCtx({ workspaceRoot, mode = 'workspace-write', withPolicy = true }) {
  /** owner(session id) → Map(targetKey → { kind, version }) — the policy's record */
  const observed = new Map()
  /** abs path → version token; bumped on every mutation (also by `externalWrite`) */
  const versions = new Map()
  const events = []
  const registered = []
  const owner = (exec) => exec?.agent?.session?.id ?? '(none)'
  const versionOf = (abs) => versions.get(abs) ?? `v0:${statSync(abs).size}`
  const bump = (abs) => { versions.set(abs, `v${versions.size + events.length + 1}`); return versions.get(abs) }
  const mk = (abs) => ({ targetKey: abs, path: abs, displayPath: abs })
  const fence = (target, policy) => {
    if (policy?.mode === 'read-only') throw new FsError(`sandbox denied ${target.path}`, 'FS_SANDBOX_DENIED')
    if (policy?.mode === 'workspace-write' && !target.path.startsWith(policy.workspaceRoot)) throw new FsError(`sandbox denied ${target.path}`, 'FS_SANDBOX_DENIED')
  }

  const fs = {
    sandboxMode: mode,
    async resolve(path, opts) {
      return mk(isAbsolute(path) ? path : resolvePath(opts?.cwd ?? workspaceRoot, path))
    },
    async stat(target) {
      try {
        const s = statSync(target.path)
        return { version: versionOf(target.path), type: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other', ...s.isFile() ? { size: s.size } : {} }
      } catch { return undefined }
    },
    async listDir(target) {
      return readdirSync(target.path, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => {
          const abs = resolvePath(target.path, d.name)
          const type = d.isFile() ? 'file' : d.isDirectory() ? 'directory' : 'other'
          return { name: d.name, type, target: mk(abs), ...type === 'file' ? { size: statSync(abs).size } : {} }
        })
    },
    async readText(target) { return readFileSync(target.path, 'utf8') },
    async writeText(target, content, _expected, _signal, policy) {
      fence(target, policy)
      mkdirSync(dirname(target.path), { recursive: true })
      writeFileSync(target.path, content)
      return { operation: 'update', version: bump(target.path), before: null, after: content }
    },
    async editText(target, edit, expected, _signal, policy) {
      fence(target, policy)
      let before
      try { before = readFileSync(target.path, 'utf8') } catch { throw new FsError(`${target.path} not found`, 'FS_NOT_FOUND') }
      if (expected !== undefined && expected.version !== versionOf(target.path)) {
        throw new FsError(`cannot edit "${target.path}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const count = before.split(edit.oldString).length - 1
      if (count === 0) throw new FsError(`old_string was not found in "${target.path}"`, 'FS_EDIT_NO_MATCH')
      if (count > 1 && !edit.replaceAll) throw new FsError(`old_string appears ${count} times in "${target.path}"`, 'FS_EDIT_AMBIGUOUS')
      const after = edit.replaceAll ? before.split(edit.oldString).join(edit.newString) : before.replace(edit.oldString, () => edit.newString)
      writeFileSync(target.path, after)
      return { version: bump(target.path), before, after }
    },
  }

  const ctx = {
    fs,
    events,
    registered,
    logger: { info() {}, warn() {} },
    tools: { register(t) { registered.push(t) }, get(name) { return registered.find(t => t.name === name) } },
    systemPrompt: { sections: [], section(s) { this.sections.push(s) }, getSectionOrder() { return 1500 } },
    get(name) {
      if (name === 'fs') return fs
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode, workspaceRoot }) }
      return undefined
    },
    emit(name, target, state, exec) {
      events.push({ name, path: target.path, state })
      if (name !== 'fs/observed' || !withPolicy) return
      const map = observed.get(owner(exec)) ?? new Map()
      map.set(target.targetKey, state)
      observed.set(owner(exec), map)
    },
    async waterfall(name, target, exec, fallback) {
      if (name !== 'fs/edit-intent' || !withPolicy) return fallback()
      const state = observed.get(owner(exec))?.get(target.targetKey)
      if (state === undefined) throw new FsError(`edit requires reading "${target.path}" first`, 'FS_NOT_OBSERVED')
      if (state.kind === 'absent') throw new FsError(`"${target.path}" was observed absent`, 'FS_NOT_FOUND')
      return { version: state.version }
    },
    /** Test helper: what the in-tree `read` does — record a present observation for this owner. */
    markRead(exec, abs) {
      const map = observed.get(owner(exec)) ?? new Map()
      map.set(abs, { kind: 'present', version: versionOf(abs) })
      observed.set(owner(exec), map)
    },
    /** Test helper: a write by someone else (bash), which moves the version without an observation. */
    externalWrite(abs, content) {
      writeFileSync(abs, content)
      bump(abs)
    },
  }
  return ctx
}

export function fakeExec(sessionId, cwd) {
  return { agent: { id: sessionId, session: { id: sessionId, header: { id: sessionId, cwd } } }, signal: undefined, callId: 'call-1' }
}

/** Render a canonical value through the tool's own output.render → text. */
export function textOf(tool, args, value) {
  return tool.output.render(args, value).map(b => b.text).join('\n')
}
