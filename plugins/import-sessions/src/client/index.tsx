/**
 * tali-import-sessions — browser half.
 *
 * Decorates the BARE host commands `/import-claude` and `/import-pi`
 * (ui-commands decorations: the catalog rows and command log stay the host's)
 * so a bare invocation opens ONE overlay modal that walks the stages of
 * PROTOCOL.md's "Client flow":
 *
 *   pick → (upload) → scanning → decide → running → summary
 *
 * The transcripts may live on the user's device (a remote Dock app (macOS) or DSH Remote (Linux) on a
 * laptop talking to a shared host), so the pick stage offers a device chooser
 * that uploads through `upload-*` beside the server-side chooser and a typed
 * server path. `decide` is the single decision view: selection, destinations
 * and the large-session mode all live there; Import starts the job directly.
 *
 * Every host call goes through `connection.rpc.call('/import-sessions', …)`;
 * the protocol payload types live in ./protocol.ts. All UI is inline-styled on
 * the shell's primitives (no CSS-module pipeline in this esbuild build).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DIALOG_DEFAULT, useDialogDefaultAction } from './dialog-keys.ts'
import {
  callChannel, errorText,
  type Call, type ImportArgs, type ImportMode, type ImportResult, type ImportSelection, type ProgressResult, type ScanResult, type Source, type SourcesResult,
} from './protocol.ts'
import { DEFAULT_NEW_BASE, NewBaseField, TreeStage, initialDestinationValue, isSelectable, resolveDestination, type DestinationValue } from './TreeStage.tsx'
import { LargeSection, SessionCard, type LargeChoice } from './DecideStage.tsx'
import { PickStage } from './PickStage.tsx'
import { RunningStage, SummaryStage } from './SummaryStage.tsx'
import { expectedTranscriptText, filterTranscripts } from './transcript-filter.ts'
import { uploadTranscripts, type UploadProgress } from './upload.ts'
import { borderColor, dangerColor, mono, plural, small, tildify, warningColor } from './format.ts'

const PROGRESS_POLL_MS = 500
const COMMANDS: ReadonlyArray<{ name: string, source: Source }> = [
  { name: 'import-claude', source: 'claude' },
  { name: 'import-pi', source: 'pi' },
]
const SOURCE_LABEL: Record<Source, string> = { claude: 'Claude Code', pi: 'pi' }
/** Used until `sources` answers (its `defaults` win). */
const FALLBACK_CHOICE: LargeChoice = { mode: 'working', keepTurns: 20, resultCap: 4096 }

// ---------------------------------------------------------------------------
// Dialog store (plugin-owned; the overlay subscribes)

interface DialogState { open: boolean, source: Source, generation: number }
type Listener = (state: DialogState) => void

class DialogStore {
  private state: DialogState = { open: false, source: 'claude', generation: 0 }
  private readonly listeners = new Set<Listener>()
  get(): DialogState { return this.state }
  /** Opening bumps `generation` so the flow component remounts with fresh state. */
  open(source: Source): void { this.set({ open: true, source, generation: this.state.generation + 1 }) }
  close(): void { this.set({ ...this.state, open: false }) }
  private set(state: DialogState): void { this.state = state; for (const l of this.listeners) l(state) }
  subscribe(l: Listener): () => void { this.listeners.add(l); return () => { this.listeners.delete(l) } }
}

// ---------------------------------------------------------------------------
// Bits

function Banner({ tone, children }: { tone: 'info' | 'warn' | 'danger', children: ReactNode }) {
  const color = tone === 'danger' ? dangerColor : tone === 'warn' ? warningColor : borderColor
  return (
    <div style={{ borderLeft: `3px solid ${color}`, padding: '6px 10px', fontSize: 13, lineHeight: 1.45, background: 'rgba(127,127,127,0.07)', borderRadius: 4 }}>
      {children}
    </div>
  )
}

function ErrorLine({ text }: { text: string | undefined }) {
  if (text === undefined) return null
  return <div role="alert" style={{ color: dangerColor, fontSize: 13, lineHeight: 1.4, wordBreak: 'break-word' }}>{text}</div>
}

function Busy({ children }: { children: ReactNode }) {
  return <div style={{ ...small, display: 'flex', alignItems: 'center', gap: 6 }}><span aria-hidden="true">⏳</span>{children}</div>
}

// ---------------------------------------------------------------------------
// The flow

type Stage = 'pick' | 'scanning' | 'decide' | 'large' | 'running' | 'summary'

