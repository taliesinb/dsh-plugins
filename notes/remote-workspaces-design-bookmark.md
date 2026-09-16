# Remote workspaces on a local DSH server — design bookmark

Status: **bookmark / not planned**. Interesting, not what we need to build now.
Written after surveying `~/github/deepseek-harness` (0.1.2-rc.1).

## What it would enable

Keep running one `dsh web` on the Mac. Some sidebar workspaces stay ordinary local
folders; others are registered as remote (`ssh://buildbox/home/tali/proj`). A session
in a remote workspace looks identical in the GUI — same chat, tools, approvals,
locally stored history — but every `read`/`write`/`edit`, `bash` call, background job,
persistent terminal, and LSP query executes on `buildbox` over one SSH connection,
against `buildbox`'s files and toolchain. Model calls, API key, session logs,
settings, plugins, and permission policy stay local; only the world the tools touch
moves. Local and remote sessions coexist in one browser tab; a subagent spawned in a
remote session inherits that remote world.

Not provided: remote-side plugins, remote AGENTS.md discovery unless the provider
reads it over SSH (it should), sharing a remote workspace between two local servers,
or continuation if the tunnel drops mid-turn (tools fail, session reports it).

## What DSH has today (survey result)

- **No remote-workspace feature.** `dsh-workspace` canonicalizes paths with host
  `fs.realpath`, validates sessions by `SessionHeader.cwd`, and `status()` is a live
  local directory check. Directory pickers browse the host FS.
- **Execution world is one-per-process.** `ctx.fs` + `ctx.subprocess` form a single
  execution world for the whole Loader tree (design note
  `.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md`).
  Bash (`dsh-bash-local`), PTY (`dsh-terminal-bash`), LSP (`dsh-lsp-stdio`), and the
  file tools are provider-neutral consumers of those two seams. Base bundle mounts
  `dsh-subprocess-local`, `dsh-sandbox-local`, `dsh-fs-sandbox` as singletons.
- **Only remote backend: E2B POC** (`packages/e2b/`: `dsh-e2b`, `dsh-fs-e2b`,
  `dsh-subprocess-e2b`). One ephemeral sandbox per process, deleted on
  timeout/disposal, no sync/reconnect, not in any shipped bundle. Proves the
  "swap the world under neutral consumers" shape.
- `packages/api/remotes` is Client↔Host RPC, not multi-server. Web client binds to
  one host via `window.__DSH_BOOT__`.
- Remote *access* only: `--trusted-host`, SSH_CONNECTION browser-handoff suppression,
  reverse proxy for webhooks. `--host 0.0.0.0` rejected.

## Design sketch

Two independent pieces; (B) is the architectural change, (A) is "just" a provider pair.

### A. SSH execution-world provider pair

Mirror the E2B family's three-package layout:

| Package | Role |
|---|---|
| `dsh-ssh` (owner) | One multiplexed SSH connection per remote target (ControlMaster-style or ssh2 lib); config: host alias / user / port / identity, remote root. Reconnects with backoff; exposes `getConnection(target)`. Durable, not ephemeral. |
| `dsh-fs-ssh` | Implements `FileSystem` (`packages/fs/fs/src/types.ts`) over SFTP (or a tiny remote helper for atomic write + stat-version). `targetKey` = `ssh://host` + realpath; `FsVersion` from remote stat (ino/mtime/size); `processPath`/`fileUrl`/`contains` per contract; streamed reads with NUL-safe framing like E2B. |
| `dsh-subprocess-ssh` | Implements `Subprocess` incl. `spawnTerminal()` (remote PTY via `ssh -tt` / ssh2 shell channel; remote process-group signalling via `kill -- -PGID`; `which` for executable lookup). Env snapshot via base64 like E2B. |

Sandbox: `workspace-write` confinement must run *on the remote* — either a remote
`dsh-sandbox-*` counterpart (bwrap/Landlock on Linux targets) or accept
`danger-full-access`-only for remote worlds initially (the E2B POC does the latter in
spirit). Flag this as the first hard question.

### B. Per-session execution-world selection

Today a plugin row provides `ctx.fs` once. Options:

1. **Routing providers.** Mount `dsh-fs-router` / `dsh-subprocess-router` as *the*
   `ctx.fs`/`ctx.subprocess`, each delegating per call to a concrete world chosen by
   the calling Agent's session → workspace → `executionWorld` field. Requires the call
   to know its Agent: check whether fs/subprocess calls already receive an agent-scoped
   ctx (Cordis scoped services) — if yes, routing is cheap; if no, this is the real
   work. Least invasive to consumers (Bash/PTY/LSP unchanged).
2. **Per-agent scoped providers.** If Cordis supports forking a scope per Agent, mount
   the concrete world inside the Agent's scope at session start. Cleaner ownership,
   deeper change to `dsh-agent-loop` session creation.

Either way:
- `Workspace` gains an optional `executionWorld: { kind: 'local' } | { kind: 'ssh', target, remoteRoot }`.
  Path canon for remote workspaces must not use host `fs.realpath`; realpath through
  the world's `ctx.fs` instead. `status()` likewise.
- Workspace Controller / directory picker: add "remote" registration UI (target picker
  + remote path browse via `dsh-fs-ssh`).
- `sandbox-policy.workspaceRoot` and `SessionHeader.cwd` become world-qualified.
- AGENTS.md/CLAUDE.md discovery and skill loading should read via the session's world.
- Subagents inherit the parent's world (they already share ctx).

### Open questions (don't answer now)

- Does any fs/subprocess call site carry Agent identity? (Decides router vs scope.)
- Sandbox confinement on remote: remote helper vs full-access-only.
- LSP servers run remote; `dsh-lsp-stdio` already routes via `ctx.subprocess`, so OK,
  but file URIs must be `file://` on the remote — the seam's `fileUrl()` covers it.
- Attachments / read_image / spill files: which side stores them?
- Relationship to upstream: propose as an Agent Note upstream first; the portable
  execution-world note explicitly deferred "generic distributed runtime".

## Pointers

- `apps/cli/reference/README.md` — profiles (`web`, `headless`, `sdk`, `sdk-minimal`, `acp`), patch layering.
- `docs/subsystems/filesystem.md`, `docs/subsystems/subprocess.md` — the two seam contracts.
- `docs/subsystems/workspace.md` — current local-path workspace contract.
- `packages/e2b/*/README.md` — the template to copy for a provider family.
