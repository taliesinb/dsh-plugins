/**
 * Wolfram kernel supervisor, browser half: keyed toolviews that render the
 * plugin's tool cards in the chat.
 *
 *   wolfram_show   the image, at POINT size (devicePixels / scale), from the
 *                  attachment reference the host persisted in the call's
 *                  presentationMeta (block.meta). The model never saw it.
 *   wolfram_eval   text output plus any image blocks the result carries
 *   wolfram_run    (same row as wolfram_eval)
 *
 * plus SLASH COMMAND cards: /wolfram-show, /wolfram and /wolfram-kernels (host
 * commands that need no model) render through the keyed
 * `conversation.chat.commandview` slot — the show command returns the same
 * presentation payload as the tool's presentationMeta, as JSON in the result
 * text, so its card is identical (image, widget, caption).
 *
 * plus INTERACTIVE Manipulate widgets: when the host's presentationMeta carries
 * a `manipulate` descriptor (kernel/DSHPlugin.wl parsed the control specs),
 * native controls render next to the image and, on release, the <img> reloads
 * from GET /api/wolfram/manipulate?…&values=[…] — a fresh rasterization in the
 * same kernel. One request in flight at a time, latest value wins; a 410 (kernel
 * gone) disables the controls with a note.
 *
 * plus a PINNED GALLERY under each turn's final answer: in the default
 * "compact" transcript view the chat folds a settled turn's tool rows into a
 * "N tool calls" disclosure, which would hide the very image wolfram_show
 * exists to show. The turn-tail node (`conversation.chat.turnTail` chain) is
 * never folded, so a turn-scoped event accumulator collects every successful
 * wolfram_show of the turn (from the tool/result events' presentationMeta) and
 * the gallery renders them there, at point size. Pattern: ui-deliverables.
 *
 * Why a toolview: the generic tool card flattens non-text result blocks to
 * JSON, and image rendering is only possible from a keyed entry
 * (<checkout>/.agents/notes/implemented/feature/2026-08-20-tool-card-image-results.md).
 * The shared `tool.call.images` gallery slot is owned by the read_image entry
 * and a child slot has exactly one owner, so this row draws its own <img>
 * with the session-authorized `loadImage` loader every toolview receives.
 *
 * Claiming a key suppresses the generic card for EVERY shape of that tool, so
 * each row covers running / error / cancelled / missing-meta by falling back
 * to a plain text body.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports (erased at build time): SlotMap merges for
// 'tool.call.toolview' and the session-scope standard props.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DisclosureRow, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

type Props = PropsRuntime<'tool.call.toolview'>
type Block = Props['block']
type LoadImage = Props['loadImage']

/** Mirror of dsh-attachment's ImageAttachmentRef (runtime narrowing at the wire boundary). */
interface ImageRef {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
}

const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
/** Defensive narrowing: the id is opaque (existence only), everything else exact. */
function asImageRef(value: unknown): ImageRef | undefined {
  if (!isRecord(value)) return undefined
  const { attachmentId, mediaType, bytes, width, height, name } = value
  if (typeof attachmentId !== 'string' || attachmentId === '') return undefined
  if (typeof mediaType !== 'string' || !MEDIA_TYPES.has(mediaType)) return undefined
  if (!positiveInt(bytes) || !positiveInt(width) || !positiveInt(height)) return undefined
  const ref: ImageRef = { attachmentId, mediaType: mediaType as ImageRef['mediaType'], bytes, width, height }
  if (typeof name === 'string') ref.name = name
  return ref
}

function isSettled(block: Block): block is Extract<Block, { kind: 'tool-result' }> {
  return 'kind' in block
}

/** Flattened result text: text blocks verbatim, image blocks omitted (they render), others as JSON. */
function resultText(block: Block): string {
  if (!isSettled(block)) return ''
  const parts: string[] = []
  for (const item of block.content) {
    if (item.type === 'text') parts.push(item.text)
    else if (item.type !== 'image') parts.push(JSON.stringify(item, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n').trim()
}

function imageRefsOf(block: Block): ImageRef[] {
  if (!isSettled(block)) return []
  const refs: ImageRef[] = []
  for (const item of block.content) {
    if (item.type === 'image' && 'attachment' in item) {
      const ref = asImageRef((item as { attachment?: unknown }).attachment)
      if (ref !== undefined) refs.push(ref)
    }
  }
  return refs
}

function parseArgs(block: Block): Record<string, unknown> {
  const raw = isSettled(block) ? block.call?.argsRaw : block.argsRaw
  if (typeof raw !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** `[wl:0:1]` from the rendered result text (the host prefixes every result with it). */
function kernelIdOf(block: Block): string | undefined {
  const match = /\[(wl:\d+:\d+)\]/.exec(resultText(block))
  return match?.[1]
}

type RowState = 'running' | 'ok' | 'error'
function stateOf(block: Block): RowState {
  if (!isSettled(block)) return 'running'
  return block.isError ? 'error' : 'ok'
}

// ---------------------------------------------------------------- image loading

/**
 * Same-origin URL of the plugin's own image route (host: index.js SHOWN_IMAGE_PATH). The browser sends the auth cookie.
 * Document-relative (`./api/...`): behind a path-mounting proxy (dsh-tailscale-remote at `/dsh/`) `/api` would escape the mount.
 */
function shownImageUrl(sessionId: string, image: ImageRef): string {
  return `./api/wolfram/shown?sessionId=${encodeURIComponent(sessionId)}&attachmentId=${encodeURIComponent(image.attachmentId)}`
}

/**
 * Resolve an image to a displayable URL. A wolfram_show image (referenced only
 * by presentationMeta) comes from the plugin route; a content-block image (a
 * wolfram_eval plot the model also received) goes through the session loader,
 * which the core authorizes from the log's content blocks.
 */
function useImageUrl(source: { url: string } | { loadImage: LoadImage }, image: ImageRef): { url: string | undefined, failed: boolean } {
  const direct = 'url' in source ? source.url : undefined
  const loader = 'loadImage' in source ? source.loadImage : undefined
  const [url, setUrl] = useState<string | undefined>(() => direct ?? loader?.peek?.(image as never))
  const [failed, setFailed] = useState(false)
  const id = image.attachmentId
  useEffect(() => {
    if (direct !== undefined) { setUrl(direct); return }
    if (loader === undefined) return
    let cancelled = false
    setFailed(false)
    loader(image as never).then(
      (resolved) => { if (!cancelled) setUrl(resolved) },
      () => { if (!cancelled) setFailed(true) },
    )
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, direct, loader])
  return { url, failed }
}

/**
 * Shrink-wrapped hairline frame. No fill: the kernel renders graphics for the
 * GUI's own appearance (host `theme`), so the PNG carries the right background
 * and a white plate here would be wrong in dark mode. `width: fit-content`
 * plus `alignSelf: flex-start` stop flex parents from stretching the frame past
 * the image (the bug in the first live build).
 */
const FRAME_PAD = 8
const IMAGE_FRAME: CSSProperties = {
  display: 'block',
  width: 'fit-content',
  maxWidth: '100%',
  alignSelf: 'flex-start',
  padding: FRAME_PAD,
  borderRadius: 8,
  boxShadow: '0 0 0 1px color-mix(in srgb, currentColor 14%, transparent)',
  boxSizing: 'content-box',
}

/**
 * Median colour of an image's one-pixel border ring, as a CSS colour, or
 * 'transparent' when the ring is (mostly) transparent. Fills the frame's padding
 * so the plate matches the raster instead of the rounded corners clipping into it.
 */
function borderMedianColor(img: HTMLImageElement): string | undefined {
  const w = img.naturalWidth, h = img.naturalHeight
  if (w === 0 || h === 0) return undefined
  try {
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx === null) return undefined
    ctx.drawImage(img, 0, 0)
    const rows = [ctx.getImageData(0, 0, w, 1).data, ctx.getImageData(0, h - 1, w, 1).data, ctx.getImageData(0, 0, 1, h).data, ctx.getImageData(w - 1, 0, 1, h).data]
    const ch: number[][] = [[], [], [], []]
    for (const data of rows) for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 4; c++) (ch[c] as number[]).push(data[i + c] as number)
    const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)] ?? 0 }
    const [r, g, b, a] = ch.map(median) as [number, number, number, number]
    if (a < 128) return 'transparent'
    return `rgb(${r} ${g} ${b})`
  } catch {
    return undefined // tainted canvas or decode failure: leave the frame unfilled
  }
}

