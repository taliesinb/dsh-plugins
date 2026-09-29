# tali-message-stash

A `git stash` for messages you are writing in the DSH web GUI composer.
Browser half only; the stash lives in the browser's localStorage and is
shared by every session of that browser profile.

| Chord | What happens |
|---|---|
| **Ctrl+S** | Push the composer text onto the stash; the composer clears. |
| **Ctrl+S, S** | (a second Ctrl+S within 600 ms) Open the stash view. |
| **Ctrl+R** | Cycle: the top stashed message replaces the composer text; whatever was in the composer goes to the bottom of the stash. Repeated Ctrl+R walks the whole stash as a ring. |

Literal Ctrl on every platform (⌘S / ⌘R stay the browser's). The chords act
from the composer and from anywhere that is not a text field; another input,
textarea or editable region keeps its own Ctrl+S / Ctrl+R.

## Pop only on send

A message brought into the composer by Ctrl+R (or by **Restore** in the view)
is *checked out*: it stays in the stash until it is actually sent.

- **Send it** (edited or not) → it is popped.
- **Ctrl+R again** → your edits are written back into that entry, it moves to
  the bottom, and the next entry comes up.
- **Ctrl+S** → the entry is updated with your edits and moved to the top; the
  composer clears.
- **Clear the composer by hand** → the checkout ends; the entry stays as it
  was.

Ctrl+R with unstashed text in the composer parks that text at the bottom of
the stash before bringing the top entry in, so nothing typed is ever lost.
Ctrl+R on an empty stash does nothing.

## The view (Ctrl+S, S)

Newest first. Each row: the text (clipped to four lines), how long ago it was
stashed or last edited, the session it came from, and "in composer" for the
checked-out entry. Hover or ↑/↓ selects; **Enter** or a click restores the
entry into the composer of the session the view was opened from; **⌫ /
Delete** or the row's × deletes it; **Clear** (pressed twice) empties the
stash; **Escape** closes.

A count button appears in the composer tool row (left of the model picker)
while the stash is non-empty; clicking it opens the view.

## What is stashed

The composer's clipboard projection: plain text with reference chips in
their clipboard form. Attachments are not stashed and stay in the composer.

## Layout

- `src/client/stash.ts` — the pure model (ordered entries + one checkout;
  `push`, `cycle`, `restore`, `pop`, `release`; the localStorage codec).
  Unit-tested in `test/stash.test.ts`.
- `src/client/keys.ts` — chord recognition, the double-tap detector, the
  focus rule. `test/keys.test.ts`.
- `src/client/controller.ts` — persistence, the per-session composer
  registrations, the "was it sent?" observation, the view's open state.
- `src/client/index.tsx` — the Cordis `apply`: one capture-phase `keydown`
  listener on `window`; a hidden per-session watcher in
  `conversation.input.dock` (reports the live draft, the input phase and
  every local submission echo — `pendingSubmissions` — which is how a send is
  detected, since a send clears the draft synchronously); the count button in
  `conversation.input.right`; the view in `shell.overlay`.
- `index.js` — host half; empty `apply` (the package must exist on the Node
  side for the Loader row to resolve and the bundle to be served).

## Develop

```sh
pnpm install --ignore-scripts   # --ignore-scripts: prepare would rebuild lib/client.js (hot-swaps a GUI that serves it)
pnpm test                       # node --test over the pure modules
pnpm typecheck
pnpm build                      # lib/client.js; `pnpm watch` rebuilds on save
```

Trial: the `tali-message-stash` row in `cordis.dev.yml` (preview server), or
a throwaway home — see `recipes/message-stash-plugin.md`.

## Install (live profile)

```sh
dsh plugin --profile web add ./plugins/message-stash
```

No config.
