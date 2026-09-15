# Notion MCP server in DSH (hosted server, OAuth via `mcp-remote`)

Adds Notion's official hosted MCP server (`https://mcp.notion.com/mcp`) to the
live DSH web profile so every session gets `mcp__notion__*` tools
(`notion-search`, `notion-fetch`, `notion-create-pages`, `notion-update-page`,
`notion-query-data-sources`, … — 43 tools as of server v1.2.0, 2026-09-14).

Done 2026-09-14. No plugin code was written; this is config + a one-time
OAuth login.

## The constraint that shapes everything

| Fact | Consequence |
|---|---|
| DSH's built-in `@deepseek-ai/dsh-mcp-client` supports `transport: streamable-http`, but its transport factory (`packages/mcp/mcp-client/src/transport.ts`) only passes **static `headers`** to the MCP SDK. There is no OAuth code path anywhere in the package. | A direct `streamable-http` entry pointing at the Notion URL fails forever with `401`. |
| `https://mcp.notion.com/mcp` answers `401` with `WWW-Authenticate: Bearer realm="OAuth", resource_metadata=…` and publishes an OAuth AS at `https://mcp.notion.com/.well-known/oauth-authorization-server` (dynamic client registration, PKCE S256, refresh tokens). | Auth **must** be interactive OAuth. |
| Notion FAQ ("Can I use Notion MCP without interactive authorization?"): *"Not yet."* No integration-token option for the hosted server. | No `headers: {Authorization: Bearer …}` shortcut. |
| Notion's own documented fallback for stdio-only / non-OAuth clients is the `mcp-remote` bridge (`npx -y mcp-remote https://mcp.notion.com/mcp`). It runs the OAuth flow in the browser, caches tokens in `~/.mcp-auth/`, refreshes them, and proxies stdio ⇄ Streamable HTTP. | Use DSH's `transport: stdio` mode with `mcp-remote` as the "server". |

The deprecated open-source `@notionhq/notion-mcp-server` accepts a static
integration token, but Notion marks it unmaintained and it speaks the old v1
JSON API. Not used.

## Steps

### 1. Authenticate once, from a terminal (before touching the live config)

```sh
npx -y mcp-remote https://mcp.notion.com/mcp --auth-timeout 300
```

- It prints an authorize URL and opens the browser; approve the workspace.
  Callback listens on `http://localhost:9553/oauth/callback` (port is derived
  from the server URL hash, stable).
- On success stderr shows `Authorization completed successfully` then
  `Proxy established successfully`. Ctrl-C.
- Result: `~/.mcp-auth/mcp-remote-v1/cb42d1a06ae8db4e5585a26f2e5ca947_{tokens,client_info}.json`
  (mode 0600). Access token lives 8 h; a refresh token is stored and
  `mcp-remote` refreshes silently.

Why first: the web profile has `patchReload: live`. If the config lands with
no cached token, the browser prompt fires from the **server** process on
reload, with `mcp-remote`'s default 30 s auth timeout.

Verify the cache works cold (this is exactly what DSH will do):

```sh
( printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'; sleep 12 ) \
  | npx -y mcp-remote https://mcp.notion.com/mcp 2>/dev/null | head -c 600
```

Expect an `initialize` result with `"name":"Notion MCP"` and a `tools/list`
result — and **no** "Please authorize" line on stderr.

### 2. Add the entry to the live web profile

`~/.dsh/profiles/web/cordis.patch.yml`, inside the existing top-level
`- insert:` list (next to the other `tali-*` rows):

```yaml
    # Notion's hosted MCP server (https://mcp.notion.com/mcp) is OAuth-only and
    # DSH's mcp-client sends static headers only, so mcp-remote bridges it over
    # stdio: it owns the OAuth flow and caches/refreshes tokens in ~/.mcp-auth.
    # Authenticate ONCE in a terminal before (re)loading, or the browser prompt
    # fires from the server process:  npx -y mcp-remote https://mcp.notion.com/mcp
    # Tools appear as mcp__notion__notion-search, mcp__notion__notion-fetch, ...
    # Recipe: ~/projects/deepseek-harness/notion-mcp.md
    - id: tali-notion-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: notion
        transport: stdio
        command: /opt/homebrew/bin/npx
        args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp']
        cwd: !!js process.cwd()
```

Notes on the choices:

