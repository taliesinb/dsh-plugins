/**
 * tali-session-title-slug — browser half.
 *
 * Feature: a New Session can be NAMED at creation by starting its first
 * prompt with a slug — `foo-bar-baz: do the thing`. The slug becomes the
 * session title; the prompt goes to the model untouched (the slug doubles as
 * a hint about the task). While the user types, the sidebar's selected "New
 * Session" row previews the slug live and reverts when the prefix stops
 * matching. No config.
 *
 * HOW — one invisible entry in `conversation.input.dock` (a session-scoped
 * list slot rendered above the composer, hero layout included, so it exists
 * for exactly the session the user is typing into). It reads the standard
 * session props:
 *   - `useInput(s => s.draft)`  — live composer text (clipboard projection).
 *   - `useSession(s => s.blank)` — the host's "no turn yet" bit.
 *   - `useSession(s => s.pendingSubmissions)` — local echoes of prompts as
 *     sent: their `.text` is the exact prompt (ordinary sends clear the draft
 *     synchronously and never leave the `plain` input phase, so the draft
 *     itself cannot be read at send time).
 *
 * WHEN THE RENAME HAPPENS — a submission echo on a blank session ARMS the
 * slug parsed from the echo text; the rename fires when `blank` flips false,
 * which the Session Controller does locally on the prompt RPC's SUCCESS
 * (manager.ts "local first-send flip"). Renaming earlier would pin a `user`
 * title on a still-blank session if the prompt were rejected; renaming the
 * blank session live while typing would do the same and could never be
 * undone (an empty title is invalid) — and it would not even show, because
 * blank rows render the localized New Session label regardless of title.
 * `session.rename` records a `user`-source title, which supersedes the
 * in-flight automatic (LLM) title and stops later automatic retitling.
 *
 * The preview is a DOM patch of the sidebar row; see preview.ts for why.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only imports (erased): declaration-merge the slot map, the session
// standard props (useSession) and the composer standard props (useInput).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef } from 'react'
import { parseSlug } from './slug.ts'
import { installPreview } from './preview.ts'

export { parseSlug } from './slug.ts'

/** The branded session id, taken from the Sessions face (avoids linking @deepseek-ai/dsh-session for one type). */
type SessionId = Parameters<ISessions['binding']>[0]

/** Registration inject face: plain callbacks created in apply. */
interface Injected {
  /** Rename one listed session through its Session face (fire-and-forget; failures are logged). */
  renameSession: (sessionId: SessionId, title: string) => void
  /** Publish the slug the selected blank row should preview (`undefined` restores the label). */
  setPreview: (sessionId: SessionId, slug: string | undefined) => void
}

type Props = PropsRuntime<'conversation.input.dock'> & Injected

/** Renders nothing; observes the composer and the session for this slot's session. */
function SlugWatcher({ sessionId, useInput, useSession, renameSession, setPreview }: Props) {
  const draft = useInput(state => state.draft)
  const blank = useSession(snapshot => snapshot.blank)
  const pending = useSession(snapshot => snapshot.pendingSubmissions)

  // Live preview: only a blank session has a "New Session" row to relabel.
  const previewSlug = blank ? parseSlug(draft) : undefined
  useEffect(() => {
    setPreview(sessionId, previewSlug)
    return () => { setPreview(sessionId, undefined) }
  }, [sessionId, previewSlug, setPreview])

  // Arm on the submission echo (exact prompt text), fire on the blank flip.
  // Effects run in declaration order, so when the echo and the flip land in
  // one render the arm effect still precedes the fire effect.
  const armed = useRef<string | undefined>(undefined)
  const seenEchoes = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!blank) return
    for (const echo of pending) {
      if (seenEchoes.current.has(echo.requestId)) continue
      seenEchoes.current.add(echo.requestId)
      armed.current = parseSlug(echo.text)
    }
  }, [pending, blank])

  const wasBlank = useRef(blank)
  useEffect(() => {
    if (wasBlank.current && !blank && armed.current !== undefined) {
      renameSession(sessionId, armed.current)
      armed.current = undefined
    }
    wasBlank.current = blank
  }, [blank, sessionId, renameSession])

  return null
}

export const name = 'session-title-slug-client'
export const inject = ['slots', 'sessions']

/**
 * Client plugin body: install the sidebar preview patcher and contribute the
 * watcher into the input dock once ui-conversation has declared the slot.
 * @param ctx - browser-side cordis context.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.get('sessions') as ISessions
  const preview = installPreview()
  ctx.effect(() => () => { preview.dispose() }, 'session-title-slug: sidebar preview')

  // One preview at a time: the last blank session to report wins, and only
  // its own clear resets it (a stale clear from an unmounting sibling must
  // not blank a newer session's preview).
  let previewOwner: SessionId | undefined
  const injected = (): Injected => ({
    setPreview: (sessionId, slug) => {
      if (slug === undefined) {
        if (previewOwner !== sessionId) return
        previewOwner = undefined
        preview.set(undefined)
        return
      }
      previewOwner = sessionId
      preview.set(slug)
    },
    renameSession: (sessionId, title) => {
      const session = sessions.binding(sessionId)?.session
      if (session === undefined) {
        ctx.logger.warn(`session-title-slug: no binding for ${sessionId}; title "${title}" not applied`)
        return
      }
      session.rename(title).then((result) => {
        if (result.ok) ctx.logger.info(`session-title-slug: named ${sessionId} "${result.value.title}"`)
        else ctx.logger.warn(`session-title-slug: rename failed: ${result.error.code}: ${result.error.message}`)
      }, (error: unknown) => {
        ctx.logger.warn(`session-title-slug: rename threw: ${String(error)}`)
      })
    },
  })

  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'tali-session-title-slug', order: 1000, inject: injected },
      SlugWatcher,
    ))
}
