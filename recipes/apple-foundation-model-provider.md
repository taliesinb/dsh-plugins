# Recipe: Apple Foundation Model as a DSH provider

Reproducible steps to expose Apple's on-device Foundation model (Apple Intelligence)
as a selectable chat model in DeepSeek Harness. Verified 2026-09-03 on macOS 26.6.2
(arm64, Xcode 26.6 / Swift 6.3.3) with AFM v0.9.10 and the DSH Web GUI.

## How it works

Apple exposes the on-device model only through the Swift `FoundationModels`
framework — there is no system HTTP API, and LM Studio does not proxy it.
The bridge is **AFM** ([scouzi1966/maclocal-api](https://github.com/scouzi1966/maclocal-api)),
a native Swift server that wraps the framework in an OpenAI-compatible endpoint.
DSH then consumes it through the `llm-pi-ai` adapter as an ordinary custom
provider, exactly like an LM Studio route.

```
DSH (llm-pi-ai, api: openai-completions)
  → http://127.0.0.1:9997/v1  (afm server)
    → FoundationModels.framework (on-device model)
```

## Prerequisites

- Apple Silicon Mac, macOS 26+
- **Apple Intelligence enabled**: System Settings → Apple Intelligence & Siri.
  Until the toggle is on *and the model download has finished*, every request
  fails with `foundation_model_error: "Apple Intelligence is not enabled."`
  (A server restart is not required once it becomes available.)
- Homebrew

## 1. Install AFM — version matters

Check the machine's Swift runtime first:

```bash
swift --version   # 6.3.x on macOS 26 / Xcode 26
```

- **Swift 6.4+ (Xcode 27 / macOS 27):** current stable works, no workarounds:
  `brew install scouzi1966/afm/afm`
- **Swift 6.3 (Xcode 26 / macOS 26):** stable ≥ 0.9.17 aborts at startup with
  `503: Apple Foundation Models require the Swift 6.4 toolchain or newer`.
  Install the pinned rollback formula instead:

```bash
brew trust scouzi1966/afm          # Homebrew 6 refuses untrusted taps; per-formula
                                   # trust is whack-a-mole (formulae cross-reference
                                   # afm-next, afm-staging, ...), so trust the tap
brew install scouzi1966/afm/afm@0.9.10
brew link afm@0.9.10               # after uninstalling any newer afm
afm --version                      # v0.9.10
```

## 2. Fix the v0.9.10 metallib packaging bug

The 0.9.10 release tarball crashes the whole server (exit 255, curl gets
`Empty reply from server`) on the **first generation request** with:

```
MLX error: Failed to load the default metallib. library not found ...
  at /Volumes/edata/maclocal-api/.build/checkouts/mlx-swift/.../memory.cpp:24
```

Cause: the compiled-in metallib path points at the maintainer's build disk,
and the runtime's fallback searches for a bundle named `mlx-swift_Cmlx.bundle`,
but the tarball ships the shader library inside `MacLocalAPI_MacLocalAPI.bundle`.
Alias one name to the other next to both the symlinked and the real binary:

```bash
KEG=/opt/homebrew/Cellar/afm@0.9.10/0.9.10
ln -sfn "$KEG/libexec/MacLocalAPI_MacLocalAPI.bundle" /opt/homebrew/bin/mlx-swift_Cmlx.bundle
ln -sfn ../libexec/MacLocalAPI_MacLocalAPI.bundle "$KEG/bin/mlx-swift_Cmlx.bundle"
```

Notes from failed attempts: `MLX_METAL_PATH` env, changing cwd, and aliasing
under the *shipped* bundle name in `bin/` do **not** help; only the
`mlx-swift_Cmlx.bundle` alias works. The symlinks survive server restarts and
reinstalls of the same keg. Not needed on ≥ 0.9.17.

## 3. Run the server

```bash
afm --port 9997
```

- Default port is 9999 — check it is free first (`lsof -nP -iTCP:9999 -sTCP:LISTEN`);
  on this machine a local node service already owned 9999, hence 9997.
  If the port is busy, afm silently falls back to an *ephemeral* port, which
  breaks a configured `baseURL` — always pass `--port` explicitly.
- The process must outlive the setup session: run it in a Terminal tab, login
  item, or launchd job. (An agent's background job dies with its session.)
  **Better: let DSH host it** — the `tali-local-model-supervisor` plugin
  starts AFM on first use and stops it when no session needs it; see
  "Automation installed" below.

Smoke test:

```bash
curl -s http://127.0.0.1:9997/v1/models          # → model id "foundation"
curl -s http://127.0.0.1:9997/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer x' \
  -d '{"model":"foundation","messages":[{"role":"user","content":"Reply with exactly: ok"}],"max_tokens":50}'
```

Also verify `"stream": true` returns SSE chunks ending in `data: [DONE]` —
that is the shape DSH actually uses. Both verified working on v0.9.10.

## 4. DSH provider config

Add under `llm-pi-ai.providers` in `$DSH_HOME/settings.yaml`
(`~/.dsh/settings.yaml`). No restart needed; the model picker updates on the
next request.

```yaml
llm-pi-ai:
  providers:
    apple:
      displayName: Apple Foundation
      api: openai-completions
      baseURL: http://127.0.0.1:9997/v1
      headers:
        Authorization: Bearer x        # afm needs no key, but pi-ai's OpenAI
                                       # protocol insists on a key or an
                                       # Authorization header; dummy bearer wins
      compat:
        supportsDeveloperRole: false   # local-server request-shape corrections
        maxTokensField: max_tokens     # (per docs/user/guide/providers.md)
      models:
        - id: foundation
          name: Apple Foundation (on-device)
          contextWindow: 16384         # deliberate over-claim — see below;
                                       # the real window is 4096
          maxTokens: 1024              # per-request output cap keeping real
                                       # usage inside the true 4096 window
```

The provider id (`apple`) is permanent — sessions and defaults reference it.

### Why `contextWindow` must lie (the max_tokens=1 trap)

With an honest `contextWindow: 4096`, every reply is cut off after **one
token** (`finish_reason: "length"`, turn ends `max-tokens`). Verified via the
session log (`~/.dsh/sessions/.../session.jsonl.zstd`, `request/header` and
`assistant/message` events) and afm's request log, which showed DSH sending
`max_tokens=1`.

Root cause — pi-ai (`@earendil-works/pi-ai`, `dist/api/simple-options.js`)
computes each request's output budget as:

```
available = contextWindow − estimate(systemPrompt + tools JSON + messages) − 4096
max_tokens = min(requested, max(1, available))   // CONTEXT_SAFETY_TOKENS = 4096
```

Two compounding problems for a 4K model:

1. The **hardcoded 4096-token safety reserve** alone zeroes the budget for any
   model with `contextWindow ≤ 4096` — even an empty prompt clamps to 1.
2. The DSH agent payload is estimated at ~8.3k tokens (~1.7k system prompt +
   ~6.6k serialized tool schemas at 4 chars/token), even though afm v0.9.10
   **silently ignores the tools field** (no tool calling on the Apple backend)
   — the model actually receives only ~1.8k prompt tokens.

So the declared window must exceed `estimate + 4096 + desired output` ≈ 16384.
The over-claim is safe **only** because `maxTokens: 1024` bounds real usage to
~1.8k prompt + 1k output < 4096. Consequences to accept:

- **Long chats will still die**: history grows the real prompt; past ~2k tokens
  of history the FoundationModels session exceeds its true 4096 limit and afm
  errors. DSH compaction won't rescue it (it trusts the declared 16384).
  Start a new session instead.
- The model **cannot call tools** through afm v0.9.10 — it is a chat model in
  DSH, not an agent. (DSH's system prompt + tool catalog alone ≈ 8.3k estimated
  tokens; a real 4K agent would need a purpose-built minimal profile.)

### Shrinking the payload: use the `minimal` agent preset

Per-model overrides cannot say "this model takes no tools": `PiAiModelProfile`
and `LlmResolvedModelInfo` carry input modalities, capacities, reasoning, and
compat switches, but no tool-capability flag, and the agent loop sends the
session's visible tools to whatever model is selected. (Even if such a flag
existed, it would not fix the 1-token clamp alone — the fixed 4096 reserve
exceeds the whole window — but it would cut pi-ai's estimate by ~80%.)

What DSH does have is **agent presets** (`@deepseek-ai/dsh-agent-presets`):
per-session plugin compositions selected in the session picker, shipped under
`packages/preset/agent-presets/presets/`, user-authorable under
`<dshHome>/.agent-presets`. The shipped **`minimal`** preset is made for this:

- persona IS the complete system prompt (~13 tokens instead of ~1.7k)
- two tools only (persistent shell + `str_replace_editor`, ~0.5k tokens of
  schemas instead of ~6.6k), runtime-context snapshots suppressed
- caveat: no compaction plugin, so the session just ends at the window

Start sessions that target `apple/foundation` on the `minimal` preset: the
pi-ai estimate drops ≈ 8.3k → ≈ 0.5k tokens, and the *real* prompt drops
≈ 1.8k → a few hundred, roughly tripling the conversation room inside the true
4096 window. Keep `contextWindow: 16384` + `maxTokens: 1024` regardless — the
4096 reserve still demands the over-claim, and the output cap still guards the
real window. A preset switch is only possible while the session has produced
nothing, so pick it at session start.
- If the pi-ai `CONTEXT_SAFETY_TOKENS` heuristic ever becomes proportional
  (e.g. `min(4096, window/4)`), revisit these numbers.

### Automation installed: `minimal-no-tools` preset + `enforce-model-preset` plugin

Two local artifacts make the preset choice automatic (installed 2026-09-03):

1. **`~/.dsh/.agent-presets/minimal-no-tools/`** — a user preset derived from
   `minimal` with both tool groups removed: persona-only (`complete: true`,
   `includeRuntimeContext: false`), zero tool schemas on the wire. The whole
   model-visible payload is one sentence plus the conversation.

2. **`~/github/tali-dash-plugins/plugins/enforce-model-preset/`** — a local
   plugin (`tali-enforce-model-preset`, plain ESM, no build step; see its
   README for config semantics). Loaded per that repo's conventions: an
   absolute-path `insert` row in the live web profile
   (`~/.dsh/profiles/web/cordis.patch.yml`, row id `tali-enforce-model-preset`)
   plus a row in the repo's `cordis.dev.yml` overlay for the preview server;
   it also ships a bundle patch (`cordis.patch.yml`) for
   `dsh plugin --profile <name> add`. It listens to committed
   `model/selection` session events and switches still-blank, top-level
   sessions to a mapped preset through `ctx.agentPresets.select` (DSH's own
   queued, blank-checked switch; `agent-preset/locked` refusals are treated
   as normal). Configured rules (first match wins):

   | provider | preset |
   |---|---|
   | `apple` | `minimal-no-tools` |
   | `lmstudio` | `minimal` |
   | `*` (catch-all) | `standard` |

   The catch-all restores `standard` when a blank session moves to an unmapped
   model; remove it to let manual preset choices survive model changes.
   Mid-session model switches never change composition — DSH locks the preset
   once a turn has run. Subagent sessions (`delegationDepth > 0`) are ignored.

   Key APIs (for maintenance): `ctx.on('session/event', ...)` filtered to
   `model/selection`, `ctx.sessionProjections.stateOf(session, 'agentPreset')`
   for the current preset, `ctx.agents.get(session.id)` for the live agent.

3. **`~/github/tali-dash-plugins/plugins/local-model-supervisor/`** — a local
   plugin (`tali-local-model-supervisor`) that makes DSH host the AFM process
   itself, so no Terminal tab or launchd job is needed. On a `model/selection`
   or `request/header` naming the `apple` provider it starts
   `afm --port 9997` (single-flight) and polls `/v1/models` until healthy;
   other sessions reuse it; once no live agent selects `apple` and 15 minutes
   pass, the owned child is stopped. A server already healthy at first touch
   is **adopted** — reused and never killed — so a hand-started AFM (or one
   from another dsh instance) is respected. Child stdout/stderr goes to
   `/tmp/local-model-supervisor-afm.log`. See the plugin README for config and the
   verified behaviours; `ctx.agents.list()` plus the `modelSelection`
   projection are what decide "still in use".
   The profile declares `patchReload: live`, so patch edits apply without a
   restart; a brand-new plugin module may still need one `dsh web` restart to
   become importable.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `503 ... Swift 6.4 toolchain` at startup | Stable afm on macOS 26 — install `afm@0.9.10` (step 1) |
| Server dies, `Empty reply from server`, `MLX error: Failed to load the default metallib` | v0.9.10 packaging bug — add the symlinks (step 2), restart afm |
| `"Apple Intelligence is not enabled"` | OS-level: enable it in System Settings and wait for the model download; also check Siri language support and MDM profiles |
| Server on unexpected port | Requested port busy → afm picked an ephemeral one; free the port or change `--port` and `baseURL` |
| DSH refuses requests / `MISSING_CREDENTIAL` | Keep the dummy `Authorization` header on the route rather than an `apiKeyEnv` naming an unset variable |
| Every reply truncated at 1 token (`finish: max-tokens`) | pi-ai's 4096-token safety reserve + tool-schema estimate zero the budget — declare `contextWindow: 16384` + `maxTokens: 1024` (see "Why contextWindow must lie") |
| Long session suddenly errors mid-conversation | Real 4096 window exhausted by history despite the declared 16384 — start a new session |

## Expectations & future

- ~350 tok/s generation, fully private, but 4K context and a small model:
  fine for chat, weak for agentic work with large system prompts. Local
  LM Studio models remain the workhorses.
- On macOS 27 / Xcode 27: `brew install scouzi1966/afm/afm`, drop the step-2
  symlinks, and consider `afm --gateway`, which aggregates LM Studio / Ollama /
  Jan behind the same endpoint.
- Alternatives if AFM regresses: [Techopolis/afm-Server](https://github.com/Techopolis/afm-Server)
  (menu-bar app), [ZPVIP/apple-to-openai](https://github.com/ZPVIP/apple-to-openai) (Python).
  MCP bridges exist but expose the model as a *tool*, not a picker model — wrong shape.
