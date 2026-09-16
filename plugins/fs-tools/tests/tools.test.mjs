import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Config, PROMPT_HINT, apply, build } from '../index.js'
import { countOccurrences } from '../edit-many.mjs'
import { buildSearchArgv, parseSearchArgs } from '../search.mjs'
import { fakeCtx, fakeExec, textOf } from './fake-ctx.mjs'

const root = mkdtempSync(join(tmpdir(), 'fs-tools-'))
after(() => rmSync(root, { recursive: true, force: true }))

// A small tree: src/{a.ts,b.ts,util/c.ts}, docs/readme.md, node_modules/x/index.js, .git/HEAD
mkdirSync(join(root, 'src/util'), { recursive: true })
mkdirSync(join(root, 'docs'))
mkdirSync(join(root, 'node_modules/x'), { recursive: true })
mkdirSync(join(root, '.git'))
writeFileSync(join(root, 'src/a.ts'), 'import { foo } from "./b"\n\nexport function alpha() {\n  return foo(1)\n}\n\nexport const twice = foo(2) + foo(3)\n')
writeFileSync(join(root, 'src/b.ts'), 'export function foo(n: number) {\n  return n * 2\n}\n')
writeFileSync(join(root, 'src/util/c.ts'), 'export const C = 3 // foo\n')
writeFileSync(join(root, 'docs/readme.md'), '# Readme\n\nfoo bar\n')
writeFileSync(join(root, 'node_modules/x/index.js'), 'module.exports = "foo"\n')
writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n')

const ctx = fakeCtx({ workspaceRoot: root })
const tools = build(ctx, Config({}))
const tool = (name) => tools.find(t => t.name === name)
const exec = fakeExec('session-test', root)
const run = (name, args) => tool(name).execute(args, exec)
const text = (name, args, value) => textOf(tool(name), args, value)

test('apply registers the four tools and the prompt hint', () => {
  const c = fakeCtx({ workspaceRoot: root })
  apply(c, Config({}))
  assert.deepEqual(c.registered.map(t => t.name), ['list_dir', 'read_many', 'edit_many', 'search'])
  assert.equal(c.systemPrompt.sections.length, 1)
  assert.equal(c.systemPrompt.sections[0].text({ scope: undefined }), PROMPT_HINT)
  const noHint = fakeCtx({ workspaceRoot: root })
  apply(noHint, Config({ promptHint: false }))
  assert.equal(noHint.systemPrompt.sections.length, 0)
})

// ---------------------------------------------------------------- list_dir

test('list_dir: default lists direct children of the workspace, dirs first with a slash, noise collapsed', async () => {
  const v = await run('list_dir', {})
  const t = text('list_dir', {}, v)
  assert.match(t, /^\/.*\(4 dirs, 0 files\)/)
  const names = v.roots[0].rows.map(r => r.path)
  assert.deepEqual(names, ['.git/', 'docs/', 'node_modules/', 'src/'])
  assert.ok(v.roots[0].rows.find(r => r.path === 'node_modules/').collapsed)
  assert.ok(v.roots[0].rows.find(r => r.path === '.git/').collapsed)
  assert.match(t, /node_modules\/ {2}\(not descended; pass all:true\)/)
})

test('list_dir: depth, sizes, several roots, missing root reported inline, all descends node_modules', async () => {
  const v = await run('list_dir', { paths: ['src', 'nope', 'docs/readme.md'], depth: 2, sizes: true })
  assert.equal(v.roots.length, 3)
  assert.deepEqual(v.roots[0].rows.map(r => r.path), ['util/', 'util/c.ts', 'a.ts', 'b.ts'])
  assert.equal(typeof v.roots[0].rows[1].size, 'number')
  assert.equal(v.roots[1].error, 'not found')
  assert.match(v.roots[2].error, /not a directory/)
  const t = text('list_dir', {}, v)
  assert.match(t, /c\.ts {2}\d+ B/)
  assert.match(t, /nope: not found/)
  const all = await run('list_dir', { depth: 3, all: true })
  assert.ok(all.roots[0].rows.some(r => r.path === 'node_modules/x/index.js'))
  assert.ok(all.roots[0].rows.some(r => r.path === '.git/HEAD'))
})

