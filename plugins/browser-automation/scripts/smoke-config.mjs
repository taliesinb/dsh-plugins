// Keyless, offline smoke: config defaults, preflight messages, curated tool
// registration per agent, window-id rules against fake connections, and the
// pure helpers (youtube parsing, screenshot geometry).
import { existsSync } from 'node:fs'
import * as plugin from '../index.js'
import { BrowserSessions, selectedPageId } from '../windows.mjs'

const fail = (message) => { throw new Error(message) }

// ---- config
const filled = plugin.Config({})
if (!filled.safari.enabled || !filled.chrome.enabled || filled.subagents !== true || filled.idleMinutes !== 30 || filled.safari.reader.maxIdle !== 1) fail(`defaults: ${JSON.stringify(filled)}`)
const args = plugin.chromeArgs(plugin.Config({ chrome: { headless: true } }))
if (!args.includes('--isolated') || !args.includes('--headless') || !args.includes('--ignoreDefaultChromeArg=--enable-automation') || !args.includes('--no-performance-crux')) fail(`chrome args: ${args}`)
if (filled.chrome.quietStderr !== true) fail('quietStderr default')
// Default chrome.command '' = the version pinned in package.json, run by this node; args[0] is its bin script.
const bundled = plugin.chromeServer(filled)
const pinned = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8')).dependencies['chrome-devtools-mcp']
if (!/^\d+\.\d+\.\d+$/.test(pinned)) fail(`chrome-devtools-mcp must be pinned exactly, got "${pinned}"`)
if (bundled.command !== process.execPath || bundled.missing !== undefined || bundled.describe !== `bundled chrome-devtools-mcp ${pinned}` || !bundled.args[0].endsWith('/build/src/bin/chrome-devtools-mcp.js') || !existsSync(bundled.args[0])) fail(`bundled server: ${JSON.stringify(bundled)}`)
if (args[0] !== bundled.args[0]) fail('chromeArgs must start with the bundled bin script')
const explicit = plugin.chromeServer(plugin.Config({ chrome: { command: process.execPath } }))
if (explicit.command !== process.execPath || explicit.args.length !== 0 || explicit.missing !== undefined) fail(`explicit command: ${JSON.stringify(explicit)}`)
const env = plugin.chromeEnv('/tmp/x-localstorage.json')
if (env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS !== '1' || env.NODE_OPTIONS !== '--localstorage-file=/tmp/x-localstorage.json') fail(`chrome env: ${JSON.stringify(env)}`)
// stderr filter: exactly the launch boilerplate chrome-devtools-mcp 1.8.0 prints (captured from `pnpm dsh web`), nothing else.
{
  const { CHROME_STDERR_NOISE, isNoiseLine, readLines } = await import('../servers.mjs')
  const boilerplate = `(node:23256) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
(Use \`node --trace-warnings ...\` to show where the warning was created)

Update available: 1.8.0 -> 1.9.0
Run \`npm install chrome-devtools-mcp@latest\` to update.

chrome-devtools-mcp exposes content of the browser instance to the MCP clients allowing them to inspect,
debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.
Performance tools may send trace URLs to the Google CrUX API to fetch real-user experience data. To disable, run with --no-performance-crux.

Google collects usage statistics to improve Chrome DevTools MCP. To opt-out, run with --no-usage-statistics.
For more details, visit: https://github.com/ChromeDevTools/chrome-devtools-mcp#usage-statistics
[chrome-devtools-mcp] The connecting client did not negotiate the MCP roots capability. File-writing tools will be restricted to the OS temp directory. To restore the previous unrestricted behavior, start the server with --allow-unrestricted-paths.`
  for (const line of boilerplate.split('\n')) if (!isNoiseLine(line, CHROME_STDERR_NOISE)) fail(`boilerplate not filtered: ${line}`)
  for (const line of ['Error: Failed to launch the browser process!', '[MCP Context] Error resolving real path for /x: EACCES', 'Update your Chrome to continue', 'Could not write /tmp/x']) if (isNoiseLine(line, CHROME_STDERR_NOISE)) fail(`real message filtered: ${line}`)
  const { PassThrough } = await import('node:stream')
  const stream = new PassThrough(); const lines = []
  readLines(stream, (line) => lines.push(line))
  stream.write('ab'); stream.write('c\nde\r\n'); stream.end('tail')
  await new Promise(resolve => stream.on('end', () => setImmediate(resolve)))
  if (JSON.stringify(lines) !== JSON.stringify(['abc', 'de', 'tail'])) fail(`readLines: ${JSON.stringify(lines)}`)
}

