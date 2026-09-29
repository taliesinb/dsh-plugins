/**
 * tali-message-stash — host half.
 *
 * Nothing to do on the host: this plugin is browser-only. The package exists
 * on the Node side so the Loader row resolves and the host serves the
 * `./client` bundle (package.json `dsh.client`) to the web shell, where the
 * real work (src/client/index.tsx) runs. The stash itself lives in the
 * browser's localStorage.
 */

export const name = 'message-stash'

export const inject = []

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 */
export function apply(ctx) {
  ctx.logger.info('message-stash: browser half bound to Ctrl+S / Ctrl+S,S / Ctrl+R')
}