test('list_dir: max_entries truncates with a note; bad args rejected', async () => {
  const v = await run('list_dir', { depth: 3, all: true, max_entries: 3 })
  assert.equal(v.roots[0].rows.length, 3)
  assert.ok(v.roots[0].truncated)
  assert.match(text('list_dir', {}, v), /stopped at 3 entries/)
  await assert.rejects(run('list_dir', { depth: 0 }), /depth must be a positive integer/)
  await assert.rejects(run('list_dir', { paths: [] }), /at least one directory/)
})

// ---------------------------------------------------------------- read_many

test('read_many: several files and ranges, line-numbered, observed for the guard', async () => {
  const args = { files: [{ path: 'src/a.ts', offset: 3, limit: 3 }, { path: 'src/b.ts' }, { path: 'src/a.ts', offset: 7 }] }
  const v = await run('read_many', args)
  assert.equal(v.files.length, 3)
  assert.deepEqual(v.files[0].rows, ['3: export function alpha() {', '4:   return foo(1)', '5: }'])
  assert.equal(v.files[0].total, 7)
  assert.equal(v.files[1].rows.length, 3)
  assert.deepEqual(v.files[2].rows, ['7: export const twice = foo(2) + foo(3)'])
  const t = text('read_many', args, v)
  assert.match(t, /<path>.*src\/a\.ts<\/path>\n<type>file<\/type>\n<content> {2}\(lines 3-5 of 7\)/)
  // one observation per distinct file, with the version
  const obs = ctx.events.filter(e => e.name === 'fs/observed')
  assert.equal(obs.filter(e => e.path.endsWith('src/a.ts')).length, 1)
  assert.equal(obs.filter(e => e.path.endsWith('src/b.ts')).length, 1)
  assert.equal(obs[0].state.kind, 'present')
})

test('read_many: missing file inline (observed absent), directory rejected inline, collapse_blank, max_lines budget', async () => {
  const v = await run('read_many', { files: ['src/nope.ts', 'src', { path: 'src/a.ts' }], collapse_blank: true })
  assert.equal(v.files[0].error, 'not found')
  assert.ok(ctx.events.some(e => e.name === 'fs/observed' && e.path.endsWith('src/nope.ts') && e.state.kind === 'absent'))
  assert.match(v.files[1].error, /not a regular file/)
  assert.equal(v.files[2].rows.length, 5, 'blank lines dropped')
  assert.equal(v.files[2].rows[2], '4:   return foo(1)', 'numbers stay accurate')
  const b = await run('read_many', { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }], max_lines: 5 })
  assert.equal(b.files[0].rows.length, 5)
  assert.equal(b.files[0].omitted, 2)
  assert.equal(b.files.length, 1)
  assert.equal(b.truncatedAt, 5)
  assert.match(text('read_many', {}, b), /2 more requested lines omitted/)
  await assert.rejects(run('read_many', { files: [] }), /non-empty array/)
  await assert.rejects(run('read_many', { files: [{ path: 'x', limit: 99999 }] }), /at most 2000/)
})

// ---------------------------------------------------------------- edit_many

test('countOccurrences counts non-overlapping matches', () => {
  assert.equal(countOccurrences('aaaa', 'aa'), 2)
  assert.equal(countOccurrences('abc', 'x'), 0)
})

