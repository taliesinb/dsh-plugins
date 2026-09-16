/**
 * The slug grammar, kept pure so it can be unit-tested under plain Node.
 *
 * A prompt names its New Session when it STARTS with a slug followed by a
 * colon and whitespace:
 *
 *   foo-bar-baz: rename the widget                -> "foo-bar-baz"
 *   fix_login2: the login form...                  -> "fix_login2"
 *
 * Grammar (deliberately narrow, to avoid catching prose):
 *   - lowercase ASCII letters, digits, `-` and `_` only; must start with a
 *     letter or digit. Capitalized prose openers ("Note:", "Question:",
 *     "TODO:") therefore never match.
 *   - the colon must be followed by whitespace (or end the text), so
 *     `http://…`, `foo:bar` and Windows drive letters never match.
 *   - leading whitespace before the slug is tolerated.
 */
const SLUG_RE = /^\s*([a-z0-9][a-z0-9_-]*):(?=\s|$)/u

/** Longest title the plugin will ever set (the host normalizes further). */
const MAX_TITLE_CHARS = 80

/**
 * Extract the session-title slug from prompt text.
 * @param text - the composer draft or the exact prompt text as sent.
 * @returns the slug when the text starts with `slug: `, else undefined.
 */
export function parseSlug(text: string): string | undefined {
  const match = SLUG_RE.exec(text)
  if (match === null) return undefined
  const slug = match[1]
  if (slug === undefined || slug.length === 0 || slug.length > MAX_TITLE_CHARS) return undefined
  return slug
}
