/**
 * Browser-half bundle build (copy of foreign-link-opener/build.mjs).
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

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
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
  console.log(`[${PKG}] watching src/ -> lib/client.js`)
} else {
  await build(options)
}
