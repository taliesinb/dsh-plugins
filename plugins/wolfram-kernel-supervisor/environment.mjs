/**
 * Environment problems phrased as things the USER must do: no Wolfram
 * installation, or a kernel that cannot start (licence / activation). The
 * model cannot install Mathematica or activate a licence; the useful error is
 * one that says so and tells it to relay a precise instruction.
 *
 * "No kernel" itself is handled by kernel-locator.mjs (KernelLocator
 * .unconfiguredMessage, which appends WOLFRAM_INSTALL_REMEDY): the real tools
 * stay registered and fail at spawn time, because the kernel location is a
 * live setting that can be filled in without a restart.
 */

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

