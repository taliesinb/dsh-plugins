/**
 * Replacement renderer for the `user` Chat node: the shipped bubble (text,
 * attachments, references) plus three additions in its actions row — an Edit
 * action that turns the bubble into an editor, a ‹ i/n › switcher when other
 * versions of the message exist in the family, and a versions list behind the
 * counter. Sending the editor forks the session before this turn and opens
 * the branch (apply.ts owns that choreography).
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  FileTypeIcon, IconCheckOutline16, IconChevronLeftOutline14, IconChevronRightOutline14, IconCopyOutline16,
  IconEditOutline16, IconPaperclipOutline16, JsonBlock, Tooltip, fileExtension, fileSizeText,
  projectUserText, useDismissOnOutsidePointer, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only (erased): slot declarations and standard props.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { ownerOf, siblingsAt, type Member } from '../../shared/branches.mjs'
import type { ApiResult, EditRequest, EncodedImage, ImageMediaType } from './api.ts'
import type { FamilyState } from './families.ts'

export interface UserMessageInjected {
  hooks: { family: ObservableSnapshot<FamilyState> }
  /** Make sure this session's family is loaded (cheap when fresh). */
  ensureFamily(): void
  /** Open another version's session in the main view. */
  switchTo(sessionId: string): void
  /** Fork before `turn` with the edited content and open the branch; resolves with the child id or an error. */
  submitEdit(input: Omit<EditRequest, 'sessionId'>): Promise<ApiResult<string>>
  /** Upload one new non-image file against this session; the receipt travels in the edit request. */
  uploadFile(file: File): Promise<ApiResult<{ receiptId: string }>>
}

type Props = PropsRuntime<'conversation.chat.node', 'user'> & InjectFace<UserMessageInjected>

type FileRef = { attachmentId: string; name: string; bytes: number }
type ContentAttachment =
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }
  | { readonly type: 'file'; readonly attachment: FileRef }

function contentParts(content: readonly unknown[]): { text: string; attachments: ContentAttachment[]; rest: unknown[] } {
  const texts: string[] = []
  const attachments: ContentAttachment[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'image' && b.attachment !== undefined) attachments.push({ type: 'image', attachment: b.attachment as ImageAttachmentRef })
    else if (b.type === 'file' && b.attachment !== undefined) attachments.push({ type: 'file', attachment: b.attachment as FileRef })
    else rest.push(block)
  }
  return { text: texts.join(''), attachments, rest }
}

