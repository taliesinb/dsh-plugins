# Editing sent messages into branches (`message-branches` plugin)

2026-09-29. The Web GUI had no way to edit a sent user message, no way to see
the versions of a message, and no way to move between "threads" of a
conversation. The `plugins/message-branches` plugin (both halves) adds all
three on top of DSH's own fork: an Edit action on every user bubble (text
**and** attachments — keep, drop, add), a ‹ i/n › version switcher with a
versions list, and a tree navigator (header popover + right-sidebar tab).
Plugin contract, routes, limitations: `plugins/message-branches/README.md`.
This recipe keeps the facts that shaped it and the trial procedure.

## Survey: what the fork already had (and had not)

- **Fork exists, edit does not.** `session.fork({ sessionId, atSeq })`
  (`packages/api/session-controller/src/commands.ts`) creates a child seeded
  with the source's events up to *the first `turn/end` at or after `atSeq`*,
  `parentSession` + `isSeeded: true` in the header, `inheritedEventCount` as
  the cut. The client exposes it only as the "Branch into a new
  conversation" icon on **assistant** turn tails (`forkAt` in
  `packages/client/ui-chat/src/client/apply.ts`). User bubbles have a copy
  action and a clock, nothing else, and no slot of their own (only the
  assistant side has `conversation.chat.assistant-actions`).
- **No in-place rewrite that can be undone.** The log is append-only; the
  only rewrite primitive is `surfaceOp: { op: 'replace' }` (compaction's),
  which shadows a range for the model forever — no way to switch back. So a
  switchable tree must be fork-based, and the tree falls out of native
  lineage for free. Bonus: the shipped assistant-side Branch lands in the same
  tree.
- **The gateway fork cannot cut before turn 1** (`session/fork-unavailable`,
  "has no completed turn to fork from"). Editing the first message is the
  most common edit, so the plugin has its own fork path for every turn.
- **Turn numbers continue across a fork** (`turnBoundary.lastTurn` +1), so
  the same turn number names the same conversation position in every member
  of a family. That is what makes the version rule cheap: no content
  comparison, just headers + cuts.
- **Inbox splices are in the log** (`agent/inbox/spliced`, folded on
  restore). A prefix that ends after the splice that queued turn N's prompt
  would leave the child with the ORIGINAL prompt pending. The cut is one past
  `turn/end(N−1)` (DSH's convention) and, for turn 1, before the first splice
  (the sandbox/approval/permission preambles stay); the route also clears
  the inbox after resume as a belt-and-braces.
- **Prompt wire cannot cite an existing attachment.** `PromptContentPart` is
  text | base64 image | file *receipt*; durable `{ attachment: ref }` blocks
  are only ever produced by admission. Keeping the original attachments
  therefore has to happen host-side, where the stored `user/message`'s blocks
  can be copied into the new message verbatim (the store is content-addressed;
  `commands.attachment` authorizes reads by log reference, which the child's
  inherited prefix satisfies).
- **Client services worth knowing:** `sessions.create({ sessionId, cwd })`
  adopts an existing (cold or live) session and makes it addressable at once
  (the shipped fork relies on the same synchronous upsert); `fileUpload`
  (browser service, `upload(sessionId, blob, name)`) stages a file against a
  session's agent and returns `{ receiptId, file }`; `uiWorkspace.openSession`
  switches the main view.

## Design decisions

| Question | Choice | Why |
|---|---|---|
| Branch model | one DSH fork session per edit | the only switchable model on an append-only log; native lineage, native sidebar row, prompt cache still hits (95 % on the trial) |
| Where the fork happens | plugin host route, cold-store + controller resume | the gateway fork refuses turn 1; `ctx.agents.create` directly would skip the controller's model-selection install and handle retention — resuming through `ctx.sessionController.resolveAgent` gets both |
| Kept attachments | host copies the stored blocks | the browser cannot express a durable ref in a prompt; images could be re-uploaded from `readAttachment`, files have no read path |
| New attachments | images base64 in the edit body, files via the shipped `fileUpload` service against the **source** session, receipts resolved host-side against the source agent | reuses the upload route, streaming, size limits |
| Version rule | ancestor chains agree below turn N, distinct owners of turn N (`shared/branches.mjs`) | pure, unit-testable, no log reads on the client |
| Bubble | replacement `conversation.chat.node` cell (`key: 'user'`, `priority: -10`) with a ported stylesheet | the keyed cell is the sanctioned replacement point; DOM-injecting a button into React's tree is fragile; ui-chat's classes are hashed |
| Titles | `<parent title> (n)`, n past the highest sibling number | DSH's fork convention, minus its duplicate ` (1)` |
| Tree UI | header popover **and** sidebar tab, one component | asked for both |
| Blurbs | none | house rule |

## Trial (throwaway home, Chrome)

```sh
H=/tmp/mb-home; mkdir -p $H/profiles/web
cp ~/.dsh/.credentials.yaml ~/.dsh/settings.yaml $H/     # forwarded keys; pick a cheap default model in $H/settings.yaml
cat > /tmp/mb-overlay.yml <<EOF
- insert:
    - id: tali-message-branches
      name: '<plugins>/plugins/message-branches/index.js'
EOF
cd <dsh-src>
TMPDIR=/tmp/mb-tmp DSH_HOME=$H node --import tsx/esm apps/cli/src/bin.ts \
  --profile web --patch /tmp/mb-overlay.yml --port 3097 --no-open > $H/web.log 2>&1 &
grep -o 'http://127.0.0.1:3097/?token=[^ ]*' $H/web.log     # open in Chrome
```

What was exercised (all passed): a two-turn session → Edit on turn 3's
message → branch opens as "<title> (1)" with the edited reply, switcher
`2/2`, versions list, arrows back to the parent (`1/2`); the shipped
assistant Branch on the same parent → its first prompt shows as `2/2` of the
*next* message; header popover tree with three members and **Open in
sidebar**; a first-message edit (turn 1: the case `session.fork` refuses)
keeping one image, dropping the text file, adding a base64 image and an
uploaded `.md` through the hidden picker (`DataTransfer` on the file input);
the model saw all three. `pnpm check` (8 unit tests) and `pnpm typecheck`
green.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `pnpm dsh …` in the checkout: `create the temporary package manager install directory … Operation not permitted` | pnpm 12 vs the `packageManager` pin under the sandbox; run `node --import tsx/esm apps/cli/src/bin.ts …` from the checkout root with `TMPDIR` set (chat-title recipe) |
| Turn fails with `UNKNOWN_MODEL` in the throwaway home | the default model must be in the provider's catalog (`session/modelCatalog` through the gateway lists them); the trial used `openrouter` `anthropic/claude-haiku-4.5` |
| Versions list says *no text* for a fresh branch | the branch's own `user/message` lands a moment after the fork; the host does not cache an unsettled family and the client re-reads up to six times at 1.5 s |
| Versions popover clipped at the window edge | it is anchored `right: 0` to the switcher (the switcher sits at the row's right end) |
| Edit button missing on a message | steering messages (mid-turn) and nodes without a turn location get none — a fork cuts only at turn boundaries |
| Branch missing from the sidebar | the list frame from `session-persistence/stored` brings it; the client also adopts it with `sessions.create({ sessionId, cwd })` — needs the parent's `cwd` in the list summary |
| `session/fork-unavailable` | not this plugin: it never calls `session.fork`. Its own refusals are `409 turn N has not started` / `turn N−1 has no turn/end before turn N` (a log the observation could not balance); editing the message of the turn that is *running* works — the prefix before it is complete and the branch runs independently |
