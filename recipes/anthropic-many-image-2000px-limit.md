# "many-image requests: 2000 pixels" — Anthropic's >20-image dimension cap vs DSH's pixel-count budget

**Date:** 2026-09-15. **Symptom:** a long DSH session on an Anthropic model
(tensatory `initial-review`, `session-08f15142-022e-4029-a5bb-7d2d8f6656b0`,
`claude-fable-5-1` via `llm-pi-ai`) fails a turn with

```
This turn failed 400 {"type":"error","error":{"type":"invalid_request_error",
"message":"messages.3.content.214.image.source.base64.data: At least one of the
image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}
```

right after the user pasted a **tiny** 144×122 screenshot. Retrying fails the
same way; every later turn in the session fails too (the offending images are
in history and are resent on every request).

## Root cause (two halves)

**Anthropic side.** Above 8000×8000 px an image is always rejected. But once a
single request carries **more than 20 image blocks**, a stricter cap of
**2000 px per dimension applies to every image in that request** — including
images from earlier turns that are resent as history and images nested inside
`tool_result` blocks (screenshots returned by `read_image`, Safari/Chrome
screenshot tools, `wolfram_show`, …). Documented under "Request limits" in
[Anthropic's vision docs](https://platform.claude.com/docs/en/build-with-claude/vision#request-limits).
So the 21st image — however small — flips the whole request into
"many-image" mode and retroactively invalidates any earlier image wider or
taller than 2000 px. The `messages.N.content.M` index in the error points at
one of those *old* images, not at the one just added (pi-ai's Anthropic
converter merges runs of tool results into one user message, hence content
indexes in the hundreds).

**DSH side.** `llm-pi-ai` builds a deterministic "request version" of every
image attachment per request (`packages/llm/llm-pi-ai/src/context.ts`
`prepareRequestImages` → `AttachmentStore.readImageRequest`). The policy is
**pixel-count only**:

- `requestImagePixelBudget` — default `2048*2048 = 4 194 304` px
  (`packages/llm/llm-pi-ai/src/config.ts`, projection math in
  `packages/attachment/attachment/src/request-projection.ts`).
- `requestImageMaxBytes` — default 1 MiB, quality ladder.
- There is **no long-edge cap** at request time (the persisted-normalization
  long-edge cap `DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION` is 8192, irrelevant
  here) and **no awareness of the per-request image count**
  (`RequestImageOffloadPolicy.maxImages` exists in `@deepseek-ai/dsh-llm` but
  the pi-ai adapter only wires `maxBytes`).

Consequences with the default budget:

| Source image | Sent as | Long edge |
|---|---|---|
| 2400×1600 render read via `read_image` (3.84 MP < budget) | passed through untouched | 2400 |
| 2800×1800 Safari screenshot (@2x of a 1400×900 window) | scaled to exactly the budget → 2554×1642 JPEG | 2554 |
| any square image | would come out at 2048 | 2048 |

All three exceed 2000. In the tensatory session 9 of the 21 images were such
oversized screenshots; turn 21 had exactly 20 images (allowed, 8000 px regime),
turn 22 added the 21st.

## How it was diagnosed

Images are not inline in the session log — they are attachment refs that
record `width`/`height`/`originalDimensions`, so the whole picture is visible
from metadata:

```sh
LOG=~/.dsh/sessions/--Users-tali-github-tensatory--/session-08f15142-022e-4029-a5bb-7d2d8f6656b0/session.jsonl.zstd
zstd -dc "$LOG" > /tmp/s.jsonl        # concatenated frames; the CLI handles them
node -e '
const lines=require("fs").readFileSync("/tmp/s.jsonl","utf8").split("\n").filter(Boolean);
for(const l of lines){ if(!l.includes("\"image\"")) continue; let o; try{o=JSON.parse(l)}catch{continue}
  (function walk(v){ if(v&&typeof v==="object"){ if(v.type==="image"&&v.attachment)
    console.log(o.seq,new Date(o.time).toISOString(),o.type,JSON.stringify(v.attachment));
    for(const k in v) walk(v[k]) } })(o) }'
```

Count the `tool/result` + `user/message` image rows (ignore the duplicate
`agent/inbox/spliced` rows — they are the inbox record of the same user
message). If the count is ≥21 and any row has a dimension >2000, this is the
bug. Also check there was no compaction (`grep -c compaction`), otherwise the
resent history is smaller than the log suggests.

## The fix applied (config only, hot-applied)

In `~/.dsh/settings.yaml`, under `llm-pi-ai.providers.anthropic`:

```yaml
    anthropic:
      apiKeyEnv: ANTHROPIC_API_KEY
      requestImagePixelBudget: 1150000
```

Why 1.15 MP:

- Anthropic downsamples server-side to ~1568 px long edge / ~1.15 MP
  (~1600 tokens) *before* tokenizing, and tokens are charged on the
  downsampled size. So the default 4.19 MP budget sent ~4× the bytes the model
  ever saw, for zero quality gain; 1.15 MP loses nothing model-side and
  shrinks payloads/latency.
- 1.15 MP keeps the long edge ≤2000 for any aspect ratio up to ~3.5:1
  (2000×575). Extreme strips (e.g. a 4000×400 crop) could still slip through —
  see "Remaining gap".
- It is per provider, so other pi-ai providers keep the default.

Hot reload: `settings-file` watches the document with chokidar and `llm-pi-ai`
installs its section reactively (`packages/llm/llm-pi-ai/src/index.ts`, the
`installSection` block); the adapter reads `profile.requestImagePixelBudget`
per request (`adapter.ts` where it builds `requestImagePolicy`). No server
restart needed. Note the AGENTS.md warning: edits under `~/.dsh` hit the live
server hosting your own session — the change is benign, but make it
deliberately.

Verify the YAML still parses (there is no `yaml` module on the global node
path; borrow the checkout's):

```sh
cd ~/github/deepseek-harness
Y=$(find node_modules/.pnpm -maxdepth 1 -name 'yaml@*' | head -1)
node --input-type=module -e "import yaml from '$PWD/$Y/node_modules/yaml/dist/index.js'; import fs from 'fs';
const d=yaml.parse(fs.readFileSync(process.env.HOME+'/.dsh/settings.yaml','utf8'));
console.log(d['llm-pi-ai'].providers.anthropic.requestImagePixelBudget)"
```

Then simply retry the failed turn in the affected session: request variants are
cached **keyed by policy** (`requestImageVariantId(ref, policy)` in
`packages/attachment/attachment-local/src/index.ts`), so every existing
attachment is re-projected under the new budget on the next request.

## Prompt-cache implications (why not offload old images instead)

Anthropic's prompt cache is prefix-based: the request must be byte-identical up
to the breakpoint. Anything that changes an early image block invalidates
everything after it.

| Approach | Cache effect |
|---|---|
| Naive "keep newest 20" offload | Every image-adding turn evicts the oldest → prefix changes near the top → **full miss on every screenshot turn**. Never do this. |
| Offload in quanta (`countQuantum`, drop N oldest at once) | One full miss per N new images. This is what `RequestImageOffloadPolicy.countQuantum` / `byteQuantum` are for — a cache-amortization knob. Right shape only for hard ceilings (32 MB request size, hundreds of images). |
| Lower `requestImagePixelBudget` (what we did) | **One** full miss (bytes of the oversized images change), then permanently stable because projection is deterministic per policy. |
| Project ≤2000 px from day one | Zero cache impact. That is the state new sessions are now in. |

Offloading also removes the model's ability to look back at earlier
screenshots, which a review session relies on. So: downscale, don't offload.

## Remaining gap / proper fix

A pixel budget cannot guarantee a long edge for extreme aspect ratios. The
clean fix is a `maxDimension: 2000` in the request-time image policy (the
persisted-normalization pipeline already has `initialDimensions()` doing
budget-then-long-edge in `packages/attachment/attachment-local/src/normalization.ts`;
the request path lacks the second step), or wiring `maxImages: 20` with a
large `countQuantum` into the pi-ai adapter's offload policy as a backstop.
Either is a DSH change or a plugin that wraps the adapter; not done yet.
Workaround for very wide crops meanwhile: crop tighter or use a smaller budget.

## Troubleshooting

| Symptom | Cause / action |
|---|---|
| Error mentions `many-image requests: 2000 pixels`, appeared after adding a small image | The 21st image tripped the regime. Count images in history as above; the fix is the budget, not the new image. |
| Error persists after the settings change | Check the YAML parsed (command above) and that the key is under the right provider (`llm-pi-ai.providers.<route>`); check the server log for `settings-file: reload failed … keeping the last good document`. |
| Same error but images are ≤2000 in the log | Look at `originalDimensions` vs `width`/`height`: the log records the *normalized* size, the request version can differ only downward, so this should not happen — suspect a different provider route with the default budget. |
| Want to confirm what was actually sent | `request/context` events are rare (1 in this log) and do not include image bytes; reason from the attachment metadata and the policy math in `request-projection.ts` (`scale = sqrt(maxPixels / (w*h))`). |
| Very wide strip still rejected | Pixel budget cannot cap the long edge for aspect >3.5:1 at 1.15 MP; crop tighter or implement `maxDimension` (see above). |
