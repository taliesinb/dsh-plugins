# Recipe: adding a just-released Anthropic model before the pi-ai catalog ships it

Reproducible steps to make a newly released Anthropic model (here: **Claude
Fable 5.1**, released 2026-09-01) selectable in the DSH model picker while the
installed `@earendil-works/pi-ai` catalog still lags it. Verified 2026-09-03
against DSH with pi-ai 0.84.2 and the Web GUI.

## How it works (and why the model was missing)

The model selector for a **catalog provider** (`anthropic`, `openai`, …) is
answered from the *installed pi-ai catalog*, never from the network —
`packages/llm/llm-pi-ai/src/discovery.ts` is explicit: a catalog route is
answered "from that catalog, with no network call at all". So a model released
yesterday cannot appear until either:

1. a pi-ai release ships it (checked: 0.84.2 installed *and* latest published
   0.84.4 both top out at `claude-fable-5`), or
2. the deployment declares it in `settings.yaml` — the supported escape hatch;
   `catalog.ts` documents that the route `api` fallback exists precisely so "a
   deployment [can] add a model the installed catalog has not caught up with —
   a provider's newest release".

This recipe uses (2). Resolution order per model entry: configured fields →
installed catalog entry of the same id → route defaults
(`resolveRouteModels` in `packages/llm/llm-pi-ai/src/catalog.ts`).

## 1. Get the real model spec (don't guess)