- `@deepseek-ai/dsh-mcp-client` is a dependency of the DSH CLI, so it resolves
  from any profile with no `pnpm add`. Config shape: `docs/config-catalog.md`
  → "`@deepseek-ai/dsh-mcp-client`". `args`, `env`, `cwd`, `toolCallTimeoutMs`
  (default), `failOnStartupError` (default `false`, i.e. log + reconnect loop
  instead of failing the profile) are all optional.
- `serverName: notion` → tool namespace `mcp__notion__<rawName>`; must be
  unique across mcp-client instances (`[A-Za-z0-9_-]{1,32}`).
- Absolute `/opt/homebrew/bin/npx` so it does not depend on the server
  process's `PATH`.
- DSH spawns stdio servers with `scrubbedParentEnv()`
  (`packages/subprocess/subprocess/src/index.ts`): drops names matching
  `/KEY|PASSWORD|SECRET|TOKEN/i` and `DSH_*`. `HOME` (needed for
  `~/.mcp-auth`) and `PATH` survive, so no explicit `env` is needed.
- Saving the file hot-reloads the running server; it spawned
  `npm exec mcp-remote …` → `node …/.bin/mcp-remote …` within seconds.
  Existing sessions keep their tool list; **new** sessions see the tools.

### 3. Verify from outside the GUI

`ps` is blocked in the sandbox, but `lsof`/`pgrep` work:

```sh
pgrep -lf mcp-remote                       # two procs: npm exec …, node …/mcp-remote
lsof -nP -c node -a -iTCP -sTCP:ESTABLISHED # bridge holds a :443 conn to Cloudflare (mcp.notion.com)
```

## Failed attempts / gotchas

- **`npx` from a workspace-write sandbox session fails** with
  `EPERM … /Users/tali/.npm/_cacache/tmp` and npm's misleading "root-owned
  files, run sudo chown" advice. It is the DSH file sandbox, not ownership —
  npm needs `~/.npm`, `mcp-remote` needs `~/.mcp-auth`. Retry the same command
  with `danger-full-access` (one approval prompt). Do **not** chown anything.
- The DSH web GUI cannot be opened by an agent for verification: it requires
  the one-time auth URL printed by `dsh web`, which lives only in the user's
  browser. Verify via processes (above) or ask the user to open a new session.
- `mcp-remote`'s `--debug` writes `~/.mcp-auth/mcp-remote-v1/<hash>_debug.log`
  including token-read stack traces; harmless, but noisy. Not enabled in the
  live config.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| New sessions have no `mcp__notion__*` tools | bridge failed to start; `failOnStartupError: false` means it only logged | `pgrep -lf mcp-remote`; run step 1's cold-start probe by hand and read stderr |
| Browser suddenly opens a Notion authorize page while using DSH | refresh token rejected/expired (or `~/.mcp-auth` deleted) → bridge re-ran OAuth from the server process | approve it within 30 s, or run step 1 in a terminal (long timeout) and let DSH's reconnect loop pick the new token up |
| `401` / "Missing or invalid access token" in a tool result | token cache stale and refresh failed | `rm -rf ~/.mcp-auth/mcp-remote-v1/cb42d1a0*` and redo step 1 |
| Port `9553` in use during auth | another `mcp-remote` for the same URL (e.g. the DSH-spawned one) holds the callback server | stop the other instance, or pass an explicit port after the URL (`… mcp.notion.com/mcp 9554`) |
| Tool list is huge (43 tools) and eats context | Notion exposes agent-session/skill tools you may not need | add `'--ignore-tool', 'notion-*-session*'` etc. to `args` (glob patterns; filters `tools/list` and blocks `tools/call`) |
| Want a second Notion workspace | tokens are keyed by server URL hash, one workspace per cache | not supported by mcp-remote without a separate `HOME`; re-auth switches workspace |

## References

- Notion: <https://developers.notion.com/guides/mcp/get-started-with-mcp>
  (raw MD at the same URL + `.md`; the FAQ accordions are only readable there)
- `mcp-remote`: <https://github.com/punkpeye/mcp-remote> (v0.14.2 used)
- DSH: `docs/config-catalog.md` (mcp-client schema),
  `docs/user/guide/mcp-memory.md` ("Bring another MCP server"),
  `apps/cli/config/examples/mcp-memory/*.cordis.yml` (stdio examples with `!!js`).
