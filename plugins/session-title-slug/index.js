/**
 * tali-session-title-slug — host half.
 *
 * A first human prompt that begins with `some-slug: ` names the session
 * `some-slug`, on the host, the moment the prompt is committed: the title is
 * written with the `user` source (the same as a sidebar Rename), which pins it
 * and supersedes the pending automatic (LLM) title generation — so no model is
 * ever asked to summarize a prompt the user already named. This works for every
 * client of this host, including a remote shell framing one of its sessions.
 *
 * The browser half (src/client) stays for the live preview of the slug in the
 * New Session row and as a fallback rename; its rename lands after this one
 * with the same text, so nothing changes.
 *
 * Grammar (shared with src/client/slug.ts): `^\s*([a-z0-9][a-z0-9_-]*):(?=\s|$)`,
 * at most 64 characters, first human prompt only.
 */
export const name = 'session-title-slug'
export const inject = ['sessionTitle', 'sessions']

const SLUG_RE = /^\s*([a-z0-9][a-z0-9_-]*):(?=\s|$)/u
const MAX_TITLE_CHARS = 64

/**
 * @param {string} text
 * @returns {string | undefined}
 */
export function parseSlug(text) {
  const match = SLUG_RE.exec(text)
  if (match === null) return undefined
  const slug = match[1]
  if (slug === undefined || slug.length === 0 || slug.length > MAX_TITLE_CHARS) return undefined
  return slug
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 */
export function apply(ctx) {
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' || event.data.source?.kind !== 'user') return
    // First human prompt only: a slug typed later is just text. Count human
    // prompts in the log rather than trusting the title state (the fallback
    // title is written asynchronously after this very event).
    // oxlint-disable-next-line typescript/no-deprecated -- log read, same as the title service itself
    const humanPrompts = session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source?.kind === 'user')
    if (humanPrompts.length !== 1) return
    // Never override a name the user gave explicitly (sidebar Rename before the first prompt).
    if (ctx.sessionTitle.get(session)?.source.kind === 'user') return
    const text = (event.data.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    const slug = parseSlug(text)
    if (slug === undefined) return
    try {
      ctx.sessionTitle.rename(session, slug)
    } catch (error) {
      ctx.logger.warn(`session-title-slug: could not name session "${session.id}" "${slug}": ${String(error)}`)
    }
  })
}
