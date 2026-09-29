import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY, cycle, decode, encode, pop, push, release, restore, type StashState,
} from '../src/client/stash.ts'

const A = { sessionId: 'A', sessionTitle: 'Session A' }
const B = { sessionId: 'B' }

function texts(state: StashState): string[] {
  return state.entries.map(entry => entry.text)
}

function stash(...messages: string[]): StashState {
  // push() in order, so the LAST message ends on top.
  let state: StashState = EMPTY
  for (const [index, text] of messages.entries()) {
    const result = push(state, text, A, 1000 + index)
    assert.equal(result.kind, 'pushed')
    if (result.kind === 'pushed') state = result.state
  }
  return state
}

test('push puts the text on top, strips the editor trailing newline, refuses blanks', () => {
  const state = stash('first\n', 'second')
  assert.deepEqual(texts(state), ['second', 'first'])
  assert.equal(push(state, '   \n', A).kind, 'blank')
  assert.equal(state.entries[1]!.sessionTitle, 'Session A')
})

test('cycle with an empty composer checks out the top without reordering', () => {
  const state = stash('one', 'two', 'three')
  const result = cycle(state, '', A)
  assert.equal(result.kind, 'checkout')
  if (result.kind !== 'checkout') return
  assert.equal(result.entry.text, 'three')
  assert.deepEqual(texts(result.state), ['three', 'two', 'one'])
  assert.deepEqual(result.state.checkout, { entryId: result.entry.id, sessionId: 'A' })
})

test('cycle again writes the edits back, moves the entry to the bottom and checks out the next', () => {
  let state = stash('one', 'two', 'three')
  let result = cycle(state, '', A)
  assert.equal(result.kind, 'checkout')
  state = result.state
  // User edits "three" → "three!" and cycles.
  result = cycle(state, 'three!\n', A)
  assert.equal(result.kind, 'checkout')
  if (result.kind !== 'checkout') return
  assert.equal(result.entry.text, 'two')
  assert.deepEqual(texts(result.state), ['two', 'one', 'three!'])
  // A full lap comes back around to the edited entry.
  state = result.state
  result = cycle(state, 'two', A)
  assert.equal(result.kind, 'checkout')
  if (result.kind !== 'checkout') return
  assert.equal(result.entry.text, 'one')
  result = cycle(result.state, 'one', A)
  assert.equal(result.kind, 'checkout')
  if (result.kind !== 'checkout') return
  assert.equal(result.entry.text, 'three!')
})

test('cycle with unstashed text parks it at the bottom so nothing is lost', () => {
  const state = stash('one', 'two')
  const result = cycle(state, 'draft in progress', A)
  assert.equal(result.kind, 'checkout')
  if (result.kind !== 'checkout') return
  assert.equal(result.entry.text, 'two')
  assert.deepEqual(texts(result.state), ['two', 'one', 'draft in progress'])
})

test('cycle does nothing on an empty stash, even with a draft', () => {
  assert.equal(cycle(EMPTY, '', A).kind, 'nothing')
  const result = cycle(EMPTY, 'keep me', A)
  assert.equal(result.kind, 'nothing')
  assert.deepEqual(texts(result.state), [])
})

test('cycle with a single checked-out entry keeps it (edits written back)', () => {
  let state = stash('only')
  const first = cycle(state, '', A)
  assert.equal(first.kind, 'checkout')
  state = first.state
  const again = cycle(state, 'only, edited', A)
  assert.equal(again.kind, 'nothing')
  assert.deepEqual(texts(again.state), ['only, edited'])
  assert.deepEqual(again.state.checkout, state.checkout)
})

test('a blank composer never overwrites the checked-out text on cycle', () => {
  let state = stash('one', 'two')
  state = (cycle(state, '', A) as Extract<ReturnType<typeof cycle>, { kind: 'checkout' }>).state
  const result = cycle(state, '   ', A)
  assert.equal(result.kind, 'checkout')
  assert.deepEqual(texts(result.state), ['one', 'two'])
})

test('push on a checked-out entry updates it in place and moves it to the top; checkout ends', () => {
  let state = stash('one', 'two', 'three')
  state = (cycle(state, '', A) as Extract<ReturnType<typeof cycle>, { kind: 'checkout' }>).state
  state = (cycle(state, 'three', A) as Extract<ReturnType<typeof cycle>, { kind: 'checkout' }>).state
  // now: [two, one, three], "two" checked out
  const result = push(state, 'two, edited', A)
  assert.equal(result.kind, 'pushed')
  if (result.kind !== 'pushed') return
  assert.deepEqual(texts(result.state), ['two, edited', 'one', 'three'])
  assert.equal(result.state.entries.length, 3)
  assert.equal(result.state.checkout, undefined)
})

test('checkouts are per session: another session pushes and cycles independently', () => {
  let state = stash('one', 'two')
  state = (cycle(state, '', A) as Extract<ReturnType<typeof cycle>, { kind: 'checkout' }>).state
  const pushed = push(state, 'from B', B)
  assert.equal(pushed.kind, 'pushed')
  if (pushed.kind !== 'pushed') return
  assert.deepEqual(texts(pushed.state), ['from B', 'two', 'one'])
  assert.deepEqual(pushed.state.checkout, state.checkout)
})

test('pop removes an entry and ends its checkout; release keeps the entry', () => {
  let state = stash('one', 'two')
  const result = cycle(state, '', A)
  assert.equal(result.kind, 'checkout')
  if (result.kind !== 'checkout') return
  state = result.state
  const released = release(state, 'A')
  assert.deepEqual(texts(released), ['two', 'one'])
  assert.equal(released.checkout, undefined)
  assert.deepEqual(release(state, 'B'), state)
  const popped = pop(state, result.entry.id)
  assert.deepEqual(texts(popped), ['one'])
  assert.equal(popped.checkout, undefined)
  assert.equal(pop(state, 'missing'), state)
})

test('restore checks out a chosen entry, preserving the composer content like cycle', () => {
  const state = stash('one', 'two', 'three')
  const target = state.entries[2]! // 'one'
  const result = restore(state, target.id, 'unsaved', A)
  assert.equal(result.kind, 'checkout')
  if (result.kind !== 'checkout') return
  assert.equal(result.entry.text, 'one')
  assert.deepEqual(texts(result.state), ['unsaved', 'three', 'two', 'one'])
  assert.equal(result.state.checkout?.entryId, target.id)
  assert.equal(restore(state, 'missing', '', A).kind, 'nothing')
})

test('restore of the entry already in the composer only writes back', () => {
  let state = stash('one', 'two')
  const first = cycle(state, '', A)
  assert.equal(first.kind, 'checkout')
  if (first.kind !== 'checkout') return
  state = first.state
  const result = restore(state, first.entry.id, 'two edited', A)
  assert.equal(result.kind, 'nothing')
  assert.deepEqual(texts(result.state), ['two edited', 'one'])
})

test('encode/decode round-trips and rejects garbage', () => {
  let state = stash('one', 'two')
  state = (cycle(state, '', A) as Extract<ReturnType<typeof cycle>, { kind: 'checkout' }>).state
  assert.deepEqual(decode(encode(state)), state)
  assert.deepEqual(decode(null), EMPTY)
  assert.deepEqual(decode('not json'), EMPTY)
  assert.deepEqual(decode('{"version":99,"entries":[]}'), EMPTY)
  // A checkout pointing at a missing entry is dropped.
  const dangling = JSON.stringify({ version: 1, entries: state.entries, checkout: { entryId: 'x', sessionId: 'A' } })
  assert.equal(decode(dangling).checkout, undefined)
  assert.equal(decode(dangling).entries.length, 2)
})