/** Frame background derived from the loaded image; recomputed whenever the src changes. */
function useFrameColor(): { color: string | undefined, onLoad: (event: { currentTarget: HTMLImageElement }) => void } {
  const [color, setColor] = useState<string | undefined>(undefined)
  const onLoad = useCallback((event: { currentTarget: HTMLImageElement }) => { setColor(borderMedianColor(event.currentTarget)) }, [])
  return { color, onLoad }
}

/** Reveal a plugin-written PNG in the system viewer through the host's open route (paths under showDirectory only). */
function openShown(path: string): void {
  void fetch(`./api/wolfram/open?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' })
}

/** Caption: the label (or the expression head) styled as a link; tooltip = path; click opens the PNG in the system viewer. */
function ShowCaption({ label, path }: { label: string, path: string | undefined }) {
  const text = label !== '' ? label : 'image'
  if (path === undefined) return <div style={{ fontSize: 12, opacity: 0.75 }}>{text}</div>
  return (
    <div style={{ fontSize: 12 }}>
      <a
        href="#"
        title={path}
        onClick={(event) => { event.preventDefault(); openShown(path) }}
        style={{ color: 'inherit', opacity: 0.85, textDecoration: 'underline', textDecorationColor: 'color-mix(in srgb, currentColor 40%, transparent)', textUnderlineOffset: 3, cursor: 'pointer' }}
      >
        {text}
      </a>
    </div>
  )
}

// NB: the reference prop is `image`, not `ref` — React reserves `ref` and
// strips it from a function component's props (it arrived undefined).
function WolframImage({ source, image, pointWidth, alt, path }: { source: { url: string } | { loadImage: LoadImage }, image: ImageRef, pointWidth: number | undefined, alt: string, path: string | undefined }) {
  const { url, failed } = useImageUrl(source, image)
  const [broken, setBroken] = useState(false)
  const frame = useFrameColor()
  const width = pointWidth ?? image.width
  if (failed || broken) return <div style={{ opacity: 0.7, fontSize: 12 }}>[image unavailable{path ? `: ${path}` : ''}]</div>
  if (url === undefined) return <div style={{ ...IMAGE_FRAME, width, aspectRatio: `${image.width} / ${image.height}`, opacity: 0.4 }} />
  return (
    <div style={{ ...IMAGE_FRAME, background: frame.color ?? 'transparent' }}>
      <img
        src={url}
        alt={alt}
        width={width}
        style={{ display: 'block', width, maxWidth: '100%', height: 'auto', cursor: 'zoom-in' }}
        onClick={() => { window.open(url, '_blank', 'noopener') }}
        onError={() => setBroken(true)}
        onLoad={frame.onLoad}
        title={path ?? alt}
      />
    </div>
  )
}



// ---------------------------------------------------------------- label content

const SWATCH: CSSProperties = { display: 'inline-block', width: 10, height: 10, borderRadius: 2, verticalAlign: '-1px', boxShadow: '0 0 0 1px color-mix(in srgb, currentColor 30%, transparent)', marginRight: 4 }

/** Render a label tree as inline HTML; anything unrecognised falls back to its text. Depth-capped. */
function LabelNode({ node, depth = 0 }: { node: LabelTree | null | undefined, depth?: number }): ReactNode {
  if (node === null || node === undefined || typeof node !== 'object' || depth > 8) return null
  const kids = (list: unknown, sep: ReactNode = null): ReactNode[] => (Array.isArray(list) ? list : []).flatMap((child, i) => {
    const el = <LabelNode key={i} node={child as LabelTree} depth={depth + 1} />
    return i > 0 && sep !== null ? [<span key={`s${i}`}>{sep}</span>, el] : [el]
  })
  switch (node.t) {
    case 's': return <>{node.v}</>
    case 'code': return <code style={{ fontSize: '0.92em' }}>{node.v}</code>
    case 'color': return <><span style={{ ...SWATCH, background: node.css }} />{node.v}</>
    case 'list': return <>{kids(node.c, ', ')}</>
    case 'row': return <>{kids(node.c, node.sep ? <LabelNode node={node.sep} depth={depth + 1} /> : null)}</>
    case 'col': return <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, verticalAlign: 'middle' }}>{kids(node.c).map((k, i) => <span key={i}>{k}</span>)}</span>
    case 'assoc': return <>{(Array.isArray(node.c) ? node.c : []).map((pair, i) => (
      <span key={i}>{i > 0 ? ', ' : ''}<LabelNode node={pair[0]} depth={depth + 1} />: <LabelNode node={pair[1]} depth={depth + 1} /></span>
    ))}</>
    case 'style': {
      const style: CSSProperties = {}
      if (node.bold) style.fontWeight = 600
      if (node.italic) style.fontStyle = 'italic'
      if (typeof node.color === 'string') style.color = node.color
      if (typeof node.size === 'number') style.fontSize = `${Math.min(28, Math.max(8, node.size))}px`
      return <span style={style}><LabelNode node={node.c} depth={depth + 1} /></span>
    }
    case 'sup': return <><LabelNode node={node.c[0]} depth={depth + 1} /><sup><LabelNode node={node.c[1]} depth={depth + 1} /></sup></>
    case 'sub': return <><LabelNode node={node.c[0]} depth={depth + 1} /><sub><LabelNode node={node.c[1]} depth={depth + 1} /></sub></>
    case 'subsup': return <><LabelNode node={node.c[0]} depth={depth + 1} /><sub><LabelNode node={node.c[1]} depth={depth + 1} /></sub><sup><LabelNode node={node.c[2]} depth={depth + 1} /></sup></>
    case 'tip': return <span title={node.tip}><LabelNode node={node.c} depth={depth + 1} /></span>
    case 'frame': return <span style={{ padding: '0 4px', borderRadius: 3, boxShadow: '0 0 0 1px color-mix(in srgb, currentColor 25%, transparent)' }}><LabelNode node={node.c} depth={depth + 1} /></span>
    default: return null
  }
}

/** A label: the tree when present, else the plain text. */
function Label({ tree, text }: { tree: LabelTree | null | undefined, text: string }): ReactNode {
  return tree ? <LabelNode node={tree} /> : <>{text}</>
}

// ---------------------------------------------------------------- Manipulate widget

function manipulateUrl(sessionId: string, kernelId: string, id: string, values: ControlValue[]): string {
  return `./api/wolfram/manipulate?sessionId=${encodeURIComponent(sessionId)}&kernelId=${encodeURIComponent(kernelId)}&id=${encodeURIComponent(id)}&values=${encodeURIComponent(JSON.stringify(values))}`
}

const CONTROLS_STYLE: CSSProperties = { display: 'grid', gridTemplateColumns: 'max-content minmax(140px, 260px) max-content', gap: '6px 10px', alignItems: 'center', fontSize: 12, padding: '4px 2px' }
const CHIP_STYLE: CSSProperties = { font: 'inherit', fontSize: 12, padding: '2px 8px', borderRadius: 4, border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit', cursor: 'pointer' }
const CHIP_ON: CSSProperties = { ...CHIP_STYLE, background: 'color-mix(in srgb, currentColor 18%, transparent)', borderColor: 'color-mix(in srgb, currentColor 50%, transparent)' }

function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, '')
}

/**
 * A render whose KERNEL time (evaluate + rasterize) was under this is cheap
 * enough to preview continuously while a slider drags. The host round trip adds
 * a fairly constant ~80 ms (MCP + base64 transfer) that the debounce absorbs.
 */
const LIVE_THRESHOLD_MS = 50
/** Throttle for live previews: at most one render per this many ms while dragging (trailing edge included). */
const LIVE_INTERVAL_MS = 150

function timingLabel(t: ShowTiming | undefined): string {
  if (t === undefined || t.totalMs === null) return ''
  const parts = [t.evalMs !== null ? `eval ${t.evalMs}` : null, t.rasterMs !== null ? `raster ${t.rasterMs}` : null, `round trip ${t.totalMs} ms`].filter(Boolean)
  return parts.join(' · ')
}

/**
 * Native controls for a registered Manipulate plus the live frame. `commit`
 * fires on release/change; renders are serialized with the newest requested
 * values replacing any queued ones. When the last render's host round trip was
 * under LIVE_THRESHOLD_MS, dragging previews continuously (debounced to
 * LIVE_INTERVAL_MS); a slow render switches live mode off again until a fast one.
 */
function ManipulateWidget({ sessionId, kernelId, descriptor, initialUrl, image, scale, alt, path, timing, sourcePath }: {
  sessionId: string, kernelId: string, descriptor: ManipulateDescriptor, initialUrl: string, image: ImageRef, scale: number, alt: string, path: string | undefined, timing: ShowTiming | undefined, sourcePath: string | undefined,
}) {
  const [values, setValues] = useState<ControlValue[]>(() => descriptor.controls.map(c => c.init))
  const [src, setSrc] = useState(initialUrl)
  const [busy, setBusy] = useState(false)
  const [dead, setDead] = useState<string | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [opening, setOpening] = useState(false)
  const frame = useFrameColor()
  const [lastTiming, setLastTiming] = useState<ShowTiming | undefined>(timing)
  const [size, setSize] = useState<{ w: number, h: number }>({ w: image.width / scale, h: image.height / scale })
  const inflight = useRef(false)
  const queued = useRef<ControlValue[] | undefined>(undefined)
  const liveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const livePending = useRef<ControlValue[] | undefined>(undefined)
  const liveLastAt = useRef(0)
  const kernelMs = lastTiming === undefined ? null : lastTiming.kernelMs ?? (lastTiming.evalMs !== null && lastTiming.rasterMs !== null ? lastTiming.evalMs + lastTiming.rasterMs : null)
  const live = dead === undefined && kernelMs !== null && kernelMs < LIVE_THRESHOLD_MS

  const render = useCallback(async (next: ControlValue[]) => {
    if (inflight.current) { queued.current = next; return }
    inflight.current = true
    setBusy(true)
    try {
      const url = manipulateUrl(sessionId, kernelId, descriptor.id, next)
      const response = await fetch(url, { credentials: 'same-origin' })
      if (response.status === 410) { setDead(await response.text()); return }
      if (response.status === 422) {
        // The body failed for these values: keep the last frame, explain, and stop live previews.
        let detail = ''
        try { const j = await response.json() as { error?: string, messages?: string[] }; detail = [j.error, ...(j.messages ?? [])].filter(Boolean).join('\n') } catch { detail = 'evaluation failed' }
        setProblem(detail)
        setLastTiming(undefined)
        return
      }
      if (!response.ok) { setDead(`${response.status}: ${(await response.text()).slice(0, 200)}`); return }
      const blob = await response.blob()
      const w = Number(response.headers.get('x-wolfram-width')), h = Number(response.headers.get('x-wolfram-height'))
      const s = Number(response.headers.get('x-wolfram-scale')) || scale
      const n = (name: string) => { const v = Number(response.headers.get(name)); return Number.isFinite(v) && response.headers.get(name) !== '' ? v : null }
      if (w > 0 && h > 0) setSize({ w: w / s, h: h / s })
      setLastTiming({ evalMs: n('x-wolfram-eval-ms'), rasterMs: n('x-wolfram-raster-ms'), kernelMs: n('x-wolfram-kernel-ms'), totalMs: n('x-wolfram-total-ms') })
      setProblem(response.headers.get('x-wolfram-error-image') === '1' ? 'the rendering contains an error box' : undefined)
      setSrc(prev => { if (prev.startsWith('blob:')) URL.revokeObjectURL(prev); return URL.createObjectURL(blob) })
    } catch (error) {
      setDead(String(error))
    } finally {
      inflight.current = false
      setBusy(false)
      const pending = queued.current
      queued.current = undefined
      if (pending !== undefined) void render(pending)
    }
  }, [sessionId, kernelId, descriptor.id, scale])

  useEffect(() => () => { if (liveTimer.current !== undefined) clearTimeout(liveTimer.current) }, [])

  /** Final value (release / change): render now. */
  const commit = (index: number, v: ControlValue) => {
    if (liveTimer.current !== undefined) { clearTimeout(liveTimer.current); liveTimer.current = undefined }
    livePending.current = undefined
    const next = values.map((old, i) => (i === index ? v : old))
    setValues(next)
    void render(next)
  }
  /**
   * Intermediate slider value while dragging: readout always; in live mode a
   * throttled render — at most one per LIVE_INTERVAL_MS, always with the newest
   * values, plus a trailing render so the frame never lags the thumb.
   */
  const preview = (index: number, v: number) => {
    const next = values.map((old, i) => (i === index ? v : old))
    setValues(next)
    if (!live) return
    livePending.current = next
    if (liveTimer.current !== undefined) return
    const wait = Math.max(0, LIVE_INTERVAL_MS - (Date.now() - liveLastAt.current))
    liveTimer.current = setTimeout(() => {
      liveTimer.current = undefined
      liveLastAt.current = Date.now()
      const pending = livePending.current
      livePending.current = undefined
      if (pending !== undefined) void render(pending)
    }, wait)
  }

  /** Render the current values once more with &save=1 (a file on disk), then open it in the system viewer. */
  const openCurrent = async () => {
    setOpening(true)
    try {
      const response = await fetch(`${manipulateUrl(sessionId, kernelId, descriptor.id, values)}&save=1`, { credentials: 'same-origin' })
      const saved = response.headers.get('x-wolfram-path')
      if (response.ok && saved) openShown(decodeURIComponent(saved))
      else if (!response.ok && path !== undefined) openShown(path)
    } catch { if (path !== undefined) openShown(path) } finally { setOpening(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start', maxWidth: '100%' }}>
      <div style={CONTROLS_STYLE} data-wolfram-manipulate={descriptor.id} data-live={live || undefined}>
        {descriptor.controls.map((control, i) => {
          const v = values[i] as ControlValue
          const disabled = dead !== undefined
          if (control.type === 'slider') {
            return (
              <FragmentRow key={control.name} label={<Label tree={control.labelTree} text={control.label} />}>
                <input
                  type="range" min={control.min} max={control.max} step={control.step ?? 'any'} value={v as number} disabled={disabled}
                  onChange={(e) => preview(i, Number(e.target.value))}
                  onPointerUp={(e) => commit(i, Number((e.target as HTMLInputElement).value))}
                  onKeyUp={(e) => commit(i, Number((e.target as HTMLInputElement).value))}
                  style={{ width: '100%' }}
                />
                <span style={{ opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>{formatNumber(v as number)}</span>
              </FragmentRow>
            )
          }
          if (control.type === 'checkbox') {
            return (
              <FragmentRow key={control.name} label={<Label tree={control.labelTree} text={control.label} />}>
                <input type="checkbox" checked={v === true} disabled={disabled} onChange={(e) => commit(i, e.target.checked)} style={{ justifySelf: 'start' }} />
                <span />
              </FragmentRow>
            )
          }
          if (control.type === 'popup') {
            return (
              <FragmentRow key={control.name} label={<Label tree={control.labelTree} text={control.label} />}>
                <select value={v as number} disabled={disabled} onChange={(e) => commit(i, Number(e.target.value))} style={{ font: 'inherit', fontSize: 12 }}>
                  {control.choices.map((choice, k) => <option key={k} value={k}>{choice}</option>)}
                </select>
                <span />
              </FragmentRow>
            )
          }
          return (
            <FragmentRow key={control.name} label={<Label tree={control.labelTree} text={control.label} />}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {control.choices.map((choice, k) => (
                  <button key={k} type="button" disabled={disabled} style={v === k ? CHIP_ON : CHIP_STYLE} onClick={() => commit(i, k)}><Label tree={control.choiceTrees[k]} text={choice} /></button>
                ))}
              </div>
              <span />
            </FragmentRow>
          )
        })}
      </div>
      <div style={{ ...IMAGE_FRAME, background: frame.color ?? 'transparent', opacity: busy && !live ? 0.75 : 1, transition: 'opacity 120ms' }}>
        <img src={src} alt={alt} title={alt} width={size.w} style={{ display: 'block', width: size.w, maxWidth: '100%', height: 'auto' }} onLoad={frame.onLoad} />
      </div>
      <StatusRow timing={lastTiming} live={live} onOpen={dead === undefined ? () => { void openCurrent() } : undefined} opening={opening} sourcePath={sourcePath} />
      {problem !== undefined && <pre style={{ ...PRE_STYLE, fontSize: 11, opacity: 0.8 }}>{problem}</pre>}
      {dead !== undefined && <div style={{ fontSize: 12, opacity: 0.7 }}>controls disabled — {dead}</div>}
    </div>
  )
}

/** Small picture glyph for "open this frame in the system viewer". */
const PICTURE = (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden style={{ display: 'block' }}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="5.5" cy="6.5" r="1.3" fill="currentColor" />
    <path d="M2.5 12.5l3.5-3.5 2.5 2.5 2.5-3 3 4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
)

/** Small document glyph for "open the .wl source". */
const DOCUMENT = (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden style={{ display: 'block' }}>
    <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M9.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M5.5 8h5M5.5 10.5h5M5.5 13h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
)

const ICON_BUTTON = (busy: boolean): CSSProperties => ({ all: 'unset', cursor: busy ? 'progress' : 'pointer', display: 'inline-flex', opacity: busy ? 0.5 : 1 })

/** Status line under a frame: timings, live tag, and the open-image / open-source icons. */
function StatusRow({ timing, live, onOpen, opening, sourcePath }: { timing: ShowTiming | undefined, live: boolean, onOpen: (() => void) | undefined, opening: boolean, sourcePath: string | undefined }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>
      <span>{timingLabel(timing)}{live ? ' · live' : ''}</span>
      {onOpen !== undefined && (
        <button type="button" title="Open this frame in the image viewer" onClick={onOpen} disabled={opening} style={ICON_BUTTON(opening)}>{PICTURE}</button>
      )}
      {sourcePath !== undefined && (
        <button type="button" title={`Open the source (${sourcePath})`} onClick={() => openShown(sourcePath)} style={ICON_BUTTON(false)}>{DOCUMENT}</button>
      )}
    </div>
  )
}

/** One grid row: label, control, readout. */
function FragmentRow({ label, children }: { label: ReactNode, children: ReactNode }) {
  return (
    <>
      <span style={{ opacity: 0.85 }}>{label}</span>
      {children}
    </>
  )
}

// ---------------------------------------------------------------- row chrome

const SPIKEY = (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden style={{ display: 'block' }}>
    <path fill="currentColor" d="M12 1.5l2.3 4.7 5.2-.6-2.6 4.5 3.6 3.8-5.1 1 .1 5.2L12 17.6l-3.5 3.5.1-5.2-5.1-1 3.6-3.8L4.5 5.6l5.2.6z" />
  </svg>
)

const ROW_STYLE: CSSProperties = { fontSize: 13, lineHeight: '20px' }
const SUMMARY_STYLE: CSSProperties = { opacity: 0.7, marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const BODY_STYLE: CSSProperties = { padding: '6px 0 8px 22px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }
const PRE_STYLE: CSSProperties = { margin: 0, alignSelf: 'stretch', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: '18px', maxHeight: 360, overflow: 'auto' }

function leading(state: RowState): ReactNode {
  if (state === 'ok') return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{SPIKEY}</span>
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <StateDot state={state === 'running' ? 'ongoing' : 'error'} />
      {SPIKEY}
    </span>
  )
}

function KernelRow({ title, summary, state, defaultOpen, children }: { title: string, summary: string, state: RowState, defaultOpen: boolean, children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  // A row mounts while its call is running (defaultOpen false) and must open
  // itself once the result carries an image; the user's own toggle wins after.
  const [touched, setTouched] = useState(false)
  useEffect(() => { if (defaultOpen && !touched) setOpen(true) }, [defaultOpen, touched])
  const expandable = children !== null && children !== undefined && children !== false
  return (
    <div style={ROW_STYLE} data-tool-state={state}>
      <DisclosureRow
        icon={leading(state)}
        title={title}
        open={open && expandable}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setTouched(true); setOpen(v => !v) }}
        collapsedContent={summary !== '' ? <span style={SUMMARY_STYLE}>{summary}</span> : undefined}
      >
        <div style={BODY_STYLE}>{children}</div>
      </DisclosureRow>
    </div>
  )
}

// ---------------------------------------------------------------- wolfram_show

/** Label content tree emitted by kernel/DSHPlugin.wl labelTree (untrusted JSON; rendered defensively). */
type LabelTree =
  | { t: 's' | 'code', v: string }
  | { t: 'color', css: string, v: string }
  | { t: 'list' | 'col', c: LabelTree[] }
  | { t: 'row', c: LabelTree[], sep: LabelTree | null }
  | { t: 'assoc', c: [LabelTree, LabelTree][] }
  | { t: 'style', c: LabelTree, bold?: boolean, italic?: boolean, color?: string, size?: number }
  | { t: 'sup' | 'sub', c: [LabelTree, LabelTree] }
  | { t: 'subsup', c: [LabelTree, LabelTree, LabelTree] }
  | { t: 'tip', c: LabelTree, tip: string }
  | { t: 'frame', c: LabelTree }

type ManipulateControl =
  | { name: string, label: string, labelTree: LabelTree | null, type: 'slider', min: number, max: number, step: number | null, init: number }
  | { name: string, label: string, labelTree: LabelTree | null, type: 'checkbox', init: boolean }
  | { name: string, label: string, labelTree: LabelTree | null, type: 'setter' | 'popup', choices: string[], choiceTrees: (LabelTree | null)[], init: number }
interface ManipulateDescriptor { id: string, controls: ManipulateControl[] }
type ControlValue = number | boolean

function asTiming(value: unknown): ShowTiming | undefined {
  if (!isRecord(value)) return undefined
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return { evalMs: n(value.evalMs), rasterMs: n(value.rasterMs), kernelMs: n(value.kernelMs), totalMs: n(value.totalMs) }
}

/** Narrow the host's manipulate descriptor (untrusted on replay). */
function asManipulate(value: unknown): ManipulateDescriptor | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.controls) || value.controls.length === 0) return undefined
  const controls: ManipulateControl[] = []
  for (const c of value.controls) {
    if (!isRecord(c) || typeof c.name !== 'string') return undefined
    const label = typeof c.label === 'string' ? c.label : c.name
    const labelTree = isRecord(c.labelTree) ? (c.labelTree as unknown as LabelTree) : null
    if (c.type === 'slider' && typeof c.min === 'number' && typeof c.max === 'number' && typeof c.init === 'number') {
      controls.push({ name: c.name, label, labelTree, type: 'slider', min: c.min, max: c.max, step: typeof c.step === 'number' ? c.step : null, init: c.init })
    } else if (c.type === 'checkbox') {
      controls.push({ name: c.name, label, labelTree, type: 'checkbox', init: c.init === true })
    } else if ((c.type === 'setter' || c.type === 'popup') && Array.isArray(c.choices) && c.choices.every(x => typeof x === 'string') && typeof c.init === 'number') {
      const choices = c.choices as string[]
      const choiceTrees = Array.isArray(c.choiceTrees) && c.choiceTrees.length === choices.length ? c.choiceTrees.map(x => (isRecord(x) ? (x as unknown as LabelTree) : null)) : choices.map(() => null)
      controls.push({ name: c.name, label, labelTree, type: c.type, choices, choiceTrees, init: c.init })
    } else return undefined
  }
  return { id: value.id, controls }
}

interface ShowTiming { evalMs: number | null, rasterMs: number | null, kernelMs: number | null, totalMs: number | null }

interface ShowMeta {
  attachment: ImageRef | null
  manipulate?: ManipulateDescriptor
  timing?: ShowTiming
  errorImage?: boolean
  points?: { width: number, height: number }
  devicePixels?: { width: number, height: number }
  scale?: number
  path?: string | null
  sourcePath?: string | null
  label?: string | null
  kernelId?: string
}

function showMetaOf(block: Block): ShowMeta | undefined {
  if (!isSettled(block) || !isRecord(block.meta)) return undefined
  const meta = block.meta
  const attachment = asImageRef(meta.attachment) ?? null
  const dims = (v: unknown) => (isRecord(v) && positiveInt(v.width) && positiveInt(v.height) ? { width: v.width, height: v.height } : undefined)
  return {
    attachment,
    points: dims(meta.points),
    devicePixels: dims(meta.devicePixels),
    scale: typeof meta.scale === 'number' ? meta.scale : undefined,
    path: typeof meta.path === 'string' ? meta.path : null,
    sourcePath: typeof meta.sourcePath === 'string' ? meta.sourcePath : null,
    label: typeof meta.label === 'string' && meta.label !== '' ? meta.label : null,
    kernelId: typeof meta.kernelId === 'string' ? meta.kernelId : undefined,
    manipulate: asManipulate(meta.manipulate),
    timing: asTiming(meta.timing),
    errorImage: meta.errorImage === true,
  }
}

/**
 * Short title for a Wolfram expression: `Head[...]` when the text is one
 * bracketed expression (`Manipulate[…]`, `Plot3D[…]`), else the first line
 * truncated with an ellipsis.
 */
function headSummary(expr: string, max = 40): string {
  const text = expr.trim()
  const m = /^([A-Za-z$][\w$`]*)\[/.exec(text)
  if (m !== null && text.endsWith(']')) return `${m[1]}[...]`
  return firstLine(text, max)
}