test('edit_many: unread file is refused before any write (FS_NOT_OBSERVED), with all problems listed', async () => {
  const fresh = fakeCtx({ workspaceRoot: root })
  const [, , editMany] = build(fresh, Config({}))
  const before = readFileSync(join(root, 'src/b.ts'), 'utf8')
  await assert.rejects(
    editMany.execute({ edits: [
      { file_path: 'src/b.ts', old_string: 'n * 2', new_string: 'n * 3' },
      { file_path: 'src/c-missing.ts', old_string: 'x', new_string: 'y' },
    ] }, exec),
    (e) => {
      assert.equal(e.code, 'EDIT_MANY_INVALID')
      assert.match(e.message, /2 problems, nothing written/)
      assert.match(e.message, /#1 .*has not been read — read it \(read or read_many\)/)
      assert.match(e.message, /#2 .*has not been read/)
      return true
    },
  )
  assert.equal(readFileSync(join(root, 'src/b.ts'), 'utf8'), before)
})

test('edit_many: read_many authorises; several edits in one file + another file; later edit sees earlier result; observed after', async () => {
  const c = fakeCtx({ workspaceRoot: root })
  const [, readMany, editMany] = build(c, Config({}))
  const a = join(root, 'src/a.ts')
  const b = join(root, 'src/b.ts')
  const aBefore = readFileSync(a, 'utf8')
  const bBefore = readFileSync(b, 'utf8')
  await readMany.execute({ files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] }, exec)
  const args = { edits: [
    { file_path: 'src/a.ts', old_string: 'return foo(1)', new_string: 'return bar(1)' },
    { file_path: 'src/a.ts', old_string: 'bar(1)\n}', new_string: 'bar(1) // edited\n}' }, // matches text produced by #1
    { file_path: 'src/b.ts', old_string: 'n * 2', new_string: 'n * 3' },
    { file_path: 'src/a.ts', old_string: 'foo(', new_string: 'baz(', replace_all: true },
  ] }
  const v = await editMany.execute(args, exec)
  assert.equal(v.applied.length, 4)
  assert.equal(v.files, 2)
  assert.equal(readFileSync(a, 'utf8'), 'import { foo } from "./b"\n\nexport function alpha() {\n  return bar(1) // edited\n}\n\nexport const twice = baz(2) + baz(3)\n')
  assert.equal(readFileSync(b, 'utf8'), 'export function foo(n: number) {\n  return n * 3\n}\n')
  const t = textOf(editMany, args, v)
  assert.match(t, /^applied 4 edits in 2 files\./)
  assert.match(t, /src\/a\.ts: 3 edits \(line 4, line 4, 2× from line 7\)/)
  assert.match(t, /src\/b\.ts: 1 edit \(line 2\)/)
  // a following single edit needs no re-read: the record is fresh
  const intent = await c.waterfall('fs/edit-intent', { targetKey: a, path: a }, exec, () => undefined)
  assert.equal(intent.version, (await c.fs.stat({ path: a })).version)
  // presentation: diff cards from args
  assert.equal(editMany.presentCall(args).diffs.length, 4)
  assert.match(editMany.presentCall(args).title, /Edit 2 files \(4 edits\)/)
  assert.equal(editMany.output.presentationMeta(args, v).diffs.length, 4)
  // restore
  writeFileSync(a, aBefore)
  writeFileSync(b, bBefore)
})

test('edit_many: not-found and ambiguous old_string are collected together, nothing written; dry_run writes nothing', async () => {
  const c = fakeCtx({ workspaceRoot: root })
  const [, readMany, editMany] = build(c, Config({}))
  await readMany.execute({ files: ['src/a.ts'] }, exec)
  const before = readFileSync(join(root, 'src/a.ts'), 'utf8')
  await assert.rejects(
    editMany.execute({ edits: [
      { file_path: 'src/a.ts', old_string: 'foo(', new_string: 'x(' },
      { file_path: 'src/a.ts', old_string: 'does not exist', new_string: 'y' },
      { file_path: 'src/a.ts', old_string: 'alpha', new_string: 'beta' },
    ] }, exec),
    /2 problems, nothing written:\n {2}#1 .*appears 3 times — make it more specific or set replace_all.*\n {2}#2 .*old_string not found \(does not exist\)/,
  )
  assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), before)
  const dry = await editMany.execute({ dry_run: true, edits: [{ file_path: 'src/a.ts', old_string: 'alpha', new_string: 'beta' }] }, exec)
  assert.equal(dry.dryRun, true)
  assert.match(textOf(editMany, {}, dry), /^Dry run: would apply 1 edit in 1 file\./)
  assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), before)
})

