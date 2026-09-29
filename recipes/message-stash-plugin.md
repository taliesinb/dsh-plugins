# A stash for composer messages (`message-stash` plugin)

2026-09-29. `plugins/message-stash` — a git-stash for the text in the web
GUI composer: **Ctrl+S** pushes the draft, **Ctrl+S, S** opens the stash
view, **Ctrl+R** cycles stashed messages through the composer, and a cycled
message is popped only when it is actually sent. Browser half only, no
config, stash in localStorage. The plugin README owns the behaviour and the
code layout; this recipe owns the seams it was built on, the design
decisions, the trial procedure and what failed.

## 1. The seams (all shipped by ui-conversation; nothing patched)

| Need | Seam | Where verified |
|---|---|---|
| Read the live composer text | `useInput(s => s.draft)` on any session-scoped slot component — the editor's *clipboard projection* (chips expanded; the last paragraph ends with `"\n"`, stripped on push) | `packages/client/ui-conversation/src/client/contract/input.ts` (`InputState`) |
| Write the composer text | `inputActions.setDraft(text)` (standard session prop; `InputActions` in the same file). Refused while `phase !== 'plain'` (a claimed slash command) — the controller reports `busy` | phone-ui's `MobileComposer` uses the same pair |
| Know a message was **sent** | `useSession(s => s.pendingSubmissions)` — the local submission echo (`requestId`, exact `text`). An ordinary send clears the draft synchronously (`commit-draft` runs in the same `run()` as `default-sink`, `input/facade.ts`), so the draft cannot be read "at send time"; the echo is the signal. Same trick as `session-title-slug` | `packages/api/session-controller/src/client/contract/snapshot.ts` (`PendingSubmission`) |
| A per-session mount point that exists exactly for the session being typed into | `conversation.input.dock` (list, scope `session`); the watcher renders only a hidden `<span data-tali-stash-session>` marker | `contract/slots.ts` |
| A control in the composer tool row | `conversation.input.right` (list, scope `session`) — rendered inside `.trailing` before the model picker; styled like the shell's `.add` button (28px capsule, `--dsw-specific-selector`) | `skeleton/InputBar.tsx:440` |
| A modal | `shell.overlay` (list) + the shipped `Modal`/`Button` from `ui-primitives`, as reboot-command does | `ui-layout/src/client/AppFrame.tsx` |
| A user setting | `settings.general.item` (list, root; typed in `@deepseek-ai/dsh-client-ui-settings`), one row after the shipped "Send behavior while busy"; state in a `createSnapshotStore(…, { persist: { name } })` bound as `useSettings` through the inject `hooks` compartment, written through an injected callback | `ui-conversation/settings/EnterBehaviorRow.tsx`, `ui-settings/src/client/contract/slots.ts` |
| Is focus in the composer? | the editor's unhashed `data-composer-input` attribute | `input/editor/ComposerContentEditable.tsx:46` |

The chord listener is one capture-phase `keydown` on `window` (same pattern
as `settings-shortcut`), so Lexical never sees Ctrl+S / Ctrl+R.
`preventDefault` also suppresses the browser's Save/Reload on non-Apple
platforms (Chrome honours it for both).

## 2. Decisions

- **Checkout, not pop.** "Only actually popping if sent" means the entry
  stays in the list with a `checkout: { entryId, sessionId }` mark. Three
  exits: a submission echo in that session pops it; Ctrl+R / Ctrl+S write the
  composer's edits back into it; the draft going blank *by hand* releases it
  unchanged. The last one needs care: the draft is also blank for a moment
  right after `setDraft(text)` (before the editor adopted it) and right after
  a send (before/with the echo). Hence `seenText` (a blank only counts after a
  non-blank was observed for that checkout) and a 2 s grace window in which
  an echo still pops the just-released entry.
- **Ring order.** Top = most recent push. Ctrl+R takes the top and sends the
  composer's content to the *bottom*, so N presses over N entries come back
  around. A stashed draft that was never in the stash is parked at the bottom
  too — Ctrl+R never discards text.
- **Ctrl+S, S opens the view *after* the first tap pushed.** A single Ctrl+S
  must act immediately (no wait for a possible second tap), so with text in
  the composer the first tap pushes and the second opens the view showing it
  on top. The detector is a window on `event.timeStamp` (default 1 s; the
  first 600 ms was too tight for a human double tap), reset by any
  non-modifier key.
- **Which session?** One `conversation.input.dock` instance is mounted per
  displayed session (normally one). The controller keeps a registration per
  session; the chord targets the one whose dock marker shares the deepest
  ancestor with the focused `[data-composer-input]`, else the most recently
  registered.