function ImportFlow({ source, rpc, onClose }: { source: Source, rpc: ClientConnectionRpc, onClose: () => void }) {
  const [stage, setStage] = useState<Stage>('pick')
  const [error, setError] = useState<string | undefined>(undefined)

  // pick
  const [sources, setSources] = useState<SourcesResult | undefined>(undefined)
  const [deviceError, setDeviceError] = useState<string | undefined>(undefined)
  const [upload, setUpload] = useState<UploadProgress | undefined>(undefined)

  // scanning / decide
  const [scanPath, setScanPath] = useState<string | undefined>(undefined)
  const [scan, setScan] = useState<ScanResult | undefined>(undefined)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [destinations, setDestinations] = useState<Record<string, DestinationValue>>({})
  const [largeChoice, setLargeChoice] = useState<LargeChoice>(FALLBACK_CHOICE)
  const [showHidden, setShowHidden] = useState(false)
  const [newBase, setNewBase] = useState(DEFAULT_NEW_BASE)

  // running / summary
  const [job, setJob] = useState<ImportResult | undefined>(undefined)
  const [progress, setProgress] = useState<ProgressResult | undefined>(undefined)

  // Unmount guard + abort for the in-flight fetches (the host's native
  // chooser itself cannot be cancelled from here; only our request is).
  const alive = useRef(true)
  const abort = useRef(new AbortController())
  // The device upload the scan came from (or that is in flight). Ours to
  // discard until `import` takes it over; `uploadConsumed` marks that hand-off.
  const uploadId = useRef<string | undefined>(undefined)
  const uploadConsumed = useRef(false)
  const uploadAbort = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    alive.current = true
    const controller = abort.current
    return () => { alive.current = false; controller.abort(); uploadAbort.current?.abort() }
  }, [])

  const call = useCallback<Call>((endpoint, args) => callChannel(rpc, endpoint, args, abort.current.signal), [rpc])

  /** Drop the upload we own, if any; never aborted (it must survive closing). */
  const discardUpload = useCallback((): void => {
    const id = uploadId.current
    uploadId.current = undefined
    if (id === undefined || uploadConsumed.current) return
    void callChannel(rpc, 'upload-discard', { uploadId: id }).catch(() => { /* the host sweeps stale uploads anyway */ })
  }, [rpc])

  const close = useCallback((): void => {
    uploadAbort.current?.abort()
    discardUpload()
    onClose()
  }, [discardUpload, onClose])

  const label = sources?.sources[source].label ?? SOURCE_LABEL[source]
  const root = sources?.sources[source].root
  const existing = sources?.workspaces ?? []

  // -- scan ----------------------------------------------------------------
  const startScan = useCallback(async (path: string, fromUpload?: string): Promise<void> => {
    const trimmed = path.trim()
    if (trimmed === '') return
    // A scan of something else supersedes an earlier upload we still hold.
    if (uploadId.current !== undefined && uploadId.current !== fromUpload) discardUpload()
    if (fromUpload !== undefined) uploadId.current = fromUpload
    setError(undefined)
    setScanPath(trimmed)
    setStage('scanning')
    try {
      const result = await call<ScanResult>('scan', { source, path: trimmed })
      if (!alive.current) return
      setScan(result)
      // Root scans are opt-in (bulk); a workspace or single session starts fully selected.
      const initial = new Set<string>()
      if (result.kind !== 'root') {
        for (const workspace of result.workspaces) for (const session of workspace.sessions) if (isSelectable(session)) initial.add(session.file)
      }
      setSelected(initial)
      const defaults: Record<string, DestinationValue> = {}
      for (const workspace of result.workspaces) defaults[workspace.key] = initialDestinationValue(workspace)
      setDestinations(defaults)
      setStage('decide')
    } catch (failure) {
      if (!alive.current) return
      setError(`Scan failed: ${errorText(failure)}`)
      setStage('pick')
    }
  }, [call, discardUpload, source])

  // -- device chooser → filter → upload → scan --------------------------------
  const onFiles = useCallback(async (list: FileList): Promise<void> => {
    setDeviceError(undefined)
    setError(undefined)
    const { kept } = filterTranscripts(source, Array.from(list))
    if (kept.length === 0) {
      setDeviceError(`Nothing to import among the ${plural(list.length, 'chosen file')}: expected ${expectedTranscriptText(source)}. Choose the ${label} store, one of its workspace folders, or one transcript.`)
      return
    }
    // Replace any upload we still hold from an earlier choice.
    uploadAbort.current?.abort()
    discardUpload()
    uploadConsumed.current = false
    const controller = new AbortController()
    uploadAbort.current = controller
    const uploadCall: Call = (endpoint, args) => callChannel(rpc, endpoint, args, controller.signal)
    setUpload({ filesDone: 0, filesTotal: kept.length, bytesSent: 0, currentFile: undefined })
    try {
      const outcome = await uploadTranscripts(
        uploadCall,
        source,
        kept,
        (next) => { if (alive.current && !controller.signal.aborted) setUpload(next) },
        (id) => { uploadId.current = id },
        controller.signal,
      )
      if (!alive.current) return
      setUpload(undefined)
      uploadAbort.current = undefined
      if (controller.signal.aborted) return
      void startScan(outcome.path, outcome.uploadId)
    } catch (failure) {
      // uploadTranscripts already discarded server-side; forget the id.
      uploadId.current = undefined
      uploadAbort.current = undefined
      if (!alive.current) return
      setUpload(undefined)
      if (!controller.signal.aborted) setDeviceError(`Upload failed: ${errorText(failure)}`)
    }
  }, [discardUpload, label, rpc, source, startScan])

  const cancelUpload = useCallback((): void => {
    uploadAbort.current?.abort()
    uploadAbort.current = undefined
    // The driver's own discard runs on an aborted signal; do it unaborted here.
    discardUpload()
    setUpload(undefined)
  }, [discardUpload])

  // -- bootstrap: sources -----------------------------------------------------
  useEffect(() => {
    let cancelled = false
    void (async () => {
      let info: SourcesResult
      try {
        info = await call<SourcesResult>('sources', {})
      } catch (failure) {
        if (!cancelled && alive.current) setError(`Could not read import sources: ${errorText(failure)}`)
        return
      }
      if (cancelled || !alive.current) return
      setSources(info)
      setLargeChoice(previous => ({ ...previous, keepTurns: info.defaults.keepTurns, resultCap: info.defaults.resultCap }))
    })()
    return () => { cancelled = true }
    // Runs once per open (the flow remounts per open via `generation`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -- selection model ----------------------------------------------------------
  const selectedSessions = useMemo(() => {
    if (scan === undefined) return []
    const rows: Array<{ file: string, workspaceKey: string, large: boolean }> = []
    for (const workspace of scan.workspaces) for (const session of workspace.sessions) if (selected.has(session.file)) rows.push({ file: session.file, workspaceKey: workspace.key, large: session.large })
    return rows
  }, [scan, selected])
  const count = selectedSessions.length
  const largeCount = selectedSessions.filter(row => row.large).length

  const buildSelections = (): ImportSelection[] => {
    if (scan === undefined) return []
    const byKey = new Map(scan.workspaces.map(workspace => [workspace.key, workspace] as const))
    const largeMode: ImportMode = largeChoice.mode === 'archive'
      ? { kind: 'archive' }
      : { kind: 'working', keepTurns: largeChoice.keepTurns, resultCap: largeChoice.resultCap }
    return selectedSessions.flatMap(({ file, workspaceKey, large }) => {
      const workspace = byKey.get(workspaceKey)
      if (workspace === undefined) return []
      const value = destinations[workspaceKey] ?? initialDestinationValue(workspace)
      return [{ file, destination: resolveDestination(value, workspace, newBase), mode: large ? largeMode : { kind: 'archive' } }]
    })
  }

  /** Decide's Import: large sessions get their own follow-up step first. */
  const proceed = (): void => {
    if (largeCount > 0) { setError(undefined); setStage('large'); return }
    void startImport()
  }

  // -- import + progress polling ---------------------------------------------
  const startImport = async (): Promise<void> => {
    const selections = buildSelections()
    if (selections.length === 0) return
    setError(undefined)
    setProgress(undefined)
    setJob(undefined)
    setStage('running')
    const args: ImportArgs = { source, selections, ...uploadId.current !== undefined ? { uploadId: uploadId.current } : {} }
    try {
      const started = await call<ImportResult>('import', args)
      if (!alive.current) return
      // The host deletes the upload after the job; it is no longer ours to discard.
      if (args.uploadId !== undefined) uploadConsumed.current = true
      setJob(started)
    } catch (failure) {
      if (!alive.current) return
      setError(`Import failed to start: ${errorText(failure)}`)
      setStage('decide')
    }
  }

  useEffect(() => {
    if (stage !== 'running' || job === undefined) return
    let stopped = false
    let inFlight = false
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = (): void => { stopped = true; if (timer !== undefined) clearInterval(timer) }
    const tick = async (): Promise<void> => {
      if (inFlight || stopped) return
      inFlight = true
      try {
        const next = await call<ProgressResult>('progress', { jobId: job.jobId })
        if (stopped || !alive.current) return
        setProgress(next)
        if (next.finished) { stop(); setStage('summary') }
      } catch (failure) {
        if (stopped || !alive.current) return
        // The job is unknown or the host went away: show what we have.
        stop()
        setError(`Lost track of the import job: ${errorText(failure)}`)
        setStage('summary')
      } finally {
        inFlight = false
      }
    }
    timer = setInterval(() => { void tick() }, PROGRESS_POLL_MS)
    void tick()
    return stop
  }, [stage, job, call])

  // -- selection handlers ----------------------------------------------------
  const toggle = (files: string[], next: boolean): void => {
    setSelected(previous => {
      const copy = new Set(previous)
      for (const file of files) { if (next) copy.add(file); else copy.delete(file) }
      return copy
    })
  }
  const setDestination = (key: string, value: DestinationValue): void => {
    setDestinations(previous => ({ ...previous, [key]: value }))
  }

  // Enter = the stage's primary button (Import … / Close); the pick stage's path
  // input keeps its own Enter → scan. Escape = close (the Modal's own).
  useDialogDefaultAction(true, stage)

  // -- render ----------------------------------------------------------------
  const wide = stage === 'decide' || stage === 'summary'
  const title = stage === 'large' ? 'Large sessions' : `Import ${label} sessions`
  const backToPick = (): void => { setError(undefined); setStage('pick') }

  let body: ReactNode
  let footer: ReactNode
  let description: string | undefined

  switch (stage) {
    case 'pick': {
      body = (
        <PickStage
          source={source}
          label={label}
          sources={sources}
          upload={upload}
          deviceError={deviceError}
          error={error}
          onFiles={(files) => { void onFiles(files) }}
          onServerStore={() => { if (root !== undefined) void startScan(root) }}
          onCancelUpload={cancelUpload}
        />
      )
      footer = <Button variant="outline" onClick={close}>Cancel</Button>
      break
    }
    case 'scanning': {
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Busy>Scanning <span style={mono}>{scanPath !== undefined ? tildify(scanPath) : ''}</span>…</Busy>
          <ErrorLine text={error} />
        </div>
      )
      footer = <Button variant="outline" onClick={close}>Cancel</Button>
      break
    }
    case 'decide': {
      // Uploaded from a machine other than the server: the recording dirs are the client's.
      const remoteDirs = scan?.uploaded === true && sources?.client.sameMachine === false
      const total = scan?.workspaces.reduce((sum, workspace) => sum + workspace.sessions.length, 0) ?? 0
      const selectable = scan?.workspaces.reduce((sum, workspace) => sum + workspace.sessions.filter(isSelectable).length, 0) ?? 0
      const single = scan?.kind === 'session' ? scan.workspaces[0] : undefined
      const only = single?.sessions[0]
      description = only !== undefined
        ? (scan?.uploaded === true ? 'Uploaded 1 session' : tildify(only.file))
        : scanPath !== undefined
          ? `${scan?.uploaded === true ? 'Uploaded' : `${tildify(scanPath)} —`} ${plural(total, 'session')} in ${plural(scan?.workspaces.length ?? 0, 'workspace')}${selectable !== total ? `, ${String(selectable)} importable` : ''}`
          : undefined
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {single !== undefined && only !== undefined
            ? (
              <>
                {!isSelectable(only) && (
                  <Banner tone="warn">
                    {only.imported ? 'This session is already imported into DSH.' : 'This session cannot be imported: it duplicates another transcript.'} Go back and pick another file.
                  </Banner>
                )}
                <SessionCard
                  workspace={single}
                  session={only}
                  existing={existing}
                  destination={destinations[single.key] ?? initialDestinationValue(single)}
                  newBase={newBase}
                  {...remoteDirs ? { remoteDirs: { host: sources?.client.host } } : {}}
                  onDestination={(value) => { setDestination(single.key, value) }}
                />
                <NewBaseField value={newBase} enabled={isSelectable(only) && (destinations[single.key] ?? initialDestinationValue(single)) === 'new'} onChange={setNewBase} />
              </>
            )
            : (
              <TreeStage
                workspaces={scan?.workspaces ?? []}
                existing={existing}
                selected={selected}
                destinations={destinations}
                showHidden={showHidden}
                newBase={newBase}
                remoteDirs={remoteDirs}
                onNewBase={setNewBase}
                onToggle={toggle}
                onDestination={setDestination}
              />
            )}
          <ErrorLine text={error} />
        </div>
      )
      const allSessions = scan?.workspaces.flatMap(workspace => workspace.sessions) ?? []
      const importedCount = allSessions.filter(session => session.imported).length
      const duplicateCount = allSessions.filter(session => !session.imported && session.duplicateOf !== undefined).length
      const hiddenLabel = importedCount > 0 && duplicateCount > 0 ? 'Show already imported and duplicate' : importedCount > 0 ? 'Show already imported' : 'Show duplicate'
      footer = (
        <>
          <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 14, minWidth: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }}>
            <span style={{ whiteSpace: 'nowrap' }}>{String(count)} selected</span>
            {single === undefined && importedCount + duplicateCount > 0 && (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }} title={`${String(importedCount + duplicateCount)} grayed-out session${importedCount + duplicateCount === 1 ? '' : 's'}: already in DSH, or duplicated within this selection`}>
                <input type="checkbox" checked={showHidden} onChange={(event) => { setShowHidden(event.target.checked) }} style={{ width: 15, height: 15, margin: 0, accentColor: 'var(--dsw-alias-brand-primary)' }} />
                {hiddenLabel}
              </label>
            )}
          </span>
          <Button variant="outline" onClick={backToPick}>Back</Button>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button variant="primary" {...DIALOG_DEFAULT} disabled={count === 0} onClick={proceed}>Import {plural(count, 'session')}</Button>
        </>
      )
      break
    }
    case 'large': {
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {scan !== undefined && <LargeSection count={largeCount} largeTokens={scan.largeTokens} choice={largeChoice} onChange={setLargeChoice} />}
          <ErrorLine text={error} />
        </div>
      )
      footer = (
        <>
          <Button variant="outline" onClick={() => { setStage('decide') }}>Back</Button>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button variant="primary" {...DIALOG_DEFAULT} onClick={() => { void startImport() }}>Import {plural(count, 'session')}</Button>
        </>
      )
      break
    }
    case 'running': {
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <RunningStage progress={progress} total={job?.total ?? count} />
          <ErrorLine text={error} />
        </div>
      )
      footer = <span style={small}>Closing this dialog does not stop the import; the sessions appear in the sidebar as they are written.</span>
      break
    }
    case 'summary': {
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {error !== undefined && <Banner tone="danger">{error}</Banner>}
          <SummaryStage results={progress?.results ?? []} total={progress?.total ?? job?.total ?? count} />
        </div>
      )
      footer = <Button variant="primary" {...DIALOG_DEFAULT} onClick={close}>Close</Button>
      break
    }
  }

  return (
    <Modal open headless title={title} onClose={close} width={wide ? 760 : 560}>
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '20px 20px 10px 24px' }}>
          <h2 style={{ margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>{title}</h2>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={close}
            style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, border: 'none', borderRadius: 8, background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', fontSize: 16, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>
        {description !== undefined && description !== '' && (
          <p style={{ margin: 0, padding: '0 24px', fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' }}>{description}</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, marginTop: 16, padding: '0 24px' }}>{body}</div>
        {footer !== undefined && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '20px 24px 0' }}>{footer}</div>
        )}
      </div>
    </Modal>
  )
}

function ImportDialog({ store, rpc }: { store: DialogStore, rpc: ClientConnectionRpc }) {
  const [state, setState] = useState<DialogState>(store.get())
  useEffect(() => store.subscribe(setState), [store])
  if (!state.open) return null
  // `generation` as key: each open starts a fresh flow (no stale scan/progress).
  return <ImportFlow key={state.generation} source={state.source} rpc={rpc} onClose={() => { store.close() }} />
}

// ---------------------------------------------------------------------------
// Plugin

export const name = 'import-sessions'
export const inject = ['slots', 'commandUi', 'connection', 'sessions']

export function apply(ctx: Context): void {
  const store = new DialogStore()
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc

  for (const command of COMMANDS) {
    ctx.effect(() => ctx.commandUi.decorate({
      name: command.name,
      available: () => true,
      ui: { kind: 'action', run: () => { store.open(command.source) } },
    }), `import-sessions: bare /${command.name} opens the import dialog`)
  }

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'tali-import-sessions',
    inject: () => ({ store, rpc }),
  }, ({ store, rpc }: { store: DialogStore, rpc: ClientConnectionRpc }) => <ImportDialog store={store} rpc={rpc} />)), 'import-sessions: dialog overlay')
}
