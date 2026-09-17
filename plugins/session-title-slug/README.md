# tali-session-title-slug

Name a DSH session **when you create it**: start the first prompt of a New
Session with a slug and a colon —

```
foo-bar-baz: rename the widget and add tests
```

— and the session is titled `foo-bar-baz`. While you type, the selected
**New Session** row in the sidebar previews the slug live; if the prefix
stops matching, the row goes back to "New Session". The prompt is sent to the
model **unchanged** (the slug is a useful hint about the task).

**Ghost rows.** Select another session and the typed-into New Session does
not vanish: a dimmed row (the slug, or "New Session") stays under its
workspace header; click it to return to the draft. A New Session with an
empty draft leaves no ghost.

## Slug grammar

`^\s*([a-z0-9][a-z0-9_-]*):(?=\s|$)` — lowercase ASCII letters, digits, `-`,
`_`; the colon must be followed by whitespace or end the text.

| Text | Title |
|---|---|
| `foo-bar-baz: do it` | `foo-bar-baz` |
| `fix_login2: the form…` | `fix_login2` |
| `Note: something` | — (capitalized prose never matches) |
| `http://example.com` | — (colon not followed by whitespace) |
| `foo:bar` | — |

The slug is used verbatim as the title (no humanizing). Only the **first**
prompt of a **blank** session is considered; later prompts never rename.

## How it works

Browser-only client plugin (`index.js` host half just logs).

1. **Observe.** An invisible entry in the session-scoped list slot
   `conversation.input.dock` (rendered above the composer, including the
   blank-session hero layout) reads the standard props
   `useInput(s => s.draft)`, `useSession(s => s.blank)` and
   `useSession(s => s.pendingSubmissions)`.
2. **Preview.** While the session is blank and the draft starts with a slug,
   the plugin rewrites the text of the selected sidebar row's title span. The
   row renders `blank ? t('session.new') : title` and the host keeps `blank`
   until the first `turn/start`, so no store/rename can change that label; the
   browser occupies a `single` slot and locale namespaces have one owner, so
   the DOM is the only seam. Selector: `[role="treeitem"][aria-selected="true"]
   > span[class$="_title"]` on rows with no `_time` sibling (blank rows omit
   the time cell). The original label is kept in `data-tdsn-orig`; restore
   only happens if the span still shows exactly what we wrote, so the real
   title React writes after acceptance is never clobbered. A
   `MutationObserver` re-applies after remounts.
3. **Rename.** Ordinary sends clear the draft synchronously and never leave
   the input's `plain` phase, so the draft cannot be read at send time.
   Instead the plugin reads the **submission echo** (`pendingSubmissions[].text`
   is the exact prompt text) to *arm* a slug, and fires
   `sessions.binding(id).session.rename(slug)` when `blank` flips to false —
   which the Session Controller does locally on the prompt RPC's success.
   A rejected prompt therefore never pins a title on a still-blank session.
   `rename` records a `user`-source `session/title` event, which supersedes
   the in-flight automatic (LLM) title and stops later automatic retitling.

4. **Ghost rows** (`ghosts.ts`). The browser lists a blank session only
   while it is current (`tree.ts`), but the session survives on the host (New
   Session reuses it) and its draft is persisted per session by
   ui-conversation's store (`localStorage['dsh.conversation.<id>'].draft`).
   The plugin subscribes to `sessions.list` + `workspaces.list`; for every
   blank, non-current session with a non-empty persisted draft it inserts a
   `cloneNode` of a real session row (selection/drag/menu artefacts
   stripped, `opacity: .5`) inside a shallow clone of the row's HoverCard
   wrapper (the group section spaces *wrappers*, so a bare row would sit
   2px too high and shift every row below it), inserted right after the
   workspace header's wrapper and marked `data-tdsn-ghost`; labelled with
   the draft's slug or the sidebar's own localized "New Session" text.
   Wrappers are detected structurally (the element holding exactly that one
   row) because ui-primitives hashes its classes `_root_<hash>_<n>`, not
   `[hash]_[local]`. Click/Enter → `sessions.open(id)`; the
   real blank row then renders and the ghost is reconciled away. Headers are
   matched by title text (rows carry no ids); only the grouped list is
   handled. Survives reloads, since both the session and the draft persist.

## Dev

```sh
pnpm install        # links the checkout packages for type-checking
pnpm build          # lib/client.js (esbuild; only `react` stays external)
pnpm typecheck
pnpm test           # slug grammar (node:test, type-stripped)
pnpm watch          # rebuild on save; a running dsh web hot-swaps the bundle
```

Preview safely on an isolated server (see `../../PREVIEWING.md`); the plugin
is a row in `../../cordis.dev.yml`. When the picker would open a native
macOS folder dialog you cannot see, set `SSH_TTY=/dev/preview` on the preview
server: `directory-picker-auto` then resolves to the in-browser browse backend.

Install into a profile: `dsh plugin --profile web add ./plugins/session-title-slug`.

## Verified (2026-09-16)

Isolated preview home, workspace `/tmp/tdsn-scratch`:

- typing `slug-preview-test: ` → row reads `slug-preview-test`; prefixing
  `Hello ` → row back to `New Session`.
- sending `naming-test: reply with…` → the session log holds exactly one
  `session/title` (`source.kind: "user"`, `naming-test`); no automatic
  retitle followed.
- sending `Note: reply with…` in a fresh New Session → no user title; the
  built-in `fallback` and the LLM `provider` titles arrived as usual.
- ghosts: `ghost-check: …` draft + select another session → dimmed
  `ghost-check` row under the header; clicking it restores the draft and the
  real row; clearing the draft and leaving → no ghost; a plain draft → dimmed
  `New Session` ghost.

## Host half (2026-09-17)

`index.js` is no longer a no-op: on the first human prompt of a session it
parses the same `slug: ` grammar and calls `ctx.sessionTitle.rename(session,
slug)` right away. That writes a `user`-source title, which the title service
treats as pinned — the pending automatic (LLM) generation is superseded, so no
model is asked to summarize a prompt the user already named. It runs on the
host, so it also covers clients that do not load this browser half (a remote
shell framing one of this host's sessions). The browser half keeps the live
preview in the New Session row; its later rename is a same-text no-op.

Pair with `style: slug` on the `session-title-llm` row of the fork so
unslugged prompts get `foo-bar-baz` titles too.

## Convention global

The browser half publishes `globalThis.__DSH_SESSION_TITLE_SLUG__ =
{ parseSlug }` while loaded. Other browser plugins that render their own New
Session rows (dsh-remote-workspaces' framed remote sessions) use it to show
the same live slug preview without a build-time dependency, and show nothing
when this plugin is absent.