test('edit_many: a bash-side write after the read makes the batch fail stale with a re-read remedy, before any write', async () => {
  const c = fakeCtx({ workspaceRoot: root })
  const [, readMany, editMany] = build(c, Config({}))
  await readMany.execute({ files: ['src/b.ts'] }, exec)
  const b = join(root, 'src/b.ts')
  const original = readFileSync(b, 'utf8')
  c.externalWrite(b, original.replace('n * 2', 'n * 2 // touched by bash'))
  await assert.rejects(
    editMany.execute({ edits: [{ file_path: 'src/b.ts', old_string: 'n * 2', new_string: 'n * 4' }] }, exec),
    (e) => { assert.equal(e.code, 'FS_STALE_VERSION'); assert.match(e.message, /stopped at edit #1.*changed since it was read — re-read it/s); assert.match(e.message, /Nothing was applied/); return true },
  )
  assert.match(readFileSync(b, 'utf8'), /touched by bash/)
  // re-reading fixes it
  await readMany.execute({ files: ['src/b.ts'] }, exec)
  await editMany.execute({ edits: [{ file_path: 'src/b.ts', old_string: 'n * 2 // touched by bash', new_string: 'n * 2' }] }, exec)
  assert.equal(readFileSync(b, 'utf8'), original)
})

test('edit_many: sandbox denial outside the workspace root is the [sandbox: …] marker', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'fs-tools-outside-'))
  const f = join(outside, 'o.txt')
  writeFileSync(f, 'hello\n')
  const c = fakeCtx({ workspaceRoot: root })
  const [, readMany, editMany] = build(c, Config({}))
  await readMany.execute({ files: [f] }, exec)
  await assert.rejects(
    editMany.execute({ edits: [{ file_path: f, old_string: 'hello', new_string: 'bye' }] }, exec),
    (e) => { assert.equal(e.code, 'FS_SANDBOX_DENIED'); assert.match(e.message, /\[sandbox: file access denied under workspace-write mode\]/); return true },
  )
  assert.equal(readFileSync(f, 'utf8'), 'hello\n')
  rmSync(outside, { recursive: true, force: true })
})

test('edit_many: without an observation policy (no listener) edits are unconditional, like edit', async () => {
  const c = fakeCtx({ workspaceRoot: root, withPolicy: false })
  const [, , editMany] = build(c, Config({}))
  const b = join(root, 'src/b.ts')
  const original = readFileSync(b, 'utf8')
  await editMany.execute({ edits: [{ file_path: 'src/b.ts', old_string: 'n * 2', new_string: 'n * 5' }] }, exec)
  assert.match(readFileSync(b, 'utf8'), /n \* 5/)
  writeFileSync(b, original)
})

test('edit_many: argument validation', async () => {
  await assert.rejects(run('edit_many', { edits: [] }), /non-empty array/)
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'a', old_string: '', new_string: 'b' }] }), /old_string must be a non-empty string/)
  await assert.rejects(run('edit_many', { edits: [{ file_path: 'a', old_string: 'x', new_string: 'x' }] }), /must differ/)
})

// ---------------------------------------------------------------- search

test('search: argv construction keeps model values behind --flag= and --', () => {
  const input = parseSearchArgs({ pattern: '-foo', patterns: ['bar'], paths: ['-src'], include: ['*.ts'], exclude: ['*.spec.ts'], context: 2, case_insensitive: true, literal: true }, { maxResults: 250 })
  assert.deepEqual(buildSearchArgv(input), [
    '--no-config', '--json', '--ignore-case', '--fixed-strings', '--context=2',
    '--glob=*.ts', '--glob=!*.spec.ts', '--regexp=-foo', '--regexp=bar', '--', '-src',
  ])
  assert.throws(() => parseSearchArgs({}, { maxResults: 250 }), /pattern \(or patterns\) is required/)
  assert.throws(() => parseSearchArgs({ pattern: 'x', mode: 'nope' }, { maxResults: 250 }), /mode must be/)
  assert.throws(() => parseSearchArgs({ pattern: 'x', exclude_pattern: '(' }, { maxResults: 250 }), /exclude_pattern is not a valid/)
  assert.throws(() => parseSearchArgs({ pattern: 'x', include: ['!a'] }, { maxResults: 250 }), /must be positive/)
})

