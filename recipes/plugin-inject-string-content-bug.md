# "This turn failed — content.some is not a function" (plugin `agent.inject` with string content)

**Date:** 2026-09-14. **Symptom:** a DSH session (tensatory `initial-review`,
`session-08f15142-022e-4029-a5bb-7d2d8f6656b0`) fails *every* turn instantly
with `This turn failed  content.some is not a function`; "try again" makes no
difference. In the transcript, just above the failure, a row
`Context injection · browser-automation` renders as a stack of
`Unknown content block` entries containing single characters (`"b"`, `"r"`,
`"o"`, …).

## Root cause

`agent.inject(input: UserMessage)` (`packages/core/agent-loop/src/agent.ts`)
takes a complete `UserMessage`, whose `content` is a `ContentBlock[]`
(`packages/llm/llm/src/message.ts`). Shipped plugins build it with
`createUserMessage({ content: [{ type: 'text', text }], source })` from
`@deepseek-ai/dsh-llm`, which also adds `role: 'user'` and a fresh `id`.

Two of our plain-JS host plugins passed a **bare string**:

```js
agent.inject({ content: `[browser-automation] Closed idle browser window(s) …`, source: PLUGIN_SOURCE })
```

Nothing validates the shape: the inbox splices it in, the loop persists it as a
`user/message` event verbatim (no `role`, no `id`, string `content`), and from
then on every request reconstruction walks history and hits
`contentHasImage()` → `content.some(...)` on a string
(`packages/llm/llm/src/content.ts:125`). The failure is *before* the LLM call,
so it repeats on every turn forever. The GUI's per-character "Unknown content
block" rendering is the same string-iterated-as-array confusion.

Trigger: the `onIdleClose` hook — fires when a browser window (`browser-automation`,
30 min) or Wolfram kernel (`wolfram-kernel-supervisor`, 60 min) is closed for
idleness while the agent is still live. That is why the session broke hours
after the last real work, and why the orphaned background job visible in the
session was a red herring.

## Fix 1 — the plugins (`~/github/tali-dash-plugins`)

Both `plugins/browser-automation/index.js` and
`plugins/wolfram-kernel-supervisor/index.js` now have

```js
import { randomUUID } from 'node:crypto'
…
function pluginNotice(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: PLUGIN_SOURCE }
}
…
onIdleClose: (agent, closed) => { try { agent.inject(pluginNotice(`…`)) } catch {} }
```

Inline rather than importing `createUserMessage` so neither plugin takes a
`link:` dependency on `@deepseek-ai/dsh-llm` (would need a `pnpm install` in
each plugin dir). `createUserMessage` additionally deep-freezes; the inbox does
not require that.

Rule for any future host plugin: **never hand `agent.inject/steer/followup` a
string `content`** — always `[{ type: 'text', text }]` plus `role: 'user'` and
an `id`. Grep before shipping:
`grep -rn -A2 '\.inject({' plugins --include='*.js' --include='*.mjs' | grep 'content: `'`.

Both plugins are loaded by absolute path from `~/.dsh/profiles/web/cordis.patch.yml`;
host-plugin source edits take effect at the next `dsh web` start (no live
reload for host `.js` entries).

## Fix 2 — repair the poisoned session log

The bad event is durable, so the plugin fix alone does not unbreak the
session. Tool: `~/github/tali-dash-plugins/tools/repair-session-string-content.mjs`.

```sh
LOG=~/.dsh/sessions/--Users-tali-github-tensatory--/session-08f15142-022e-4029-a5bb-7d2d8f6656b0/session.jsonl.zstd
node ~/github/tali-dash-plugins/tools/repair-session-string-content.mjs "$LOG" /tmp/fixed.jsonl.zstd
cp -p "$LOG" "$LOG.string-content.bak"
cp /tmp/fixed.jsonl.zstd "$LOG.tmp" && chmod 600 "$LOG.tmp" && mv -f "$LOG.tmp" "$LOG"
```

What it does: decodes the concatenated-frame zstd container, rewrites every
`user/message` (and every `agent/inbox/spliced … inserted[]` entry) whose
`content` is a string into `[{type:'text',text}]` + `role`/`id`, verifies seq
contiguity (see the packed-row note below), and writes header frame + one body
frame with the checksum flag, exactly as `compressZstdFrame` does. It then
re-reads its output and checks the first frame is exactly the header line.
Output is ~3× smaller than the original because one frame beats thousands of
tiny append frames; harmless.

Verify with DSH's real scanner (Node ≥ 22.18 strips TS types):

```js
const fmt = await import('/Users/tali/github/deepseek-harness/packages/session/session-persistence-jsonl/src/format.ts')
const scanned = fmt.scanLog(execFileSync('zstd', ['-dc', LOG], { maxBuffer: 1 << 30 }))  // pass a Buffer, not a string
scanned.events.filter(e => e.type === 'user/message' && !Array.isArray(e.data.content)).length  // must be 0
```

Then **restart `dsh web`**. A resumed agent stays in `ctx.agents` until the
process exits (no idle eviction in `packages/api/session-controller`), so the
in-memory copy of the bad message survives the file swap; appends open the file
fresh each time (`appendLines` → `open(path,'a')`), so swapping the file under
an *idle* live server is safe, but do it while the session is not mid-turn.

The projection cache (`~/.dsh/storages/session_projcache/sessions/<id>.json`)
keys on `seq`, which is unchanged, so it needs no invalidation.

## Traps

| Trap | Detail |
|---|---|
| `zstdDecompressSync` decodes ONE frame | The log is thousands of frames. The tool finds boundaries by scanning for the magic `0xFD2FB528` and greedily decoding candidate slices; `zstd -dc` on the CLI handles concatenation natively. |
| Packed chunk rows | The plaintext is not one event per line: `text-chunks` / `tool-call-chunks` / `reasoning-chunks` rows have `seq0` and cover `texts.length` (or `args.length`) seqs — **not** `dt.length` (`dt` has one fewer entry). Naive `seq === index` checks fail at the first packed row (`packages/core/session/src/chunk-rows.ts`). |
| `scanLog` wants a Buffer | Passing a string gives `buffer.subarray is not a function`. |
| Writes outside the workspace | `~/.dsh` and `~/github/tali-dash-plugins` each need one approval escalation per operation — expected (see `AGENTS.md`). |
| The `.bak` beside the log | Precedent from `shrink-session-surface.mjs` (`.preshrink.bak`); discovery keys on the exact `session.jsonl.zstd` name, so extra files in the session dir are ignored. |

## Finding the session from a GUI title

`~/.dsh/storages/session_projcache/sessions/*.json` holds `rows.title.val`
and `identity.cwd`; `grep -l '"initial-review"'` there gives the session id,
and the log lives at `~/.dsh/sessions/<--cwd-with-dashes-->/<id>/session.jsonl.zstd`.
