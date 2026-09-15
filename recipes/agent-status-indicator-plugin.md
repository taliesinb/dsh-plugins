# Agent status indicator plugin (+ doc-type icon pipeline)

**What exists:** a browser-side DSH plugin showing a floating, animated stack of
status icons in the chat area's bottom-right — 🙂 waiting, 🤨 thinking, 😶 error,
✋-badged when blocked on approval/question, per-tool icons while tools run
(pi-web emoji rules; terminal SVG for bash), and for file operations the
*document-type icon* full-size (TS square, python glyph, pdf trefoil …) with an
activity decoration bottom-right: ✏️ edit, ➕ write, 👁️ read, ▶️ script run
(parsed out of bash command lines: `python x.py`, `uv run …`, `npx tsx …`, etc.).

**Code:** `~/github/tali-dash-plugins/plugins/agent-status-indicator/` (local
git repo, `main`). Read that repo's `AGENTS.md` first; preview workflow in its
`PREVIEWING.md`. Key files: `src/client/index.tsx` (indicator + detection
logic), `src/client/toolIcons.ts` (pi-web rule engine), `src/client/docTypes.ts`
(document-type registry: brand/badge/deco/decoBg/tint fields per type),
`src/client/finalBadges.ts` (GENERATED — svg strings + ext map),
`scripts/gen-*.mjs|py` (icon pipeline + review galleries in `gallery/`).

## Reproduce / develop

```sh
cd ~/github/tali-dash-plugins/plugins/agent-status-indicator
pnpm install && pnpm build        # esbuild -> lib/client.js (wrapped CJS)
pnpm typecheck                    # tsc against link: deps into the checkout
# preview (never touch ~/.dsh — see PREVIEWING.md):
cd ~/github/deepseek-harness && DSH_HOME=/tmp/tali-dash-plugins-home \
  pnpm dsh web --patch ~/github/tali-dash-plugins/cordis.dev.yml --port 3081 --no-open
# open the TOKENED url from stdout; bare :3081 answers 401
```

Regenerating icons: `python3 scripts/gen-custom-decos.py` (extracted/derived
SVGs) → `node scripts/gen-final-badges.mjs` (final set + `finalBadges.ts`) →
`node scripts/gen-doc-icon-gallery.mjs` / `gen-icon-gallery.mjs` (review HTML).

## How it hooks DSH (client side)

- Slot: contributes to `conversation.input.dock` (list, session scope) via
  `ctx.slots.inject(...)`; positioning is `position:fixed` CSS, injected as a
  `ctx.effect` style tag (no CSS build pipeline out-of-tree).
- State: `useSession` (`running`, `lastAgentError`), global
  `useSessionPendingInteraction` (blocked), `useChat` →
  `chat.legacy.runningCalls[]` (`RunningToolCall.name` + `argsRaw` JSON string —
  same payload as durable `tool/call` events). Selectors return one primitive
  string so streaming frames don't re-render.
- Bundle contract: CJS wrapped in `window.__ModuleLoader__.load({id, factory})`,
  platform modules external (see `packages/client/web/src/platform.ts`);
  `build.mjs` replicates the in-tree `tsdown.client.ts` preset with esbuild.

## Icon pipeline decisions

- Registry (`docTypes.ts`): per type `brand` (reference logo), `badge` (framed,
  used as-is), `deco` (unframed glyph) + `decoBg`/`decoTint`; final rule =
  badge → else deco on decoBg box (tight 84%, radius 10) → else bare deco.
- Assets: tali's pi-web `lang-*.svg` + devicon (MIT) + material-icon-theme
  (MIT); provenance in `src/client/icons/README.md`. Several glyphs (TS, CSS
  letters, pdf trefoil, img mountain+sun) exist only as *negative space* in
  their source icons — recovered via SVG mask subtraction; recipes + measured
  transforms live in `gen-custom-decos.py`.

## Failure modes hit (so you don't)

| Symptom | Cause / fix |
|---|---|
| Tinted/masked icons render invisible | `url("data:…")` inside a double-quoted `style` attr terminates it — use single quotes + escape `'` (encodeURIComponent leaves apostrophes) |
| Wrong mask/gradient applies when several SVGs inlined in one HTML | ids (`m`, `a`) are document-global — namespace ids per file/type |
| Glyph top/edge flattened | mask base rect clipped real artwork bbox (pdf trefoil top y=7.31 vs rect y=8); measure rendered bbox (qlmanage + PIL) before fitting |
| `viewBox` parse fails on material-symbols icons | some use `0 -960 960 960` (negative origin) — parse all four numbers |
| Text badges clip / mis-align vs devicon JS/TS | devicon boxes are inset 1.5px, glyph margins 10/10; WebKit adds letter-spacing after the last glyph before an end-anchor — compensate x |
| Preview server 401 | must use tokened URL from stdout; cookie jar for curl checks |
| web_search tool fails in preview | not a preview bug: no `DEEPSEEK_API_KEY` in the real setup either; only `ANTHROPIC_API_KEY` is stored |
| Plugin missing from boot graph | check terminal for activation AggregateError; bundle must exist at boot (`pnpm build` first) |

Credentials forwarding to the preview home: copy `~/.dsh/.credentials.yaml` +
`~/.dsh/settings.yaml` into `/tmp/tali-dash-plugins-home/` (snapshots, not links).

## Not done / next steps

- Plugin is loaded only via the dev overlay (`cordis.dev.yml`), not installed
  into the live web profile (deliberate — see PREVIEWING.md warning tiers).
- ➕ (write) glyph is the heavy emoji plus; may want a custom mark.
- `sql→mysql` devicon mapping declined (different brand); xml badge text color
  and js/ts `decoBg` (taken from artwork: `#f0db4f`/`#007acc`) differ subtly
  from pill colors (`#f7df1e`/`#3178c6`) — intentional.