// ---- preflight
const missing = plugin.preflightFor(plugin.Config({ safari: { driver: '/nonexistent/safaridriver' }, chrome: { command: '/nonexistent/cdm' } }))
for (const [browser, needle] of [['safari', 'classic Safari cannot be used'], ['chrome', 'npm i -g chrome-devtools-mcp']]) {
  let message = ''
  try { missing(browser) } catch (error) { message = String(error) }
  if (!message.includes('unavailable') || !message.includes(needle)) fail(`preflight ${browser}: ${message}`)
}
console.log('smoke ok: config + preflight')

// ---- registration per agent (no process is spawned at registration)
{
  const registered = new Map()
  const created = []
  const fakeAgent = (id, depth) => ({ id, session: { header: { cwd: '/tmp', delegationDepth: depth } }, ctx: { tools: { register: (def) => { registered.set(`${id}:${def.name}`, def); return () => { registered.delete(`${id}:${def.name}`) } } } } })
  const pre = fakeAgent('pre', 0)
  const ctx = {
    logger: { info() {}, warn(m) { fail(`unexpected warn: ${m}`) } },
    on: (event, cb) => { if (event === 'agent/created') created.push(cb); if (event === 'agent/disposed') created.disposed = cb },
    effect: (run) => { const d = run(); let done = false; return () => { if (!done) { done = true; d?.() } } },
    tools: {},
    agents: { list: () => [pre] },
    get: () => undefined,
  }
  plugin.apply(ctx, plugin.Config({ subagents: false }))
  created[0]({ agent: fakeAgent('top', 0) })
  created[0]({ agent: fakeAgent('child', 1) })
  const names = [...registered.keys()].filter(k => k.startsWith('top:')).map(k => k.slice(4)).sort()
  const expected = ['chrome_click', 'chrome_close', 'chrome_console_messages', 'chrome_evaluate_expression', 'chrome_evaluate_function', 'chrome_fill', 'chrome_fill_form', 'chrome_get_network_request', 'chrome_get_page_content', 'chrome_get_page_structure', 'chrome_get_screenshot', 'chrome_handle_dialog', 'chrome_hover', 'chrome_interact', 'chrome_navigate', 'chrome_network_requests', 'chrome_open', 'chrome_press_key', 'chrome_save_screenshot', 'chrome_set_viewport_size', 'chrome_snapshot', 'chrome_type_text', 'chrome_wait_for', 'safari_click', 'safari_close', 'safari_console_messages', 'safari_evaluate_expression', 'safari_evaluate_function', 'safari_get_network_request', 'safari_get_page_content', 'safari_get_page_structure', 'safari_get_screenshot', 'safari_get_youtube_notes', 'safari_handle_dialog', 'safari_hover', 'safari_interact', 'safari_navigate', 'safari_network_requests', 'safari_open', 'safari_press_key', 'safari_save_screenshot', 'safari_set_viewport_size', 'safari_type_text', 'safari_wait_for']
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`tool names: ${names.join(',')}`)
  if ([...registered.keys()].some(k => k.startsWith('child:'))) fail('child agent got tools with subagents=false')
  if (![...registered.keys()].some(k => k.startsWith('pre:'))) fail('pre-existing agent not attached')
  const shot = registered.get('top:safari_get_screenshot')
  if (typeof shot.finalizeContent !== 'function' || shot.parameters.properties.querySelector === undefined) fail('safari_get_screenshot shape')
  created.disposed({ agent: pre })
  if ([...registered.keys()].some(k => k.startsWith('pre:'))) fail('disposed agent tools not removed')
  console.log(`smoke ok: ${expected.length} curated tools registered per agent; child filtered; disposal unwinds`)
}

