/**
 * Native "choose a file OR a folder" dialog on the SERVER machine, rooted at a
 * given directory. DSH's own directory picker (`directory-picker-native`) is
 * folder-only and has no starting location, hence this one.
 *
 *   macOS   NSOpenPanel through JXA (`osascript -l JavaScript`): files and
 *           directories in one panel, hidden entries shown (the session stores
 *           live under dot-directories), initial directory set.
 *   Linux   zenity / kdialog: directories only (their file chooser cannot do
 *           both in one dialog); the GUI's typed-path input covers files.
 *   else    unavailable → the client shows only the typed-path input.
 *
 * Never invokes a shell; arguments are passed as argv. Cancel resolves null.
 */
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'

const JXA = String.raw`
ObjC.import('AppKit')
function run(argv) {
  const initial = argv[0], message = argv[1]
  const app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  const panel = $.NSOpenPanel.openPanel
  panel.canChooseFiles = true
  panel.canChooseDirectories = true
  panel.allowsMultipleSelection = false
  panel.resolvesAliases = true
  panel.showsHiddenFiles = true
  panel.treatsFilePackagesAsDirectories = true
  panel.canCreateDirectories = false
  panel.message = message
  panel.prompt = 'Import'
  panel.title = 'Import sessions into DSH'
  if (initial !== '') panel.directoryURL = $.NSURL.fileURLWithPath(initial)
  app.activateIgnoringOtherApps(true)
  const response = panel.runModal
  if (response !== $.NSModalResponseOK) return ''
  return panel.URLs.objectAtIndex(0).path.js
}
`

function run(command, args, signal, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { maxBuffer: 1 << 20, timeout: timeoutMs, signal, windowsHide: true }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
    child.on('error', reject)
  })
}

async function which(command) {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  for (const dir of dirs) {
    try { await access(`${dir}/${command}`, constants.X_OK); return `${dir}/${command}` } catch { /* next */ }
  }
  return undefined
}

/** What the current platform can show. */
export async function pickerCapability(platform = process.platform) {
  if (platform === 'darwin') return { available: true, kind: 'file-or-directory', tool: 'osascript' }
  if (platform === 'linux') {
    if (await which('zenity')) return { available: true, kind: 'directory', tool: 'zenity' }
    if (await which('kdialog')) return { available: true, kind: 'directory', tool: 'kdialog' }
  }
  return { available: false, kind: 'none' }
}

/**
 * Show the chooser.
 * @param {object} options
 * @param {string} options.initialDirectory
 * @param {string} [options.message]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string|null>} chosen path or null when cancelled
 */
export async function pickPath({ initialDirectory, message = 'Choose a session transcript, a workspace folder, or the whole store', signal, platform = process.platform } = {}) {
  const capability = await pickerCapability(platform)
  if (!capability.available) {
    const error = new Error('no native file chooser is available on the server machine')
    error.code = 'picker-unavailable'
    throw error
  }
  if (platform === 'darwin') {
    const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', JXA, initialDirectory ?? '', message], signal)
    const path = stdout.replace(/[\r\n]+$/, '')
    return path === '' ? null : path
  }
  try {
    if (capability.tool === 'zenity') {
      const { stdout } = await run('zenity', ['--file-selection', '--directory', `--title=${message}`, ...(initialDirectory ? [`--filename=${initialDirectory.replace(/\/?$/, '/')}`] : [])], signal)
      const path = stdout.replace(/[\r\n]+$/, '')
      return path === '' ? null : path
    }
    const { stdout } = await run('kdialog', ['--getexistingdirectory', initialDirectory ?? '.', '--title', message], signal)
    const path = stdout.replace(/[\r\n]+$/, '')
    return path === '' ? null : path
  } catch (error) {
    // zenity/kdialog exit 1 on cancel.
    if (error?.code === 1) return null
    throw error
  }
}