test('search: lines mode with context, grouped by file, N: matches and N- context, gaps marked', async () => {
  const args = { pattern: 'foo\\(', context: 1, paths: ['src'] }
  const v = await run('search', args)
  assert.equal(v.mode, 'lines')
  assert.equal(v.totalMatches, 3, 'a.ts lines 4 and 7, b.ts line 1')
  assert.deepEqual(v.files.map(f => f.path), ['src/a.ts', 'src/b.ts'], 'sorted by path')
  const a = v.files.find(f => f.path === 'src/a.ts')
  const t = text('search', args, v)
  assert.match(t, /^Found 3 matches in 2 files/)
  assert.match(t, /src\/a\.ts\n {2}3- export function alpha\(\) \{\n {2}4:   return foo\(1\)\n {2}5- \}\n {2}6- \n {2}7: export const twice = foo\(2\) \+ foo\(3\)/)
  assert.ok(a.rows.every(r => r.gap || typeof r.line === 'number'))
})

test('search: files / count modes, include + exclude globs, several patterns, exclude_pattern, no_ignore, literal', async () => {
  const files = await run('search', { pattern: 'foo', mode: 'files' })
  assert.deepEqual(files.files.map(f => f.path).sort(), ['docs/readme.md', 'src/a.ts', 'src/b.ts', 'src/util/c.ts'])
  assert.match(text('search', {}, files), /^Found \d+ matches in 4 files\ndocs\/readme\.md\nsrc\/a\.ts\n/)
  const count = await run('search', { pattern: 'foo', mode: 'count', include: ['*.ts'] })
  assert.deepEqual(count.files.map(f => `${f.path}=${f.matches}`).sort(), ['src/a.ts=3', 'src/b.ts=1', 'src/util/c.ts=1'])
  assert.match(text('search', {}, count), /3 {2}src\/a\.ts/)
  const excl = await run('search', { pattern: 'foo', mode: 'files', include: ['*.ts'], exclude: ['**/util/**'] })
  assert.deepEqual(excl.files.map(f => f.path).sort(), ['src/a.ts', 'src/b.ts'])
  const multi = await run('search', { patterns: ['Readme', 'C = 3'], mode: 'files' })
  assert.deepEqual(multi.files.map(f => f.path).sort(), ['docs/readme.md', 'src/util/c.ts'])
  const gv = await run('search', { pattern: 'foo', paths: ['src/a.ts'], exclude_pattern: 'import|twice' })
  assert.equal(gv.totalMatches, 1)
  assert.equal(gv.files[0].rows[0].line, 4)
  // node_modules is gitignored-by-convention only when a .gitignore says so: here it is not ignored, so it appears either way
  const nm = await run('search', { pattern: 'module.exports', mode: 'files', no_ignore: true })
  assert.deepEqual(nm.files.map(f => f.path), ['node_modules/x/index.js'])
  const lit = await run('search', { pattern: 'foo(1)', literal: true, mode: 'count' })
  assert.deepEqual(lit.files.map(f => f.path), ['src/a.ts'])
  const none = await run('search', { pattern: 'zzzzz' })
  assert.equal(text('search', {}, none), 'No matches found')
})

test('search: max_results caps matches with a note; invalid regex surfaces rg diagnostic', async () => {
  const v = await run('search', { pattern: 'foo', max_results: 2 })
  assert.equal(v.shownMatches, 2)
  assert.ok(v.truncated)
  assert.ok(v.totalMatches > 2)
  assert.match(text('search', {}, v), /showing first 2; raise max_results/)
  await assert.rejects(run('search', { pattern: 'foo(' }), (e) => { assert.equal(e.code, 'SEARCH_FAILED'); assert.match(e.message, /unclosed group|regex/i); return true })
})