function clock(time: number): string {
  const date = new Date(time)
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  const hm = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return sameDay ? hm : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hm}`
}

function turnOf(node: Props['node']): number | undefined {
  const location = node.location
  return location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined
}

// ------------------------------------------------------------------ actions

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])
  const onCopy = useCallback(() => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      timer.current = window.setTimeout(() => { timer.current = null; setCopied(false) }, 1000)
    })
  }, [text])
  return (
    <Tooltip label={copied ? 'Copied' : 'Copy'} side="bottom">
      <button type="button" className="mb-action" aria-label={copied ? 'Copied' : 'Copy'} onClick={onCopy}>
        {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
      </button>
    </Tooltip>
  )
}

function VersionSwitcher({ siblings, currentId, turn, onSwitch }: {
  siblings: readonly Member[]
  currentId: string
  turn: number
  onSwitch: (sessionId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  useDismissOnOutsidePointer(root, open, setOpen)
  const index = Math.max(0, siblings.findIndex(member => member.id === currentId))
  const previous = siblings[index - 1]
  const next = siblings[index + 1]
  const label = `${index + 1}/${siblings.length}`
  return (
    <div ref={root} className="mb-switcher" style={{ position: 'relative' }} data-mb-switcher>
      <button type="button" className="mb-action" aria-label="Previous version" disabled={previous === undefined}
        onClick={() => { if (previous !== undefined) onSwitch(previous.id) }}>
        <IconChevronLeftOutline14 />
      </button>
      <Tooltip label="Versions of this message" side="bottom" disabled={open}>
        <button type="button" className="mb-switcherCount" aria-label={`Version ${label}`} aria-expanded={open} aria-haspopup="listbox"
          onClick={() => { setOpen(!open) }}>
          {label}
        </button>
      </Tooltip>
      <button type="button" className="mb-action" aria-label="Next version" disabled={next === undefined}
        onClick={() => { if (next !== undefined) onSwitch(next.id) }}>
        <IconChevronRightOutline14 />
      </button>
      {open && (
        <div className="mb-popover" role="listbox" aria-label="Versions" style={{ top: 'calc(100% + 4px)', right: 0 }}>
          <div className="mb-popoverTitle">Versions</div>
          {siblings.map((member, i) => {
            const preview = member.previews[String(turn)]
            const current = member.id === currentId
            return (
              <button key={member.id} type="button" role="option" aria-selected={current} className="mb-versionRow" data-current={current || undefined}
                onClick={() => { setOpen(false); if (!current) onSwitch(member.id) }}>
                <span className="mb-currentDot" data-off={current ? undefined : ''} />
                <span className="mb-versionIndex">{i + 1}</span>
                <span className="mb-versionText" data-empty={preview === undefined || preview === '' ? '' : undefined}>
                  {preview === undefined || preview === '' ? 'no text' : preview}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------- editor

type NewAttachment =
  | { readonly key: string; readonly kind: 'image'; readonly name: string; readonly previewUrl: string; readonly image: EncodedImage }
  | { readonly key: string; readonly kind: 'file'; readonly name: string; readonly bytes: number; readonly receiptId?: string; readonly error?: string }

const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')) }
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

function KeptImageChip({ attachment, loadImage, onRemove }: {
  attachment: ImageAttachmentRef
  loadImage: Props['loadImage']
  onRemove: () => void
}) {
  const [url, setUrl] = useState<string | undefined>(() => loadImage.peek?.(attachment))
  useEffect(() => {
    let live = true
    if (url === undefined) void loadImage(attachment).then((resolved) => { if (live) setUrl(resolved) }).catch(() => undefined)
    return () => { live = false }
  }, [attachment, loadImage, url])
  const name = attachment.name ?? 'image'
  return (
    <span className="mb-chip" title={name}>
      {url === undefined ? <span className="mb-chipThumb" /> : <img className="mb-chipThumb" src={url} alt="" />}
      <span className="mb-chipName">{name}</span>
      <button type="button" className="mb-chipRemove" aria-label={`Remove ${name}`} onClick={onRemove}>×</button>
    </span>
  )
}

function FileChip({ name, bytes, pending, error, onRemove }: {
  name: string
  bytes: number
  pending?: boolean
  error?: string | undefined
  onRemove: () => void
}) {
  return (
    <span className="mb-chip" title={error ?? name} data-pending={pending || undefined} data-error={error === undefined ? undefined : ''}>
      <FileTypeIcon path={name} className="mb-chipIcon" />
      <span className="mb-chipName">{name}{bytes > 0 ? ` · ${fileSizeText(bytes)}` : ''}</span>
      <button type="button" className="mb-chipRemove" aria-label={`Remove ${name}`} onClick={onRemove}>×</button>
    </span>
  )
}

function Editor({ initialText, original, loadImage, busy, error, onCancel, onSend, uploadFile }: {
  initialText: string
  original: readonly ContentAttachment[]
  loadImage: Props['loadImage']
  busy: boolean
  error: string | undefined
  onCancel: () => void
  onSend: (payload: Omit<EditRequest, 'sessionId' | 'turn'>) => void
  uploadFile: UserMessageInjected['uploadFile']
}) {
  const [text, setText] = useState(initialText)
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set(original.map(a => a.attachment.attachmentId)))
  const [added, setAdded] = useState<readonly NewAttachment[]>([])
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const picker = useRef<HTMLInputElement | null>(null)
  const addedRef = useRef(added)
  addedRef.current = added

  useEffect(() => {
    const element = textarea.current
    if (element === null) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  }, [])
  // Keep the box sized to its content.
  useEffect(() => {
    const element = textarea.current
    if (element === null) return
    element.style.height = '0px'
    element.style.height = `${Math.min(element.scrollHeight, window.innerHeight * 0.5)}px`
  }, [text])
  useEffect(() => () => {
    for (const attachment of addedRef.current) if (attachment.kind === 'image') URL.revokeObjectURL(attachment.previewUrl)
  }, [])

  const uploading = added.some(a => a.kind === 'file' && a.receiptId === undefined && a.error === undefined)
  const sendable = !busy && !uploading && (text.trim() !== '' || kept.size > 0 || added.length > 0)

  const send = useCallback(() => {
    if (!sendable) return
    onSend({
      text,
      keep: original.filter(a => kept.has(a.attachment.attachmentId)).map(a => a.attachment.attachmentId),
      images: added.flatMap(a => a.kind === 'image' ? [a.image] : []),
      files: added.flatMap(a => a.kind === 'file' && a.receiptId !== undefined ? [{ receiptId: a.receiptId }] : []),
    })
  }, [added, kept, onSend, original, sendable, text])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); return }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() }
  }

  const addFiles = useCallback((files: FileList | null) => {
    if (files === null) return
    for (const file of Array.from(files)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      if (IMAGE_TYPES.has(file.type)) {
        void readAsBase64(file).then((data) => {
          setAdded(list => [...list, {
            key, kind: 'image', name: file.name, previewUrl: URL.createObjectURL(file),
            image: { mediaType: file.type as ImageMediaType, data, ...(file.name === '' ? {} : { name: file.name }) },
          }])
        })
        continue
      }
      setAdded(list => [...list, { key, kind: 'file', name: file.name, bytes: file.size }])
      void uploadFile(file).then((result) => {
        setAdded(list => list.map(a => a.key !== key || a.kind !== 'file'
          ? a
          : result.ok ? { ...a, receiptId: result.value.receiptId } : { ...a, error: result.error }))
      })
    }
  }, [uploadFile])

  const removeAdded = (key: string) => {
    setAdded((list) => {
      const gone = list.find(a => a.key === key)
      if (gone?.kind === 'image') URL.revokeObjectURL(gone.previewUrl)
      return list.filter(a => a.key !== key)
    })
  }

  return (
    <div className="mb-editor" data-mb-editor>
      <textarea ref={textarea} className="mb-editorText" value={text} rows={1} disabled={busy}
        onChange={(event) => { setText(event.target.value) }} onKeyDown={onKeyDown}
        onPaste={(event) => { if (event.clipboardData.files.length > 0) { event.preventDefault(); addFiles(event.clipboardData.files) } }} />
      <div className="mb-chips">
        {original.filter(a => kept.has(a.attachment.attachmentId)).map(a => a.type === 'image'
          ? <KeptImageChip key={a.attachment.attachmentId} attachment={a.attachment} loadImage={loadImage}
            onRemove={() => { setKept(set => { const next = new Set(set); next.delete(a.attachment.attachmentId); return next }) }} />
          : <FileChip key={a.attachment.attachmentId} name={a.attachment.name} bytes={a.attachment.bytes}
            onRemove={() => { setKept(set => { const next = new Set(set); next.delete(a.attachment.attachmentId); return next }) }} />)}
        {added.map(a => a.kind === 'image'
          ? (
            <span key={a.key} className="mb-chip" title={a.name}>
              <img className="mb-chipThumb" src={a.previewUrl} alt="" />
              <span className="mb-chipName">{a.name}</span>
              <button type="button" className="mb-chipRemove" aria-label={`Remove ${a.name}`} onClick={() => { removeAdded(a.key) }}>×</button>
            </span>
          )
          : <FileChip key={a.key} name={a.name} bytes={a.bytes} pending={a.receiptId === undefined && a.error === undefined} error={a.error}
            onRemove={() => { removeAdded(a.key) }} />)}
        <button type="button" className="mb-chipAdd" onClick={() => { picker.current?.click() }} disabled={busy}>
          <IconPaperclipOutline16 /> Attach
        </button>
        <input ref={picker} type="file" multiple hidden onChange={(event) => { addFiles(event.target.files); event.target.value = '' }} />
      </div>
      <div className="mb-editorBar">
        <span className="mb-editorError" title={error}>{error}</span>
        <button type="button" className="mb-button" data-variant="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="mb-button" data-variant="primary" onClick={send} disabled={!sendable}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------- view

/** The `user` Chat node with edit, version switcher and versions list. */
export const UserMessageView = memo(function UserMessageView(props: Props) {
  const { node, renderMessageImages, openFile, openSkill, loadImage, sessionId, useFamily, ensureFamily, switchTo, submitEdit, uploadFile } = props
  const data = node.data
  const turn = turnOf(node)
  const { text, attachments, rest } = useMemo(() => contentParts(data.content), [data.content])
  const referenceLabels = data.referenceLabels ?? []
  const skillNames = data.skillNames ?? []
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => { ensureFamily() }, [ensureFamily])
  const family = useFamily(state => state.family)
  const siblings = useMemo(() => (family === undefined || turn === undefined ? [] : siblingsAt(family, sessionId, turn)), [family, sessionId, turn])
  const owner = family === undefined || turn === undefined ? undefined : ownerOf(family, sessionId, turn)

  const onSend = useCallback((payload: Omit<EditRequest, 'sessionId' | 'turn'>) => {
    if (turn === undefined) return
    setBusy(true)
    setError(undefined)
    void submitEdit({ turn, ...payload }).then((result) => {
      setBusy(false)
      if (result.ok) setEditing(false)
      else setError(result.error)
    })
  }, [submitEdit, turn])

  const showBubble = text !== '' || rest.length > 0
  const compactImages = attachments.length > 1
  return (
    <div className="mb-userRow" data-mb-editing={editing || undefined}>
      <div className="mb-stack">
        {editing
          ? (
            <Editor initialText={text} original={attachments} loadImage={loadImage} busy={busy} error={error}
              onCancel={() => { if (!busy) { setEditing(false); setError(undefined) } }} onSend={onSend} uploadFile={uploadFile} />
          )
          : (
            <>
              {attachments.length > 0 && (
                <div className="mb-attachmentRow" data-message-attachments>
                  {attachments.map((attachment, index) => attachment.type === 'image'
                    ? (
                      <Fragment key={`image:${index}`}>
                        {renderMessageImages({ images: [{ attachment: attachment.attachment }], align: 'end', compact: compactImages })}
                      </Fragment>
                    )
                    : (
                      <span key={`file:${index}`} className="mb-fileCard" title={attachment.attachment.name}>
                        <FileTypeIcon path={attachment.attachment.name} className="mb-fileIcon" />
                        <span className="mb-fileContent">
                          <span className="mb-fileName">{attachment.attachment.name}</span>
                          <span className="mb-fileMeta">
                            {[fileExtension(attachment.attachment.name).toUpperCase().slice(0, 8), fileSizeText(attachment.attachment.bytes)].filter(Boolean).join(' ')}
                          </span>
                        </span>
                      </span>
                    ))}
                </div>
              )}
              {showBubble && (
                <div className="mb-bubble">
                  {projectUserText(text, referenceLabels, skillNames, 'skill', { openFile, openSkill })}
                  {rest.map((block, i) => <JsonBlock key={i} label="Extra block" payload={block} truncatedLabel={total => `${total} more`} />)}
                </div>
              )}
              {referenceLabels.length > 0 && <div className="mb-referenceSummary">{referenceLabels.join(', ')}</div>}
            </>
          )}
      </div>
      <div className="mb-actions">
        <span className="mb-time">{clock(data.time)}</span>
        <CopyAction text={text} />
        {turn !== undefined && !editing && (
          <Tooltip label="Edit message (new branch)" side="bottom">
            <button type="button" className="mb-action" aria-label="Edit message" onClick={() => { setEditing(true) }}>
              <IconEditOutline16 />
            </button>
          </Tooltip>
        )}
        {turn !== undefined && siblings.length > 1 && owner !== undefined && (
          <VersionSwitcher siblings={siblings} currentId={owner.id} turn={turn} onSwitch={switchTo} />
        )}
      </div>
    </div>
  )
})
