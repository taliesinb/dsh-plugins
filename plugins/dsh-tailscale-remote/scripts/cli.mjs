#!/usr/bin/env node
/**
 * Terminal front door for what the settings section does with buttons, for
 * when the GUI is not handy (e.g. DSH is down and you want the relay up):
 *
 *   pnpm relay:install [--listen 127.0.0.1:3083] [--backend 127.0.0.1:3084] [--dsh 127.0.0.1:3080]
 *                      [--cwd ~/github/deepseek-harness] [--start "pnpm dsh web --no-open"] [--log-dir ~/.dsh/logs]
 *                      [--dsh-home ~/.dsh-preview]   (DSH_HOME the relay starts DSH with; default: the caller's)
 *                      [--no-load]   write the plist only (no GUI session to load it into; see launch-agent.mjs)
 *   pnpm relay:uninstall
 *   pnpm relay:status  [--listen 127.0.0.1:3083]
 *   pnpm dock-app:build  [--glyph-color #000000] [--tile-color #ffffff]
 *   pnpm dock-app:install [--name DSH] [--url https://node.ts.net/dsh/] [--fallback http://127.0.0.1:3083/]
 *                         [--token-file ~/.dsh/tailscale-remote.json] [--no-launch]
 *   pnpm dock-app:uninstall [--name DSH]
 *   pnpm dock-app:remote <host[/path] | URL> [--name "DSH Host"] [--glyph-color #0090FF] [--no-launch]
 *                         a BLUE app that opens another Mac's DSH directly over the tailnet (no relay, no
 *                         fallback, no token; identity admission). Default name: DSH <Titlecased host>.
 *   … every command takes `--instance preview` to address a second (preview) DSH's relay/app.
 *
 * `--url` defaults to this node's route (`tailscale status` → https://<fqdn>/dsh/).
 * Everything here is macOS-only and exits 0 with a note elsewhere, so the
 * scripts are safe in cross-platform automation.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { REMOTE_GLYPH_COLOR, buildDockApp, dockAppStatus, installDockApp, parseRemoteTarget, remoteAppName, remoteInstance, resolveTailnetHost, uninstallDockApp } from '../dock-app.mjs'
import { defaultLogDir, installRelayAgent, relayStatus, uninstallRelayAgent } from '../relay/launch-agent.mjs'
import { defaultStateFile } from '../state.mjs'
import { createTailscaleManager } from '../tailscale.mjs'

function parse(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--no-')) flags[arg.slice(5)] = false
    else if (arg.startsWith('--')) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[arg.slice(2)] = true
      else { flags[arg.slice(2)] = next; i += 1 }
    } else positional.push(arg)
  }
  return { flags, positional }
}

function expandHome(value) {
  return typeof value === 'string' && value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

async function routeUrl(flags) {
  if (typeof flags.url === 'string') return flags.url
  const manager = createTailscaleManager({ configuredPath: '', port: Number(flags['serve-port'] ?? 443), mountPath: String(flags.mount ?? '/dsh'), target: () => '' })
  const status = await manager.status()
  if (status.url === undefined) throw new Error(`cannot derive the tailnet URL (${status.detail ?? status.state}); pass --url`)
  if (status.selfLogin === undefined) console.warn('warning: this node has no Tailscale user (tagged); the Dock app will need the QR token')
  return status.url
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { flags, positional } = parse(rest)
  if (process.platform !== 'darwin') {
    console.log(`${command ?? 'dsh-tailscale-remote'}: macOS only — nothing to do on ${process.platform}`)
    return
  }
  const log = line => console.log(line)
  const instance = typeof flags.instance === 'string' ? flags.instance : ''
  switch (command) {
    case 'relay:install': {
      const result = await installRelayAgent({
        instance,
        listen: String(flags.listen ?? '127.0.0.1:3083'),
        backend: String(flags.backend ?? '127.0.0.1:3084'),
        dsh: String(flags.dsh ?? '127.0.0.1:3080'),
        cwd: expandHome(String(flags.cwd ?? process.cwd())),
        start: String(flags.start ?? 'pnpm dsh web --no-open'),
        logDir: expandHome(String(flags['log-dir'] ?? defaultLogDir())),
        dshHome: typeof flags['dsh-home'] === 'string' ? expandHome(flags['dsh-home']) : undefined,
        load: flags['no-load'] === true ? false : undefined,
        log,
      })
      if (result.loaded === false) return
      console.log(result.listening ? 'relay: listening' : 'relay: loaded but not listening yet — check relay.log')
      return
    }
    case 'relay:uninstall':
      await uninstallRelayAgent({ instance, log })
      return
    case 'relay:status': {
      const port = Number(String(flags.listen ?? '127.0.0.1:3083').split(':').pop())
      console.log(JSON.stringify(await relayStatus({ listenPort: port, instance }), null, 2))
      return
    }
    case 'dock-app:build':
      console.log(await buildDockApp({ glyphColor: flags['glyph-color'], tileColor: flags['tile-color'], log, force: flags.force === true }))
      return
    case 'dock-app:install': {
      const name = String(flags.name ?? 'DSH')
      const url = await routeUrl(flags)
      const result = await installDockApp({
        name,
        instance,
        url,
        fallbackUrl: String(flags.fallback ?? 'http://127.0.0.1:3083/'),
        tokenFile: expandHome(String(flags['token-file'] ?? defaultStateFile())),
        glyphColor: flags['glyph-color'],
        tileColor: flags['tile-color'],
        launch: flags.launch !== false,
        log,
      })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case 'dock-app:remote': {
      const target = parseRemoteTarget(positional[0] ?? flags.target)
      let url = target.url
      let host = target.host
      if (url === undefined) {
        const manager = createTailscaleManager({ configuredPath: '', port: 443, mountPath: '/dsh', target: () => '' })
        const raw = await manager.statusJson()
        host = resolveTailnetHost(target.host, raw)
        url = `https://${host}${target.path === '/' ? '' : target.path}/`
      }
      const name = String(flags.name ?? remoteAppName(host))
      const result = await installDockApp({
        name,
        instance: remoteInstance(host, target.path),
        url,
        fallbackUrl: undefined,
        tokenFile: undefined,
        glyphColor: flags['glyph-color'] ?? REMOTE_GLYPH_COLOR,
        tileColor: flags['tile-color'],
        launch: flags.launch !== false,
        log,
      })
      console.log(JSON.stringify({ ...result, name, url }, null, 2))
      return
    }
    case 'dock-app:uninstall':
      console.log(JSON.stringify(await uninstallDockApp({ name: String(flags.name ?? 'DSH') }), null, 2))
      return
    case 'dock-app:status':
      console.log(JSON.stringify(await dockAppStatus({ name: String(flags.name ?? 'DSH'), url: typeof flags.url === 'string' ? flags.url : '' }), null, 2))
      return
    default:
      console.error('usage: cli.mjs relay:install|relay:uninstall|relay:status|dock-app:build|dock-app:install|dock-app:remote <host[/path]>|dock-app:uninstall|dock-app:status [flags]')
      process.exit(2)
  }
}

main().catch((error) => {
  console.error(String(error?.message ?? error))
  process.exit(1)
})
