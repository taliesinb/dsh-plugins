/**
 * Environment problems phrased as things the USER must do: no Wolfram
 * installation, or a kernel that cannot start (licence / activation). The
 * model cannot install Mathematica or activate a licence; the useful error is
 * one that says so and tells it to relay a precise instruction.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const ASK_USER = 'This needs the user to act on this machine (the assistant cannot do it): '

export const WOLFRAM_INSTALL_REMEDY = `${ASK_USER}install Wolfram (Mathematica 15 or newer, or the free Wolfram Engine from https://www.wolfram.com/engine/) into /Applications, launch it once to activate its licence, then retry. The wolfram_* tools need the Wolfram\`AgentTools\` paclet that ships with Wolfram 15+.`

/**
 * Turn a kernel-start failure into a user instruction when its text points at
 * a licence / activation problem, else a generic "launch it once" remedy.
 * @param {string} detail - the connect error plus the kernel's stderr tail.
 * @returns {string}
 */
export function kernelStartRemedy(detail) {
  if (/licen[cs]e|activation|password|expired|Mathematica cannot find a valid|not activated|Wolfram ID/i.test(detail)) {
    return `${ASK_USER}the Wolfram kernel has no valid licence on this machine. Open Wolfram (Mathematica) once and complete activation (sign in with a Wolfram ID or enter the activation key), or run \`wolframscript -activate\` in a terminal, then retry.`
  }
  if (/AgentTools|PacletDirectoryLoad|StartMCPServer/i.test(detail)) {
    return `${ASK_USER}the Wolfram\`AgentTools\` paclet is missing or outdated. In Wolfram (15+) evaluate PacletInstall["Wolfram/AgentTools"], or update the app, then retry.`
  }
  return `${ASK_USER}open Wolfram (Mathematica) once by hand and check that a notebook evaluates 1+1 (first launch may show licence or paclet-update dialogs), then retry.`
}

const TOOL_NAMES = ['wolfram_eval', 'wolfram_show', 'wolfram_run', 'wolfram_symbol', 'wolfram_lint', 'wolfram_kernel_open', 'wolfram_kernel_close', 'wolfram_kernel_list']

/**
 * Register stand-ins for every wolfram_* tool that fail with the install
 * remedy, on every agent, when no kernel binary exists. Same attach policy as
 * the real tools (subagents included per config).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ subagents: boolean }} config
 * @param {string} configured - configured kernel path ('' = auto).
 */
export function registerUnavailableStubs(ctx, config, configured) {
  const where = configured ? `no Wolfram kernel at the configured path "${configured}"` : 'Wolfram is not installed on this machine (no Wolfram.app, Mathematica.app or Wolfram Engine.app)'
  const stubs = TOOL_NAMES.map(name => defineTool({
    name,
    description: `UNAVAILABLE on this machine: ${where}. Calling it returns the instruction the user needs to make the Wolfram Language tools work; do not retry without a change.`,
    parameters: {},
    async execute() {
      throw new Error(`${name}: Wolfram Language is unavailable — ${where}. ${WOLFRAM_INSTALL_REMEDY}`)
    },
  }))
  const attached = new Map()
  const attach = (agent) => {
    if (attached.has(agent)) return
    if ((agent.session.header?.delegationDepth ?? 0) > 0 && !config.subagents) return
    const dispose = ctx.effect(() => {
      const disposers = stubs.map(tool => agent.ctx.tools.register(tool))
      return () => { for (const d of disposers) d() }
    }, 'wolfram-kernel-supervisor.unavailable-stubs')
    attached.set(agent, dispose)
  }
  for (const agent of ctx.agents.list()) attach(agent)
  ctx.on('agent/created', ({ agent }) => { attach(agent) })
  ctx.on('agent/disposed', ({ agent }) => { const d = attached.get(agent); if (d !== undefined) { attached.delete(agent); void d() } })
}
