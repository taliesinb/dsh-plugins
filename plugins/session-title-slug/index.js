/**
 * tali-session-title-slug — host half.
 *
 * Nothing to do on the host: this plugin is browser-only. The package exists
 * on the Node side so the Loader row resolves and the host serves the
 * `./client` bundle (package.json `dsh.client`) to the web shell, where the
 * real work (src/client/index.tsx) runs. The rename itself goes through the
 * ordinary `session.rename` RPC the sidebar's Rename menu uses.
 */

export const name = 'session-title-slug'

export const inject = []

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host-plane plugin context.
 */
export function apply(ctx) {
  ctx.logger.info('session-title-slug: browser half names New Sessions from a leading `slug: `')
}
