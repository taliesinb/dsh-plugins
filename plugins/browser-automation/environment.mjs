/**
 * Environment checks for the two browsers, phrased as things the USER must do.
 *
 * The model cannot install an app or flip a Safari setting; when a tool fails
 * for one of these reasons the most useful error is one that says so and tells
 * the model to relay a precise instruction to the user, instead of a raw
 * WebDriver / CDP message that invites pointless retries.
 *
 * Detection:
 * - Chrome: the app bundle (default install locations, or `mdfind` by bundle
 *   id as a fallback for a custom location). chrome-devtools-mcp reports a
 *   missing browser only indirectly ("Target closed" / "Failed to launch").
 * - Safari Technology Preview: the app bundle and its `safaridriver`. "Allow
 *   Remote Automation" cannot be read from a script (modern Safari keeps it in
 *   a secure per-user store; `defaults` does not see it), so it is detected
 *   only from the WebDriver error text (`WebDriverErrorDomain Code=6` /
 *   "Allow remote automation") at call time.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Lead-in shared by every user-remedy message; explicit so the model relays rather than retries. */
export const ASK_USER = 'This needs the user to act on this machine (the assistant cannot do it): '

export const CHROME_INSTALL_REMEDY = `${ASK_USER}download and install Google Chrome from https://www.google.com/chrome/ (or \`brew install --cask google-chrome\`), open it once so macOS finishes its first launch, then retry. Until then use the safari_* tools if Safari Technology Preview is available.`

export const STP_INSTALL_REMEDY = `${ASK_USER}download and install Safari Technology Preview (release 247 or newer) from https://developer.apple.com/safari/technology-preview/, then in Safari Technology Preview enable Develop ▸ Developer Settings ▸ "Allow Remote Automation", and retry. Classic Safari cannot be used instead (its safaridriver has no MCP mode). Until then use the chrome_* tools if Google Chrome is available.`

export const STP_REMOTE_AUTOMATION_REMEDY = `${ASK_USER}open Safari Technology Preview, choose Develop ▸ Developer Settings… (enable the Develop menu first under Settings ▸ Advanced ▸ "Show features for web developers" if it is hidden), tick "Allow Remote Automation", then retry. This switch cannot be set by script. Until then use the chrome_* tools if Google Chrome is available.`

const CHROME_BUNDLES = [
  '/Applications/Google Chrome.app',
  join(homedir(), 'Applications', 'Google Chrome.app'),
]

/**
 * Is Google Chrome installed? Checks the standard bundle locations, then asks
 * Spotlight for the bundle id (slow-ish, so only as a fallback; result cached).
 * @returns {string | undefined} the bundle path when found.
 */
let chromeCache
export function findChrome() {
  if (chromeCache !== undefined) return chromeCache.path
  for (const path of CHROME_BUNDLES) {
    if (existsSync(join(path, 'Contents', 'MacOS', 'Google Chrome'))) { chromeCache = { path }; return path }
  }
  try {
    const found = execFileSync('/usr/bin/mdfind', ['kMDItemCFBundleIdentifier == com.google.Chrome'], { encoding: 'utf8', timeout: 3000 })
      .split('\n').map(line => line.trim()).find(line => line.endsWith('.app'))
    chromeCache = { path: found }
    return found
  } catch {
    chromeCache = { path: undefined }
    return undefined
  }
}

/** Forget the cached Chrome lookup (after the user installs it, the next call should see it). */
export function forgetChrome() { chromeCache = undefined }

/**
 * Is Safari Technology Preview installed with the driver the plugin needs?
 * @param {string} driverPath - configured safaridriver path.
 * @returns {'ok' | 'missing'}
 */
export function checkSafariTechnologyPreview(driverPath) {
  return existsSync(driverPath) ? 'ok' : 'missing'
}

/**
 * Classify a runtime failure from either browser server as an environment
 * problem the user must fix, or `undefined` when it is an ordinary tool error.
 * @param {'chrome' | 'safari'} browser
 * @param {string} message - the failure text.
 * @param {{ everOpened?: boolean }} [context] - whether this browser has served a window in this process (a
 *   launch-time "Target closed" on a browser that never worked means it cannot start, not that a page went away).
 * @returns {string | undefined} the user-facing remedy.
 */
export function environmentRemedy(browser, message, context = {}) {
  if (browser === 'safari') {
    if (/WebDriverErrorDomain Code=6|Allow remote automation|Allow Remote Automation/i.test(message)) return STP_REMOTE_AUTOMATION_REMEDY
    if (/no safaridriver at|safaridriver.*(ENOENT|not found)/i.test(message)) return STP_INSTALL_REMEDY
    return undefined
  }
  if (/Failed to launch the browser process|Could not find (?:Chrome|browser)|spawn .*Google Chrome.*ENOENT|Browser was not found/i.test(message)) {
    return findChrome() === undefined ? CHROME_INSTALL_REMEDY : `${ASK_USER}Google Chrome is installed but could not be launched for automation. Open Google Chrome once by hand (it may be showing a first-launch, update or permission dialog), quit it, then retry.`
  }
  if (context.everOpened !== true && /Target closed|Session closed|Connection closed/i.test(message)) {
    if (findChrome() === undefined) return CHROME_INSTALL_REMEDY
    return `${ASK_USER}Google Chrome is installed but its automation session closed immediately on first launch. Open Google Chrome once by hand (dismiss any first-launch, default-browser or permission dialog), quit it, then retry.`
  }
  return undefined
}