function firstLine(s: string, max = 80): string {
  const line = s.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function WolframShowRow({ block, loadImage, sessionId }: Props) {
  const state = stateOf(block)
  const args = parseArgs(block)
  const expression = typeof args.expression === 'string' ? args.expression : ''
  const meta = showMetaOf(block)
  const text = resultText(block)
  const label = meta?.label ?? headSummary(expression)
  const kernelId = meta?.kernelId ?? kernelIdOf(block)
  const size = meta?.devicePixels && meta.points ? `${meta.points.width}×${meta.points.height} pt${meta.scale && meta.scale !== 1 ? ` @${meta.scale}x` : ''}` : ''
  const summary = [kernelId, state === 'running' ? 'rendering…' : size, meta?.manipulate !== undefined ? 'interactive' : '', meta?.timing?.totalMs !== null && meta?.timing?.totalMs !== undefined ? `${meta.timing.totalMs} ms` : ''].filter(Boolean).join(' · ')
  const ref = meta?.attachment ?? imageRefsOf(block)[0]
  const body = state === 'running'
    ? <pre style={PRE_STYLE}>{expression}</pre>
    : ref !== undefined
      ? (
        <>
          {meta?.manipulate !== undefined && meta.attachment !== null && meta.kernelId !== undefined
            ? <ManipulateWidget sessionId={String(sessionId)} kernelId={meta.kernelId} descriptor={meta.manipulate} initialUrl={shownImageUrl(String(sessionId), meta.attachment)} image={meta.attachment} scale={meta.scale ?? 2} alt={label} path={meta.path ?? undefined} timing={meta.timing} sourcePath={meta.sourcePath ?? undefined} />
            : <WolframImage source={meta?.attachment !== undefined && meta.attachment !== null ? { url: shownImageUrl(String(sessionId), ref) } : { loadImage }} image={ref} pointWidth={meta?.points?.width} alt={label} path={meta?.path ?? undefined} />}
          {meta?.manipulate === undefined && <ShowCaption label={label} path={meta?.path ?? undefined} />}
          {meta?.manipulate === undefined && <StatusRow timing={meta?.timing} live={false} onOpen={meta?.path ? () => openShown(meta.path as string) : undefined} opening={false} sourcePath={meta?.sourcePath ?? undefined} />}
          {meta?.errorImage && <div style={{ fontSize: 12, opacity: 0.8 }}>⚠ the rendering contains an error box</div>}
          <details style={{ fontSize: 12, opacity: 0.7 }}>
            <summary>expression</summary>
            <pre style={PRE_STYLE}>{expression}</pre>
          </details>
        </>
      )
      : <pre style={PRE_STYLE}>{text || expression}</pre>
  return (
    <KernelRow title={`Wolfram show${label ? `: ${label}` : ''}`} summary={summary} state={state} defaultOpen={state !== 'running' && ref !== undefined}>
      {body}
    </KernelRow>
  )
}


/** The image or interactive widget for one show payload (tool-row body, gallery item, command card). */
function ShowBody({ sessionId, meta, alt }: { sessionId: string, meta: ShowMeta, alt: string }) {
  if (meta.attachment === null) return <div style={{ fontSize: 12, opacity: 0.7 }}>[image unavailable{meta.path ? `: ${meta.path}` : ''}]</div>
  return meta.manipulate !== undefined && meta.kernelId !== undefined
    ? <ManipulateWidget sessionId={sessionId} kernelId={meta.kernelId} descriptor={meta.manipulate} initialUrl={shownImageUrl(sessionId, meta.attachment)} image={meta.attachment} scale={meta.scale ?? 2} alt={alt} path={meta.path ?? undefined} timing={meta.timing} sourcePath={meta.sourcePath ?? undefined} />
    : <WolframImage source={{ url: shownImageUrl(sessionId, meta.attachment) }} image={meta.attachment} pointWidth={meta.points?.width} alt={alt} path={meta.path ?? undefined} />
}

// ---------------------------------------------------------------- /wolfram-show command card

type CommandProps = PropsRuntime<'conversation.chat.commandview'>

/** Renders the JSON payload the host's /wolfram-show command returns as the same card the tool produces. */
export function WolframShowCommandCard({ node, sessionId }: CommandProps) {
  const outcome = node.outcome
  const args = (node.args ?? '').trim()
  let payload: (ShowMeta & { expression?: string, opened?: boolean }) | undefined
  if (outcome?.kind === 'success' && typeof outcome.text === 'string') {
    try {
      const parsed: unknown = JSON.parse(outcome.text)
      if (isRecord(parsed) && parsed.dsh === 'wolfram-show') {
        const meta = showMetaOf({ kind: 'tool-result', meta: parsed } as unknown as Block)
        if (meta !== undefined) payload = { ...meta, expression: typeof parsed.expression === 'string' ? parsed.expression : undefined }
      }
    } catch { /* not our payload; fall through to text */ }
  }
  const state: RowState = outcome === null ? 'running' : outcome.kind === 'error' ? 'error' : 'ok'
  const label = payload?.label ?? headSummary(payload?.expression ?? args)
  const size = payload?.points && payload.scale ? `${payload.points.width}×${payload.points.height} pt @${payload.scale}x` : ''
  const summary = [payload?.kernelId, state === 'running' ? 'rendering…' : size, payload?.manipulate ? 'interactive' : ''].filter(Boolean).join(' · ')
  return (
    <KernelRow title={`/wolfram-show${label ? `: ${label}` : ''}`} summary={summary} state={state} defaultOpen={state !== 'running'}>
      {state === 'running' && <pre style={PRE_STYLE}>{args}</pre>}
      {state === 'error' && <pre style={PRE_STYLE}>{outcome?.text ?? 'failed'}</pre>}
      {state === 'ok' && payload !== undefined && (
        <>
          <ShowBody sessionId={String(sessionId)} meta={payload} alt={label} />
          {payload.manipulate === undefined && <ShowCaption label={label} path={payload.path ?? undefined} />}
        </>
      )}
      {state === 'ok' && payload === undefined && <pre style={PRE_STYLE}>{outcome?.text ?? ''}</pre>}
    </KernelRow>
  )
}

/** Plain text card for /wolfram and /wolfram-kernels. */
export function WolframCommandCard({ node }: CommandProps) {
  const outcome = node.outcome
  const state: RowState = outcome === null ? 'running' : outcome.kind === 'error' ? 'error' : 'ok'
  const args = (node.args ?? '').trim()
  const kernelId = /\[(wl:\d+:\d+)\]/.exec(outcome?.text ?? '')?.[1]
  const output = (outcome?.text ?? '').replace(/^Opened kernel [^\n]*\n?/, '').replace(/^\[wl:\d+:\d+\]\n?/, '')
  return (
    <KernelRow title={`/${node.name ?? 'wolfram'}`} summary={[kernelId, state === 'running' ? 'evaluating…' : headSummary(args)].filter(Boolean).join(' · ')} state={state} defaultOpen>
      {args !== '' && <pre style={PRE_STYLE}>{args}</pre>}
      {state !== 'running' && output !== '' && <pre style={{ ...PRE_STYLE, opacity: 0.85, borderLeft: '2px solid color-mix(in srgb, currentColor 20%, transparent)', paddingLeft: 8 }}>{output}</pre>}
    </KernelRow>
  )
}

// ---------------------------------------------------------------- wolfram_eval / wolfram_run

export function WolframEvalRow({ toolName, block, loadImage }: Props) {
  const state = stateOf(block)
  const args = parseArgs(block)
  const code = typeof args.code === 'string' ? args.code : typeof args.path === 'string' ? args.path : ''
  const text = resultText(block)
  const refs = imageRefsOf(block)
  const kernelId = kernelIdOf(block)
  const output = text.replace(/^\[wl:\d+:\d+\]\n?/, '').replace(/^Opened kernel [^\n]*\n?/, '')
  const summary = [kernelId, state === 'running' ? 'evaluating…' : headSummary(code)].filter(Boolean).join(' · ')
  const title = toolName === 'wolfram_run' ? 'Wolfram run' : 'Wolfram eval'
  return (
    <KernelRow title={title} summary={summary} state={state} defaultOpen={refs.length > 0}>
      {code !== '' && <pre style={PRE_STYLE}>{code}</pre>}
      {state !== 'running' && output !== '' && (
        <pre style={{ ...PRE_STYLE, opacity: 0.85, borderLeft: '2px solid color-mix(in srgb, currentColor 20%, transparent)', paddingLeft: 8 }}>{output}</pre>
      )}
      {refs.map((ref) => <WolframImage key={ref.attachmentId} source={{ loadImage }} image={ref} pointWidth={Math.round(ref.width / 2)} alt="Wolfram graphics" path={undefined} />)}
    </KernelRow>
  )
}

// ---------------------------------------------------------------- pinned gallery (turn tail)

/** One successful wolfram_show of a turn, as the tool/result event recorded it. */
interface ShownImage {
  readonly seq: number
  readonly callId: string
  readonly meta: ShowMeta & { attachment: ImageRef }
}

export interface WolframShownTurnData {
  readonly shown: readonly ShownImage[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    wolframShown: WolframShownTurnData
  }
}

interface WolframShownState extends WolframShownTurnData {
  readonly turn: number
  /** callId → tool name, so a result can be attributed to wolfram_show. */
  readonly calls: ReadonlyMap<string, string>
}

/** Narrow one tool/result event's presentationMeta into a gallery entry. */
function shownFromMeta(meta: unknown): (ShowMeta & { attachment: ImageRef }) | undefined {
  if (!isRecord(meta)) return undefined
  const attachment = asImageRef(meta.attachment)
  if (attachment === undefined) return undefined
  const dims = (v: unknown) => (isRecord(v) && positiveInt(v.width) && positiveInt(v.height) ? { width: v.width, height: v.height } : undefined)
  return {
    attachment,
    points: dims(meta.points),
    devicePixels: dims(meta.devicePixels),
    scale: typeof meta.scale === 'number' ? meta.scale : undefined,
    path: typeof meta.path === 'string' ? meta.path : null,
    sourcePath: typeof meta.sourcePath === 'string' ? meta.sourcePath : null,
    label: typeof meta.label === 'string' && meta.label !== '' ? meta.label : null,
    kernelId: typeof meta.kernelId === 'string' ? meta.kernelId : undefined,
    manipulate: asManipulate(meta.manipulate),
    timing: asTiming(meta.timing),
    errorImage: meta.errorImage === true,
  }
}

/** Turn-local accumulator of shown images; publishes no view node, only turn data. */
const wolframShownDefinition: ConversationNodeDefinition<WolframShownState> = {
  kind: 'wolframShown', // must equal the Location data key below (the engine enforces it)
  match: (event) => {
    if (event.type === 'turn/start') return { id: String((event.data as { turn: number }).turn), role: 'start' }
    if (event.type === 'tool/call' || event.type === 'tool/result') return { id: String((event.data as { turn: number }).turn), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('wolframShown start requires turn/start')
    return { turn: (match.event.data as { turn: number }).turn, calls: new Map(), shown: [] }
  },
  update: (context, match) => {
    const event = match.event as { type: string, seq: number, data: Record<string, unknown> }
    if (event.type === 'tool/call') {
      const calls = new Map(context.state.calls)
      calls.set(String(event.data.callId), String(event.data.name))
      return { ...context.state, calls }
    }
    if (event.type !== 'tool/result') return context.state
    const message = event.data.message as { source?: { callId?: unknown }, content?: { isError?: boolean }[] } | undefined
    const callId = String(message?.source?.callId ?? '')
    if (context.state.calls.get(callId) !== 'wolfram_show') return context.state
    if (message?.content?.[0]?.isError === true) return context.state
    const meta = shownFromMeta(event.data.meta)
    if (meta === undefined) return context.state
    // Debug artefacts stay in the folded tool rows only: a render containing a pink error box
    // (the host flags it and the model usually retries), and a pixel-identical re-show (same
    // content-addressed attachment, e.g. `see: true` to inspect what was already displayed).
    if (meta.errorImage) return context.state
    if (context.state.shown.some(s => s.meta.attachment.attachmentId === meta.attachment.attachmentId)) return context.state
    return { ...context.state, shown: [...context.state.shown, { seq: event.seq, callId, meta }] }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === 'wolframShown'
      && (previous.value as WolframShownTurnData).shown === context.state.shown) return previous
    return { kind: 'turn', turn: context.state.turn, key: 'wolframShown', value: { shown: context.state.shown } }
  },
}

/** Claim the turn tail only when the closing turn showed something (up to the closing seq). */
function selectShown(owner: TurnTailOwnerProps): readonly ShownImage[] | null {
  const data = owner.turn.data.get('wolframShown')
  if (data === undefined) return null
  const shown = data.shown.filter(s => s.seq <= owner.seq)
  return shown.length === 0 ? null : shown
}

type GalleryInjected = { sessionId: string }
type GalleryProps = { matched: readonly ShownImage[] } & InjectFace<GalleryInjected>

const GALLERY_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start', padding: '4px 0 8px' }

/** The turn's shown images, pinned under the final answer (never folded away). */
function ShownGallery({ matched, sessionId }: GalleryProps) {
  return (
    <div style={GALLERY_STYLE} data-wolfram-shown={matched.length}>
      {matched.map((item) => (
        <figure key={item.callId} style={{ margin: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, maxWidth: '100%' }}>
          {item.meta.manipulate !== undefined && item.meta.kernelId !== undefined
            ? <ManipulateWidget sessionId={sessionId} kernelId={item.meta.kernelId} descriptor={item.meta.manipulate} initialUrl={shownImageUrl(sessionId, item.meta.attachment)} image={item.meta.attachment} scale={item.meta.scale ?? 2} alt={item.meta.label ?? 'Wolfram graphics'} path={item.meta.path ?? undefined} timing={item.meta.timing} sourcePath={item.meta.sourcePath ?? undefined} />
            : <WolframImage source={{ url: shownImageUrl(sessionId, item.meta.attachment) }} image={item.meta.attachment} pointWidth={item.meta.points?.width} alt={item.meta.label ?? 'Wolfram graphics'} path={item.meta.path ?? undefined} />}
          {item.meta.manipulate === undefined && <ShowCaption label={item.meta.label ?? ''} path={item.meta.path ?? undefined} />}
        </figure>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- plugin

export const name = 'wolfram-kernel-supervisor-client'
export const inject = ['slots', 'uiConversation']

export function apply(ctx: Context): void {
  // Turn-scoped accumulator feeding the pinned gallery (registration unwinds with the plugin).
  ctx.uiConversation.events.register(wolframShownDefinition)
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    select: selectShown,
    inject: (sessionId): GalleryInjected => ({ sessionId: String(sessionId) }),
  }, ShownGallery))

  // The callback returns the registrations' disposers so they unwind with the
  // slot owner (and re-register when it is mounted again).
  ctx.slots.inject('conversation.chat.commandview', () => [
    ctx.slots.register({ name: 'conversation.chat.commandview', key: 'wolfram-show' }, WolframShowCommandCard),
    ctx.slots.register({ name: 'conversation.chat.commandview', key: 'wolfram' }, WolframCommandCard),
    ctx.slots.register({ name: 'conversation.chat.commandview', key: 'wolfram-kernels' }, WolframCommandCard),
  ])
  ctx.slots.inject('tool.call.toolview', () => [
    ctx.slots.register({ name: 'tool.call.toolview', key: 'wolfram_show' }, WolframShowRow),
    ctx.slots.register({ name: 'tool.call.toolview', key: 'wolfram_eval' }, WolframEvalRow),
    ctx.slots.register({ name: 'tool.call.toolview', key: 'wolfram_run' }, WolframEvalRow),
  ])
}
