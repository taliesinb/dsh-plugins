/**
 * A fake plugin Context for tests: `ctx.sessionQuery` over fixture snapshots,
 * a `ctx.fs` that writes under a temp root and denies paths outside it (the
 * FS_SANDBOX_DENIED shape of dsh-fs-sandbox), and a `sandboxPolicy` resolver.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'

export function fakeCtx({ snapshots, live = new Set(), titles = {}, cwds = {}, workspaceRoot, mode = 'workspace-write', unreadable = new Set() }) {
  const records = () => snapshots.map(s => ({
    header: { ...s.session, ...cwds[s.session.id] ? { cwd: cwds[s.session.id] } : {} },
    live: live.has(s.session.id),
    persisted: true,
  }))
  const byId = (id) => snapshots.find(s => s.session.id === id)
  const calls = []
  const denied = (path) => Object.assign(new Error(`sandbox denied ${path}`), { code: 'FS_SANDBOX_DENIED' })
  const ctx = {
    calls,
    logger: { info() {}, warn() {} },
    sessionQuery: {
      async listSessions() { calls.push('listSessions'); return records() },
      async readSession(id) {
        calls.push(`readSession:${id}`)
        if (unreadable.has(id)) throw new Error(`failed to read stored session "${id}": assistant/message 1023 chunk references are not one complete ordered attempt`)
        const s = byId(id)
        if (!s) throw new Error(`not found ${id}`)
        return { session: { ...s.session, ...cwds[id] ? { cwd: cwds[id] } : {} }, inheritedEventCount: 0, events: structuredClone(s.events) }
      },
      async readTitleSnapshots(ids) {
        calls.push(`readTitleSnapshots:${ids.length}`)
        return ids.map(id => {
          const s = byId(id)
          if (!s) return { sessionId: id, status: 'rejected', reason: new Error('nope') }
          const t = titles[id] ?? [...s.events].reverse().find(e => e.type === 'session/title')?.data?.title
          return { sessionId: id, status: 'fulfilled', value: { session: s.session, ...t ? { title: { title: t } } : {} } }
        })
      },
    },
    get(name) {
      if (name === 'fs') return fs
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode, workspaceRoot }) }
      return undefined
    },
  }
  const fs = {
    async resolve(path, opts) {
      const abs = isAbsolute(path) ? path : resolvePath(opts?.cwd ?? workspaceRoot, path)
      return { path: abs, displayPath: abs }
    },
    async writeText(target, content, _expected, _signal, policy) {
      if (policy?.mode === 'read-only') throw denied(target.path)
      if (policy?.mode === 'workspace-write' && !target.path.startsWith(policy.workspaceRoot)) throw denied(target.path)
      mkdirSync(dirname(target.path), { recursive: true })
      writeFileSync(target.path, content)
      return { version: 'v1' }
    },
  }
  return ctx
}

/** A minimal ToolExecution: the calling agent's session. */
export function fakeExec(sessionId, cwd) {
  return { agent: { id: sessionId, session: { id: sessionId, header: { id: sessionId, cwd } } }, signal: undefined }
}

/** Render a canonical value through the tool's own output.render → text. */
export function textOf(tool, args, value) {
  return tool.output.render(args, value).map(b => b.text).join('\n')
}