// ---- window registry rules with fake connections
{
  const spawned = []
  const fakeConn = (kind) => ({ closed: false, calls: [], async callRaw(name, a) { this.calls.push([name, a]); return { content: [{ type: 'text', text: name === 'new_page' ? `## Pages\n1: about:blank\n${2 + spawned.length}: X [selected]` : 'ok' }] } }, async callText(name, a) { return (await this.callRaw(name, a)).content[0].text }, async close() { this.closed = true } })
  // monkey-patch connectServer via a subclass hook: BrowserSessions imports it, so test through the public API with a stub module is heavy; instead validate parse/list logic directly.
  const sessions = new BrowserSessions({ safariSpec: () => ({}), chromeSpec: () => ({}), timeoutMs: 1000, idleMs: 0, onIdleClose() {}, trace() {}, logger: console })
  const agentA = { id: 'A', session: { header: {} } }
  const agentB = { id: 'B', session: { header: {} } }
  const sA = sessions.session(agentA); const sB = sessions.session(agentB)
  if (sA.index !== 0 || sB.index !== 1) fail('session numbering')
  // simulate two safari windows in A without spawning
  sA.safari.set(0, { id: 's:0:0', conn: fakeConn() }); sA.safari.set(1, { id: 's:0:1', conn: fakeConn() }); sA.nextWindow.safari = 2
  const r0 = await sessions.resolveSafari(agentA, 's:0:1'); if (r0.id !== 's:0:1' || r0.opened) fail('resolve by id')
  let message = ''
  try { await sessions.resolveSafari(agentA) } catch (e) { message = String(e) }
  if (!message.includes('2 Safari windows open') || !message.includes('s:0:0, s:0:1')) fail(`ambiguous: ${message}`)
  message = ''
  try { await sessions.resolveSafari(agentB, 's:0:0') } catch (e) { message = String(e) }
  if (!message.includes('does not belong to this session')) fail(`cross-session: ${message}`)
  message = ''
  try { await sessions.resolveChrome(agentA, 's:0:0') } catch (e) { message = String(e) }
  if (!message.includes('is a safari window')) fail(`browser mismatch: ${message}`)
  message = ''
  try { sessions.parse(agentA, 'safari', 'nope') } catch (e) { message = String(e) }
  if (!message.includes('Invalid windowId')) fail(`invalid id: ${message}`)
  const closed = await sessions.closeSafari(agentA, 's:0:0')
  if (closed.join() !== 's:0:0' || sessions.listIds(agentA, 'safari').join() !== 's:0:1') fail('close one')
  const single = await sessions.resolveSafari(agentA); if (single.id !== 's:0:1') fail('single-window default')
  if ((await sessions.closeSafari(agentA)).join() !== 's:0:1') fail('close all')
  if (selectedPageId('## Pages\n1: about:blank\n2: Example (https://example.com/) [selected]') !== 2 || selectedPageId('nothing') !== undefined) fail('selectedPageId')
  console.log('smoke ok: window ids (numbering, ambiguity, cross-session, browser mismatch, close)')
}

