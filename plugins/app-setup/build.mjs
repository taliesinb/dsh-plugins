/**
 * Browser-half bundle build (this repo's esbuild client-bundle template; sans minify).
 * Produces lib/client.js in the artifact format the DSH web shell loads:
 *
 *   window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     ...CJS bundle...
 *     return module.exports; } });
 *
 * Platform modules stay `require()`s answered by the shell's module table;
 * everything else is inlined.
 */
import { build, context } from 'esbuild'
import { readFileSync } from 'node:fs'

const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name

// Mirror of PLATFORM_MODULES in <checkout>/packages/client/web/src/platform.ts.
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

// `--outfile=<path>` builds elsewhere (lib/client.js is what an installed profile serves:
// writing it hot-swaps the running GUI, so trial builds can go to a side output).
const outfile = process.argv.find(a => a.startsWith('--outfile='))?.slice('--outfile='.length) ?? 'lib/client.js'

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/client/index.tsx'],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: PLATFORM_MODULES,
  logLevel: 'info',
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG)}, factory: (require) => {\n`
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
  console.log(`[${PKG}] watching src/ -> ${outfile}`)
} else {
  await build(options)
}
