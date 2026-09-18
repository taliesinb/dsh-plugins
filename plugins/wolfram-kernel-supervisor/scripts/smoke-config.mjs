// Validate the Config schema defaults and the launch spec without spawning anything.
import { Config, SettingsSchema } from '../index.js'
import { findAgentToolsDirectory, findKernel, kernelLaunch } from '../servers.mjs'
const config = Config({})
if (config.resolution !== 144 || config.idleMinutes !== 60 || config.maxKernelsPerSession !== 4 || config.configureWolframscript !== true) throw new Error('unexpected defaults: ' + JSON.stringify(config))
if (SettingsSchema({}).kernelPath !== '' || SettingsSchema({ kernelPath: '/x' }).kernelPath !== '/x') throw new Error('unexpected settings schema')
const kernel = findKernel(config.kernel)
const paclet = findAgentToolsDirectory(config.pacletDirectory)
const launch = kernelLaunch({ kernel: kernel ?? '/nonexistent/wolfram', pacletDirectory: paclet, server: config.server })
console.log('config ok; kernel:', kernel ?? '(none found)', '; paclet:', paclet ?? '(none)', '; args:', launch.args.slice(0, 3).join(' '), '…')
