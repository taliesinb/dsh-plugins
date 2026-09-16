# Recipe: name a New Session from its first prompt (`session-title-slug` plugin)

**Goal (Tali, 2026-09-16):** provide a session name at *creation* time by
starting the first prompt with `some-slug: `; the sidebar's selected "New
Session" row should live-update to the slug while typing and revert when the
prefix stops matching; the real session gets the title once it is actually
spawned; the prompt text is *not* stripped (the slug is a good hint for the
model). Light touch, out-of-tree.

Plugin: `~/github/tali-dash-plugins/plugins/session-title-slug/` (README owns
the grammar and mechanics; this recipe owns the system-level story and the
survey that shaped it).

## Survey: where a title can come from, and why the row cannot be told

Checked against the source checkout `~/github/deepseek-harness`
(branch `fix/tailscale-mounting`, 2026-09-16):

| Fact | Where |
|---|---|
| A New Session is a **real provisional session** (`blank: true`) that already exists on the host; only the *current* blank one is listed. | `packages/client/ui-workspace/src/client/tree.ts` |
| The row label is `node.blank ? t('session.new') : node.title` — a locale constant while blank. | `ui-workspace/src/client/rows/Rows.tsx` `displayTitle` |
| Host clears `blank` only on `turn/start`: `blank = state.blank && event.type !== 'turn/start'`. Renaming a blank session does **not** flip it. | `packages/api/session-controller/src/list.ts` |
| Client flips `blank` locally on the prompt RPC's **success** ("local first-send flip"). | `session-controller/src/client/sessions/manager.ts` |
| `ISession.rename(title)` exists on the browser Session face (`sessions.binding(id).session`), same verb the sidebar Rename menu uses; it appends a `session/title` event with `source.kind: 'user'`, which supersedes in-flight automatic titling and stops later automatic retitles. | `session-controller/src/client/contract/session.ts`, `docs/subsystems/session-title.md` |
| `sidebar.workspaces` is a `single` slot (the whole browser); no per-row slot exists. | `docs/subsystems/slots.md` |
| Locale namespaces have exactly one owner: re-registering `workspace` throws `already has locale`. | `packages/client/locale/src/client/index.ts` |
| Session-scoped slots receive `useInput` (live draft, `InputState.draft`) and `useSession`. | `ui-conversation/src/client/contract/slots.ts` |
| Ordinary sends stay in input phase `plain` and commit (clear) the draft synchronously — phase is useless as a send trigger. | `ui-conversation/src/client/input/machine.ts` `beginDetached` |
| `SessionSnapshot.pendingSubmissions[].text` is "prompt text exactly as it will be sent". | `session-controller/src/client/contract/snapshot.ts` |
| CSS-module classes are built `[hash]_[local]`, so `[class$="_title"]` is a stable selector. | `packages/client/tsdown.client.ts` |

Consequences:

- **No fork of DSH needed.** Everything is reachable from a client plugin:
  the draft via slot standard props, the rename via the Sessions service.
- **The live row preview must be a DOM patch.** Nothing in the data model can
  change a blank row's label. This is the same class of seam
  `settings-shortcut` uses (hashed-suffix class selectors).
- **Do not rename the blank session while typing.** It would not show (blank
  rows ignore `title`), an empty title is invalid so it could never be undone,
  and a pinned `user` title would suppress automatic titling for a session
  that ends up sent without a slug.
- **Rename after acceptance, from the echo.** Arm the slug from the
  submission echo's exact text; fire when `blank` flips false. A rejected
  prompt leaves no title behind.

## Follow-up (same day): ghost rows for typed-into New Sessions

Tali: selecting another session made the phantom New Session disappear;
wanted it to stay, dimmed (slug or "New Session"), unless nothing was typed.
Facts that made this plugin-only:

| Fact | Where |
|---|---|
| The blank session persists on the host and is reused by New Session; only the *listing* filters non-current blanks. | `ui-workspace/src/client/tree.ts` |
| The composer draft is persisted per session: `defineStore({ persist: 'dsh.conversation' })` → `localStorage['dsh.conversation.<sessionId>']` = `JSON.stringify({draft, view, viewRequest})` (plain, no zustand envelope). | `ui-conversation/src/client/stores.ts`, `packages/client/store/src/index.ts` `attachPersistence` |
| `ISessions.list` (`{ids, byId, current}`) and `IWorkspaces.list` (`items[]: {workspaceId, title, path, sessionIds}`) are observable services a client plugin can `ctx.get`. | `session-controller/src/client/sessions/service.ts`, `workspace-controller/src/types.ts` |
| `ISessions.open(id)` selects any listed session, blank included. | `session-controller/src/client/contract/sessions.ts` |
| Each row (header and session) is wrapped in HoverCard's block `div[class$="_root"]`; the insertion anchor is that wrapper, not the `treeitem`. | `ui-primitives/src/HoverCard.tsx` |

Implementation: `plugins/session-title-slug/src/client/ghosts.ts` (see the
README's "Ghost rows"). Verified on the preview: ghost appears/returns/
clears; plain draft ghosts as "New Session".

## Rejected alternatives

- Overriding `workspace.session.new` in the locale service — throws.
- Replacing `sidebar.workspaces` with a wrapped copy of WorkspaceBrowser —
  cross-plugin runtime imports of `@deepseek-ai/*` client packages are
  forbidden in bundles; a re-implementation for one label is disproportionate.
- Reading the draft at send time via `phase === 'submitting'` — never happens
  for ordinary sends (only slash-commands adjudicate/submit).
- Renaming on the echo (before acceptance) — pins a title if the prompt fails.
- A host plugin using `ctx.sessionTitle.rename` on the first `user/message` —
  would work for the rename but cannot see the composer, so no live preview,
  and it would have to re-parse the message; the client side has both.

## Build / test / preview

```sh
cd ~/github/tali-dash-plugins/plugins/session-title-slug
pnpm install && pnpm build && pnpm typecheck && pnpm test
```

Isolated preview (PREVIEWING.md), with the browse-mode picker so no native
macOS dialog appears on the user's screen:

```sh
mkdir -p /tmp/tali-dash-plugins-home /tmp/tdsn-scratch
cp ~/.dsh/.credentials.yaml ~/.dsh/settings.yaml /tmp/tali-dash-plugins-home/
cd ~/github/deepseek-harness
SSH_TTY=/dev/preview DSH_HOME=/tmp/tali-dash-plugins-home \
  pnpm dsh web --patch ~/github/tali-dash-plugins/cordis.dev.yml --port 3084 --no-open
```

Then, in the tokened URL: Add workspace → "Edit path" → `/tmp/tdsn-scratch`
→ Open; type `foo-bar: ` and read the selected row's title span; send; then
check the log:

```sh
zstd -dc /tmp/tali-dash-plugins-home/sessions/*/session-*/session.v3.jsonl.zstd \
  | grep -o '"type":"session/title".\{0,160\}'
```

Expect one event with `"source":{"kind":"user"}` and the slug.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `listen EADDRINUSE 127.0.0.1:3081` | Another preview (here: a `deepseek-harness-embed` checkout on 3081/3082) — pick a free port; do not kill unknown servers. |
| Clicking **Add workspace** opens a native macOS folder dialog the agent cannot see (an `osascript … choose folder` process) | `directory-picker-auto` picks `native` on darwin with a loopback bind. `kill` the osascript pid, restart with `SSH_TTY=<anything>` (SSH launch fact ⇒ `browse`). |
| Row never previews | The dock entry only renders with a session snapshot; check `window.__DSH_BOOT__` contains `tali-session-title-slug` and the row is `[aria-selected="true"]` with no `_time` span. |
| Title not applied after send | The rename fires on `blank` → false; a rejected prompt (`promptError`) leaves it armed for the next accepted one. Check the browser console for `session-title-slug: rename failed`. |
| Typecheck: `SessionId` not exported from `…/client` | It lives in `@deepseek-ai/dsh-session/types`; the plugin derives it as `Parameters<ISessions['binding']>[0]` instead of adding a link. |

## Status

- Built, typechecked, unit-tested; verified end to end on the isolated
  preview (both the slug and the no-slug paths). Row added to
  `cordis.dev.yml` (dev overlay). **Not** installed into the live `web`
  profile — that is a boot-time change to the user's DSH; do it only on
  request: `dsh plugin --profile web add ./plugins/session-title-slug`.
