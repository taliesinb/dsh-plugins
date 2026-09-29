/**
 * Host routes of the plugin (index.js), document-relative: behind a
 * path-mounting proxy an absolute `/api` would escape the mount.
 */
import type { Family } from '../../shared/branches.mjs'

const TREE_PATH = './api/message-branches/tree'
const EDIT_PATH = './api/message-branches/edit'

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** A newly attached image, base64 as the gateway's own prompt wire carries it. */
export interface EncodedImage {
  readonly mediaType: ImageMediaType
  readonly data: string
  readonly name?: string
}

export interface EditRequest {
  readonly sessionId: string
  readonly turn: number
  readonly text: string
  /** Attachment ids of the original message to carry over. */
  readonly keep: readonly string[]
  readonly images: readonly EncodedImage[]
  /** Receipts of files uploaded against `sessionId` through the shipped upload service. */
  readonly files: readonly { readonly receiptId: string }[]
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (isRecord(body) && typeof body.error === 'string') return body.error
  } catch {
    // Not JSON: fall through to the status line.
  }
  return `${response.status} ${response.statusText}`.trim()
}

/** The whole family (root + fork descendants) of one session. */
export async function fetchFamily(sessionId: string, signal?: AbortSignal): Promise<ApiResult<Family>> {
  try {
    const response = await fetch(`${TREE_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return { ok: false, error: await readError(response) }
    const body: unknown = await response.json()
    if (!isRecord(body) || typeof body.root !== 'string' || !isRecord(body.members)) {
      return { ok: false, error: 'malformed tree answer' }
    }
    return { ok: true, value: body as unknown as Family }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Fork before the turn and queue the edited prompt; resolves to the child session id. */
export async function postEdit(request: EditRequest): Promise<ApiResult<string>> {
  try {
    const response = await fetch(EDIT_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    if (!response.ok) return { ok: false, error: await readError(response) }
    const body: unknown = await response.json()
    if (!isRecord(body) || typeof body.sessionId !== 'string') return { ok: false, error: 'malformed edit answer' }
    return { ok: true, value: body.sessionId }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