// ---- pure helpers
{
  const { canonicalWatchUrl, shapeNotes, renderNotes } = await import('../youtube-notes.mjs')
  for (const input of ['https://www.youtube.com/watch?v=QgH9sr7G13Q&t=12s', 'https://youtu.be/QgH9sr7G13Q', 'youtube.com/shorts/QgH9sr7G13Q', 'QgH9sr7G13Q']) {
    const { url, videoId } = canonicalWatchUrl(input)
    if (videoId !== 'QgH9sr7G13Q' || url !== 'https://www.youtube.com/watch?v=QgH9sr7G13Q') fail(`canonicalWatchUrl(${input}) → ${url}`)
  }
  let rejected = false
  try { canonicalWatchUrl('https://example.com/') } catch { rejected = true }
  if (!rejected) fail('non-YouTube URL accepted')
  const notes = shapeNotes({ videoId: 'x', title: 'T', author: 'A', lengthSeconds: 2118, viewCount: 1234, keywords: [], description: 'Sponsor: https://a.example/x\n\nSECTIONS\n0:00 - Intro\n1:04 - When Deep Learning Stopped Working\n(13:20) Loss Landscapes\n1:02:03 – Late chapter\nnot a chapter 12:34 in text\nhttps://b.example/y' }, 'https://www.youtube.com/watch?v=x')
  if (notes.chapters.length !== 4 || notes.chapters[2].title !== 'Loss Landscapes' || notes.chapters[3].time !== '1:02:03' || notes.links.length !== 2) fail(`notes: ${JSON.stringify(notes.chapters)}`)
  if (!renderNotes(notes).includes('## Chapters (4)')) fail('render notes')
  const { cropBox, rectMoved, parseMeasurement, measureScript } = await import('../safari-screenshot.mjs')
  const box = cropBox({ x: 10.4, y: 20.6, width: 100.2, height: 50 }, { width: 1024, height: 768 }, { width: 2048, height: 1536 })
  if (box.scale !== 2 || box.x !== 20 || box.y !== 41 || box.width !== 202 || box.height !== 101 || box.clipped) fail(`cropBox: ${JSON.stringify(box)}`)
  let outside = false
  try { cropBox({ x: 2000, y: 0, width: 10, height: 10 }, { width: 1024, height: 768 }, { width: 2048, height: 1536 }) } catch { outside = true }
  if (!outside) fail('offscreen rect accepted')
  if (rectMoved({ x: 0, y: 0, width: 10, height: 10 }, { x: 1, y: 1, width: 10, height: 10 }) || !rectMoved({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 5, width: 10, height: 10 })) fail('rectMoved')
  if (parseMeasurement(JSON.stringify(JSON.stringify({ rect: { x: 1, y: 2, width: 3, height: 4 } }))).rect.width !== 3) fail('double-encoded measurement')
  if (!measureScript('h1 > a', true).includes('"h1 > a"')) fail('measureScript embedding')
  console.log('smoke ok: youtube + screenshot helpers')

  // get_page_content decoding: inline envelope, "Saved large output" pointer, bare text — never an undefined field.
  const { unwrapPageContent } = await import('../servers.mjs')
  const { writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const spill = join(tmpdir(), `dsh-smoke-spill-${process.pid}.json`)
  await writeFile(spill, JSON.stringify({ content: { type: 'root', children: [] }, url: 'https://x.example/', title: 'X', format: 'json' }))
  try {
    const inline = await unwrapPageContent(JSON.stringify({ title: 'T', url: 'https://t.example/', content: 'body', format: 'markdown' }))
    if (inline.title !== 'T' || inline.content !== 'body') fail(`inline envelope: ${JSON.stringify(inline)}`)
    const spilled = await unwrapPageContent(`Saved large output to '${spill}' (42.9 kB). Use the Read tool to view its contents.`)
    if (spilled.title !== 'X' || spilled.content !== '{"type":"root","children":[]}') fail(`spilled envelope: ${JSON.stringify(spilled)}`)
    const bare = await unwrapPageContent('just text')
    if (bare.content !== 'just text' || 'url' in bare || 'title' in bare) fail(`bare text: ${JSON.stringify(bare)}`)
    const noTitle = await unwrapPageContent(JSON.stringify({ url: 'https://u.example/', content: 'c' }))
    if ('title' in noTitle) fail('undefined title leaked into output')
  } finally { await rm(spill, { force: true }) }
  console.log('smoke ok: page-content unwrapping (inline, spilled-to-file, bare)')

  const { cleanMarkdown, planRead, describeCollapsed, renderStructure, scopeScript, expandScript, STRUCTURE_SCRIPT, MARK_HEADINGS_SCRIPT } = await import('../page-read.mjs')
  const cleaned = cleanMarkdown('Title\n![]()\n[](https://x.example/icon)\n\n\n\nBody ![]() here  \n![logo](https://x.example/l.svg)\n')
  if (cleaned !== 'Title\n\nBody  here\n![logo](https://x.example/l.svg)\n') fail(`cleanMarkdown: ${JSON.stringify(cleaned)}`)
  if (cleanMarkdown('the deprecated [](https://github.com/makenotion/notion-mcp-server) package\u200B') !== 'the deprecated [notion-mcp-server](https://github.com/makenotion/notion-mcp-server) package') fail('inline empty link should regain its text from the URL')
  const iso = planRead({}, true)
  if (!(iso.expand && iso.scope === 'auto' && !iso.markHeadings && iso.clean && iso.nodeIds === 'none' && iso.format === 'markdown')) fail(`isolated defaults: ${JSON.stringify(iso)}`)
  const wk = planRead({ format: 'webkitMarkdown' }, true)
  if (!(wk.markHeadings && wk.clean)) fail(`webkitMarkdown defaults: ${JSON.stringify(wk)}`)
  const win = planRead({ format: 'textTree', nodeIds: 'allContainers' }, false)
  if (win.expand || win.scope !== 'page' || win.markHeadings || win.clean || win.nodeIds !== 'allContainers') fail(`window defaults: ${JSON.stringify(win)}`)
  let both = false
  try { planRead({ section: '#a', selectors: ['b'] }, true) } catch { both = true }
  if (!both) fail('section + selectors accepted together')
  if (describeCollapsed({ details: 14, buttons: 1, tabGroups: 1 }) !== '14 collapsed <details> sections, 1 collapsed accordion button and 1 tab group') fail(describeCollapsed({ details: 14, buttons: 1, tabGroups: 1 }))
  // Scripts must be syntactically valid function bodies with parameters embedded as JSON.
  const AsyncFunction = (async () => {}).constructor
  const { domMarkdownScript } = await import('../dom-markdown.mjs')
  for (const [label, body] of [['dom-markdown', domMarkdownScript({ maxWordsPerParagraph: 0, includeURLs: true })], ['expand', expandScript()], ['scope', scopeScript({ selectors: ['a"b'], scope: 'auto', isolated: true })], ['scope-section', scopeScript({ section: '#x', scope: 'page', isolated: false })], ['structure', STRUCTURE_SCRIPT], ['mark', MARK_HEADINGS_SCRIPT]]) {
    try { new AsyncFunction(body) } catch (error) { fail(`${label} script does not parse: ${error.message}`) }
  }
  if (!scopeScript({ selectors: ['a"b'], scope: 'auto', isolated: true }).includes('"a\\"b"')) fail('selector not JSON-embedded')
  const outline = renderStructure({ mode: 'isolated', structure: { title: 'T', url: 'https://t.example/', chars: 1000, main: { selector: '#content', chars: 800 }, landmarks: [{ tag: 'nav', label: 'Pages', selector: '#sidebar', chars: 200 }], headings: [{ level: 1, text: 'Top', selector: '#page-title' }, { level: 2, text: 'Sec', selector: '#sec', hidden: true }, { level: 3, text: 'Nav head', selector: 'body > nav > h3', chrome: true }], collapsed: { details: 3, detailsTotal: 5, buttons: 0, tablists: [{ label: 'Code', selector: '#tabs', tabs: ['A', 'B'], selected: 0 }] }, forms: 1, iframes: 0, links: 40 } })
  for (const needle of ['main content: #content (800 chars, 80%)', '  h1 Top → #page-title', '    h2 Sec [collapsed] → #sec', 'nav/header/footer: 1 (omitted)', '3 of 5 <details> closed', 'tab group "Code" → #tabs: [A] | B']) {
    if (!outline.includes(needle)) fail(`renderStructure missing ${JSON.stringify(needle)}:\n${outline}`)
  }
  console.log('smoke ok: page-read planning, cleanup, scripts parse, structure outline')

  const { unfence, chromeExtractScript, chromeReadCall, CHROME_FORMATS } = await import('../chrome-read.mjs')
  if (unfence('Script ran on page and returned:\n```json\n{"a":1}\n```') !== '{"a":1}' || unfence('plain') !== 'plain') fail('unfence')
  for (const format of CHROME_FORMATS) {
    try { new AsyncFunction(chromeExtractScript({ format, maxWordsPerParagraph: 0, includeURLs: true })) } catch (error) { fail(`chrome extract script (${format}) does not parse: ${error.message}`) }
  }
  const calls = []
  const bridge = chromeReadCall(async (name, args) => { calls.push([name, args]); return 'Script ran on page and returned:\n```json\n{"url":"https://c.example/","title":"C","format":"markdown","content":"# C"}\n```' })
  const envelope = JSON.parse(await bridge('get_page_content', { format: 'markdown', maxWordsPerParagraph: 0, includeURLs: true }))
  if (envelope.content !== '# C' || calls[0][0] !== 'evaluate_script' || !calls[0][1].function.startsWith('async () => {')) fail(`chrome bridge: ${JSON.stringify(calls[0]).slice(0, 120)}`)
  let unsupported = false
  try { await bridge('get_page_content', { format: 'textTree' }) } catch { unsupported = true }
  if (!unsupported) fail('chrome bridge accepted a Safari-only format')
  console.log('smoke ok: chrome read bridge (unfence, serializer parses, format guard)')

  // Every tool result passes through stripUndefined: `{ uid: undefined }` is what made chrome_save_screenshot fail live.
  const { stripUndefined } = await import('../curated-tools.mjs')
  const { losslessReason } = await import('./lossless.mjs')
  if (losslessReason({ a: 1, uid: undefined }) === undefined) fail('lossless helper missed undefined')
  const stripped = stripUndefined({ windowId: 'c:0:0', uid: undefined, fullPage: false, nested: { title: undefined, ok: [1, undefined, { x: undefined }] } })
  if (losslessReason(stripped) !== undefined || 'uid' in stripped || 'title' in stripped.nested || stripped.nested.ok[1] !== null) fail(`stripUndefined: ${JSON.stringify(stripped)}`)
  // And the wrapper is in place on a real tool: a fake capture returning `uid: undefined` comes back clean.
  const { createTools } = await import('../curated-tools.mjs')
  const fakeConn = { callRaw: async () => ({ content: [{ type: 'image', data: Buffer.from('x').toString('base64'), mimeType: 'image/png' }] }), callText: async () => '' }
  const fakeSessions = { resolveChrome: async () => ({ id: 'c:0:0', pageId: 1, conn: fakeConn, opened: false }) }
  const fakeTools = createTools({ sessions: fakeSessions, readerPool: undefined, admitImage: async () => ({ reason: 'test' }), inlineImages: new WeakMap(), preflight: () => {}, limits: { maxChars: 1000 } }, { id: 'a', session: { header: { cwd: tmpdir() } } })
  const saveShot = fakeTools.find(t => t.name === 'chrome_save_screenshot')
  const saved = await saveShot.execute({ path: join(tmpdir(), `dsh-smoke-shot-${process.pid}.png`) }, { agent: { id: 'a', session: { header: { cwd: tmpdir() } } } })
  if (losslessReason(saved) !== undefined || 'uid' in saved || saved.fullPage !== false) fail(`chrome_save_screenshot result: ${JSON.stringify(saved)}`)
  await rm(saved.path, { force: true })
  console.log('smoke ok: results are stripped of undefined (lossless JSON)')

  // chrome-devtools-mcp spills captures ≥ 2 MB to disk and answers with text only ("Took a screenshot of the
  // current page's viewport.\nSaved screenshot to <tmp>/screenshot.png.") — the tensatory session saw four of
  // these reported as "chrome screenshot failed: Took a screenshot …". The plugin must read the file back.
  const { mkdtemp } = await import('node:fs/promises')
  const { describeBlocks, savedFileOf } = await import('../servers.mjs')
  if (savedFileOf("Took a screenshot of the current page's viewport.\nSaved screenshot to /tmp/chrome-devtools-mcp-91zev3/screenshot.png.") !== '/tmp/chrome-devtools-mcp-91zev3/screenshot.png') fail('savedFileOf: trailing period')
  if (savedFileOf('Saved screenshot to /tmp/a b/shot.jpeg') !== '/tmp/a b/shot.jpeg' || savedFileOf('Took a screenshot.') !== undefined) fail('savedFileOf: spaces / absent')
  if (describeBlocks({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) !== 'text ×2' || describeBlocks({}) !== '(no content blocks)') fail(`describeBlocks: ${describeBlocks({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })}`)
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const spillDir = await mkdtemp(join(tmpdir(), 'chrome-devtools-mcp-'))
  const spillPath = join(spillDir, 'screenshot.png')
  await writeFile(spillPath, pngMagic)
  const replies = []
  const scriptedConn = { callRaw: async (name, a) => { replies.push([name, a]); return scriptedConn.next() }, callText: async () => '' }
  const scriptedSessions = { resolveChrome: async () => ({ id: 'c:2:1', pageId: 7, conn: scriptedConn, opened: false }) }
  const scripted = createTools({ sessions: scriptedSessions, readerPool: undefined, admitImage: async () => ({ reason: 'test' }), inlineImages: new WeakMap(), preflight: () => {}, limits: { maxChars: 1000, timeoutMs: 60_000 } }, { id: 'a', session: { header: { cwd: tmpdir() } } })
  const getShot = scripted.find(t => t.name === 'chrome_get_screenshot')
  const render = (value) => getShot.output.render({}, value)[0].text
  const execShot = { agent: { id: 'a', session: { header: { cwd: tmpdir() } } }, signal: new AbortController().signal }
  scriptedConn.next = () => ({ content: [{ type: 'text', text: `Took a screenshot of the current page's viewport.\nSaved screenshot to ${spillPath}.` }] })
  const spilledShot = await getShot.execute({}, execShot)
  if (spilledShot.source !== 'file' || spilledShot.byteLength !== pngMagic.length || spilledShot.format !== 'png' || spilledShot.fallbackPath === undefined) fail(`spilled screenshot: ${JSON.stringify(spilledShot)}`)
  if (losslessReason(spilledShot) !== undefined) fail(`spilled screenshot not lossless: ${losslessReason(spilledShot)}`)
  if (!render(spilledShot).includes('wrote it to disk')) fail(`spilled render: ${render(spilledShot)}`)
  await new Promise(resolve => setTimeout(resolve, 50)) // cleanup is fire-and-forget
  if (existsSync(spillPath) || existsSync(spillDir)) fail('server temp capture not cleaned up')
  await rm(spilledShot.fallbackPath, { force: true })
  // Server error → the server's words, the target, the request, and the remedy.
  scriptedConn.next = () => ({ isError: true, content: [{ type: 'text', text: 'Element with uid 2_57 no longer exists on the page.' }] })
  let failure = ''
  try { await getShot.execute({ uid: '2_57' }, execShot) } catch (error) { failure = error.message }
  for (const needle of ['chrome_get_screenshot', 'element uid "2_57"', 'c:2:1', 'chrome-devtools-mcp said: Element with uid 2_57 no longer exists', 'Hint: uids come from chrome_snapshot', 'Request: {"uid":"2_57"}']) {
    if (!failure.includes(needle)) fail(`stale-uid failure lacks ${JSON.stringify(needle)}:\n${failure}`)
  }
  // Success text but neither image nor file → says exactly what came back.
  scriptedConn.next = () => ({ content: [{ type: 'text', text: 'Took a screenshot of the full current page.' }] })
  failure = ''
  try { await getShot.execute({ fullPage: true }, execShot) } catch (error) { failure = error.message }
  if (!failure.includes('neither an image block nor a "Saved screenshot to <path>" line') || !failure.includes('Reply blocks: text') || !failure.includes('Reply text: Took a screenshot of the full current page.')) fail(`empty reply failure:\n${failure}`)
  // Saved-to path that does not exist → names the path and the read error.
  scriptedConn.next = () => ({ content: [{ type: 'text', text: 'Took a screenshot of the current page\'s viewport.\nSaved screenshot to /nonexistent/dir/screenshot.png.' }] })
  failure = ''
  try { await getShot.execute({}, execShot) } catch (error) { failure = error.message }
  if (!failure.includes('/nonexistent/dir/screenshot.png') || !failure.includes('could not be read back: ENOENT')) fail(`unreadable spill failure:\n${failure}`)
  // uid requested, server says it captured the viewport → NOTE in the summary.
  scriptedConn.next = () => ({ content: [{ type: 'text', text: 'Took a screenshot of the current page\'s viewport.' }, { type: 'image', data: pngMagic.toString('base64'), mimeType: 'image/png' }] })
  const mismatch = await getShot.execute({ uid: '1_3' }, execShot)
  if (!(mismatch.notes?.[0] ?? '').includes('requested element uid "1_3" but chrome-devtools-mcp reports it captured the viewport') || !render(mismatch).includes('NOTE: requested element uid')) fail(`mismatch note: ${JSON.stringify(mismatch)} / ${render(mismatch)}`)
  await rm(mismatch.fallbackPath, { force: true })
  // uid + fullPage rejected before any server call.
  const before = replies.length
  failure = ''
  try { await getShot.execute({ uid: '1_3', fullPage: true }, execShot) } catch (error) { failure = error.message }
  if (replies.length !== before || !failure.includes('not both')) fail(`uid+fullPage: ${failure}`)
  // MCP-SDK timeout on any forwarded tool → explained in terms of toolCallTimeoutMs, with the server tool named.
  const snapTool = scripted.find(t => t.name === 'chrome_snapshot')
  scriptedConn.callText = async () => { throw new Error('take_snapshot: MCP error -32001: Request timed out') }
  failure = ''
  try { await snapTool.execute({ verbose: true }, execShot) } catch (error) { failure = error.message }
  for (const needle of ['chrome_snapshot: server tool take_snapshot failed: MCP error -32001', 'within 60000 ms (browser-automation toolCallTimeoutMs)', 'chrome_handle_dialog', 'Request: {"verbose":true}']) {
    if (!failure.includes(needle)) fail(`timeout failure lacks ${JSON.stringify(needle)}:\n${failure}`)
  }
  // Aborted executions pass through untouched.
  const aborted = new AbortController(); aborted.abort()
  const abortError = new Error('aborted'); abortError.name = 'AbortError'
  scriptedConn.callText = async () => { throw abortError }
  let passed
  try { await snapTool.execute({}, { ...execShot, signal: aborted.signal }) } catch (error) { passed = error }
  if (passed !== abortError) fail('abort error was rewrapped')
  // chrome_interact step failures carry the same hint inline.
  const interact = scripted.find(t => t.name === 'chrome_interact')
  scriptedConn.callText = async (name) => { if (name === 'hover') throw new Error('hover: Error: Element with uid 1_39 no longer exists on the page.'); return 'ok' }
  const batch = await interact.execute({ interactions: [{ type: 'hover', purpose: 'hover top line', node: '1_39' }, { type: 'scroll', purpose: 'down', scrollDelta: { y: 10 } }] }, execShot)
  if (!/#1 hover .* → FAILED: hover: Error: Element with uid 1_39 no longer exists on the page\. — Hint: uids come from chrome_snapshot/.test(batch) || !/#2 scroll .* → ok/.test(batch)) fail(`interact hints:\n${batch}`)
  console.log('smoke ok: chrome screenshot spill-to-disk read-back, failure explanations (server words, target, request, hint, timeout), abort passthrough')
}
console.log(existsSync(filled.safari.driver) ? 'STP driver present: run pnpm run live:windows for the live matrix' : 'STP driver absent here')
