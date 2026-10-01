/**
 * tali-app-lifeline — the bundled macOS app (DSH.app, EmbeddedServer.swift)
 * spawns `dsh <profile>` with a stdin pipe it never writes to and never closes
 * while it lives. macOS does not reap a child when its parent is killed
 * (only Quit reaches applicationWillTerminate, a `kill` or a crash does not),
 * so the server would outlive the window and keep the port. Here the server
 * watches that pipe: EOF means the wrapper is gone, and the process exits
 * after a short grace period so an in-flight session log flush completes.
 *
 * Armed only when `DSH_APP_BUNDLE` is in the environment (the wrapper sets it
 * to its bundle path); under a terminal or the relay it does nothing, since
 * there stdin is a TTY or /dev/null and EOF would be meaningless.
 */
export const name = 'tali-app-lifeline'

export function apply(ctx) {
  if (!process.env.DSH_APP_BUNDLE) return
  if (process.stdin.isTTY) return
  const onEnd = () => {
    ctx.logger?.info?.('app-lifeline: wrapper closed stdin; exiting')
    setTimeout(() => process.exit(0), 500).unref()
  }
  process.stdin.on('end', onEnd)
  process.stdin.on('close', onEnd)
  process.stdin.on('error', onEnd)
  process.stdin.resume()
  ctx.effect(() => () => {
    process.stdin.off('end', onEnd)
    process.stdin.off('close', onEnd)
    process.stdin.off('error', onEnd)
    process.stdin.pause()
  })
}