- **localStorage, not the host.** One stash per browser profile
  (`tali.message-stash.v1`, `{version, entries, checkout}`), cross-tab via
  the `storage` event. A host-side store would follow the user across the
  Dock app / phone / remote — deferred until wanted; the model is pure and
  the codec is one function, so the backend can change.
- **No copy in the UI beyond labels.** Title "Stash", rows (text, age, origin,
  "in composer"), ×, Clear → "Clear all?", Close, "Empty".

## 3. Trial in a throwaway home (what worked, 2026-09-29)

The worktree kept the plugin out of the main checkout, so the standing
preview's overlay was not touched; an ad-hoc server did the job:

```sh
mkdir -p /tmp/tali-stash-trial/scratch
cat > /tmp/tali-stash-trial/overlay.yml <<'EOF'
- insert:
    - id: tali-message-stash
      name: /Users/USER/github/tali-dash-plugins/.worktrees/message-stash/plugins/message-stash/index.js
EOF
cd <dsh-src>
SSH_TTY=/dev/trial DSH_HOME=/tmp/tali-stash-trial/home \
  node --import tsx/esm apps/cli/src/bin.ts --profile web \
  --patch /tmp/tali-stash-trial/overlay.yml --port 3091 --no-open
```

Open the printed `?token=` URL (Chrome via `browser-automation`), dismiss the
notice, "Configure later" on the API-key dialog, **Add workspace → Edit path →
`/tmp/tali-stash-trial/scratch` → Open**, click the workspace row: a live
composer. Then, driving keys and reading `localStorage['tali.message-stash.v1']`
+ `[data-composer-input]` after each step:

1. type, Ctrl+S → composer empty, one entry, "Stash (1)" button appears;
2. type, Ctrl+S, Ctrl+R → top entry in the composer, `checkout` set, page
   not reloaded;
3. append " (edited)", Ctrl+R → the edit written back, that entry moved to the
   bottom, the other entry in the composer;
4. ⌘A, ⌫ → checkout released, both entries kept;
5. Ctrl+R, Enter → the entry popped (the send echoes locally even though the
   turn fails with `MISSING_CREDENTIAL`), text in the transcript;
6. Ctrl+S twice within the window → the view; Enter restores into the
   composer and focus returns to it; the tool-row button opens it too;
   Delete removes the selected entry; Escape closes. No console warnings.

## 4. What failed / traps

| Symptom | Cause / fix |
|---|---|
| `pnpm dsh …` from the checkout: `create the temporary package manager install directory — Operation not permitted` | pnpm 12's `packageManager` temp dir under the sandbox. Launch the CLI source directly: `node --import tsx/esm apps/cli/src/bin.ts --profile web --patch … --port … --no-open` (as `recipes/chat-title-plugin.md` records). |
| "Choose workspace" does nothing visible; an `osascript … choose folder` process appears | The native picker. `pkill -f "choose folder"`, restart with `SSH_TTY=<anything>` so the in-browser picker is used (`recipes/session-title-slug-plugin.md`). |
| `node --experimental-strip-types --test`: `TypeScript parameter property is not supported in strip-only mode` | Node 26 strips types only; no `constructor(private readonly x)` in modules the tests import — plain fields. |
| Ctrl+S, S did not open the view when the two taps were separate tool calls | Real round trips exceed the window; send both `keyPress` steps in one `chrome_interact` batch (400 ms settle) — or a human simply taps twice. |
| Typing after clicking the composer's placeholder text went nowhere (Chrome trial) | The click hit the placeholder overlay; click the `[role=textbox]` (snapshot uid) instead. |
| Ctrl+A in the composer moved the caret instead of selecting | macOS emacs binding in Chrome; ⌘A selects. Irrelevant to the plugin, relevant to driving the trial. |
| The worktree's `deepseek-harness/` submodule is empty | `git worktree add` leaves submodules unpopulated; the plugins' `link:` deps need the checkout at `../../deepseek-harness`. The sibling `message-branches` worktree symlinks it to the main checkout (`ln -s ../../deepseek-harness deepseek-harness`, an uncommitted typechange) — same here. |

## 5. Not done

- Host-side persistence (one stash across the Dock app, phone and remote).
- Stashing attachments (only text is stashed; attachments stay in the
  composer).
- Live install: the row is in `cordis.dev.yml` for the preview; adding it to
  `tools/install-plugins.sh`'s live set is the maintainer's call.