The Anthropic listing endpoint needs a key in the shell (`ANTHROPIC_API_KEY`
was not in the agent env), but [models.dev](https://models.dev/api.json)
carries the same registry. For `claude-fable-5-1` it reports:

- id `claude-fable-5-1` (dashes, like every Anthropic alias), name "Claude Fable 5.1"
- context 1,000,000 / output 128,000
- input: text, image (+pdf, which DSH's modality set does not model)
- reasoning efforts `low, medium, high, xhigh, max` — **no `off`**: adaptive
  thinking cannot be disabled, same as `claude-fable-5`

Also dump the sibling catalog entry to mirror its compat switches:

```bash
cd <dsh-checkout>/packages/llm/llm-pi-ai && node -e "
import('@earendil-works/pi-ai/providers/all').then(({getBuiltinModels}) =>
  console.log(JSON.stringify(getBuiltinModels('anthropic').find(m=>m.id==='claude-fable-5'),null,2)))"
```

→ `claude-fable-5` carries `compat: { forceAdaptiveThinking: true,
supportsStrictTools: true }` and `thinkingLevelMap: { off: null, xhigh:
"xhigh", max: "max" }` on `anthropic-messages`.

## 2. settings.yaml change

Under `llm-pi-ai.providers.anthropic` in `~/.dsh/settings.yaml`. **Caveat
that shapes the whole edit**: a `models` list *replaces* the served catalog
(`modelOverrides` cannot add ids — it refuses unknown ones). So every shipped
model that should stay in the picker is restated as a bare id; a bare id
inherits its full installed-catalog entry (capacities, reasoning map, compat)
via the `...base` spread in `resolveRouteModels`.

```yaml
llm-pi-ai:
  providers:
    anthropic:
      apiKeyEnv: ANTHROPIC_API_KEY
      models:
        - id: claude-fable-5-1
          name: Claude Fable 5.1
          contextWindow: 1000000
          maxTokens: 128000
          input: [text, image]
          # Adaptive thinking like fable-5: no "off" level, efforts low..max.
          reasoningEfforts:
            low: low
            medium: medium
            high: high
            xhigh: xhigh
            max: max
          compat:
            forceAdaptiveThinking: true
            supportsStrictTools: true
        - id: claude-fable-5            # bare ids inherit the installed
        - id: claude-haiku-4-5          # catalog entries unchanged
        - id: claude-haiku-4-5-20251001
        - id: claude-opus-4-5
        - id: claude-opus-4-5-20251101
        - id: claude-opus-4-6
        - id: claude-opus-4-7
        - id: claude-opus-4-8
        - id: claude-opus-5
        - id: claude-sonnet-4-5
        - id: claude-sonnet-4-5-20250929
        - id: claude-sonnet-4-6
        - id: claude-sonnet-5
```

No restart: the settings file provider watches the document and llm-pi-ai
re-registers the route live; reopen the model picker (refresh if needed).

### Field semantics worth knowing

- **`api`/`baseURL` are omitted deliberately.** The unknown id resolves its
  protocol through `sharedCatalogApi` — every shipped anthropic model speaks
  `anthropic-messages`, so the new entry adopts it — and the endpoint comes
  from the catalog provider (`https://api.anthropic.com`).
- **`reasoningEfforts` pins undeclared levels to unsupported.** DSH translates
  the dict to a full `thinkingLevelMap` with every undeclared level explicitly
  `null`, because pi-ai's own defaulting is asymmetric (absent = supported for
  the five base levels, unsupported for `xhigh`/`max`). Omitting `off` is what
  encodes "adaptive thinking, cannot be turned off" — do **not** write
  `off:` with no value (that means "supported, send nothing") and an empty
  `reasoningEfforts:` is refused outright.
- **Configuring `maxTokens` also makes it the per-request default cap** (a
  catalog-inherited value never does). Here 128000 equals the capability, so
  it is harmless — but don't reflexively copy capacities onto bare-id entries,
  or you turn capabilities into request defaults.
- **`compat` keys are gated.** Only fields the `anthropic-messages` gate
  offers may be set (`forceAdaptiveThinking`, `supportsStrictTools`, etc.);
  anything else fails route resolution loudly, naming the key.
- **Cost shows as zero** for a hand-declared model (`NO_COST`); DSH never
  reads pi-ai cost metadata, so nothing is lost.

## 3. Verify through DSH's own resolution path

Don't trust the YAML by eye — run it through the exact function the selector
uses (Node 26 strips types natively):

```bash
cd <dsh-checkout>/packages/llm/llm-pi-ai && node --experimental-strip-types -e "
const { resolveRouteModels } = await import('./src/catalog.ts')
const { load } = await import('js-yaml')
const { readFileSync } = await import('node:fs')
const settings = load(readFileSync(process.env.HOME + '/.dsh/settings.yaml','utf8'))
const { models } = resolveRouteModels({
  provider: 'anthropic',
  models: settings['llm-pi-ai'].providers.anthropic.models,
  defaultContextWindow: 128000, defaultMaxTokens: 8192, defaultInput: ['text'],
})
console.log(models.length, 'models')
console.log(JSON.stringify(models.find(m => m.id === 'claude-fable-5-1'), null, 1))"
```

Checked on 2026-09-03: 14 models resolve; `claude-fable-5-1` materializes with
`api: anthropic-messages`, `baseUrl: https://api.anthropic.com`, the full
pinned `thinkingLevelMap`, and the fable-5 compat block; the bare-id
`claude-fable-5` still inherits its catalog `thinkingLevelMap`/compat intact.
(`import('yaml')` is not resolvable from that package — use `js-yaml`.)

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| New model absent from the picker after a provider "refresh" | Expected — discovery answers catalog routes from the installed catalog; only `settings.yaml` (or a pi-ai upgrade) changes the list |
| Route fails: `model "…" needs an api` | The route's shipped models don't share one protocol (not the case for anthropic) or the id is on a non-catalog route — set `api` on the route |
| Route fails: `modelOverrides names "…", which the installed catalog does not describe` | `modelOverrides` customizes existing ids only; a *new* id needs the `models` list |
| Other Anthropic models vanished from the picker | The `models` list replaced the catalog — restate them as bare ids (step 2) |
| Route fails: `empty reasoningEfforts` / `needs the wire value` | Empty dict or valueless level; declare levels with wire spellings, only `off` may be valueless |
| Requests send a thinking level the API rejects | Wire spellings wrong — mirror the provider's published effort values, not DSH level names |

## Cleanup / future

- The block is temporary scaffolding: once a pi-ai release ships
  `claude-fable-5-1` **and DSH's checkout upgrades past `^0.84.2`**, delete the
  entire `models` list to return to serving the installed catalog unchanged
  (the catalog entry will also carry real cost/compat data).
- Watch for drift while the override lives: if Anthropic revises limits or
  effort levels, models.dev is the quickest registry to re-check.
- `agent-default-model` in the same file still points at `claude-fable-5`;
  switch it to `claude-fable-5-1` to make new sessions default to it.
- Same recipe applies to any catalog provider (OpenAI, etc.) — only the
  restated id list and the compat gate fields differ per protocol.
