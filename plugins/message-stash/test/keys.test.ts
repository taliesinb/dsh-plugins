import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DOUBLE_TAP_MS, DoubleTap, chordOf } from '../src/client/keys.ts'

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, code: '',
    ...init,
  } as KeyboardEvent
}

test('chordOf recognises Ctrl+S and Ctrl+R with Ctrl alone', () => {
  assert.equal(chordOf(key({ key: 's', ctrlKey: true })), 'stash')
  assert.equal(chordOf(key({ key: 'S', ctrlKey: true })), 'stash')
  assert.equal(chordOf(key({ key: 'ы', code: 'KeyS', ctrlKey: true })), 'stash')
  assert.equal(chordOf(key({ key: 'r', ctrlKey: true })), 'cycle')
  assert.equal(chordOf(key({ key: 's' })), undefined)
  assert.equal(chordOf(key({ key: 's', metaKey: true })), undefined)
  assert.equal(chordOf(key({ key: 's', ctrlKey: true, metaKey: true })), undefined)
  assert.equal(chordOf(key({ key: 's', ctrlKey: true, shiftKey: true })), undefined)
  assert.equal(chordOf(key({ key: 's', ctrlKey: true, altKey: true })), undefined)
  assert.equal(chordOf(key({ key: 's', ctrlKey: true, repeat: true })), undefined)
  assert.equal(chordOf(key({ key: 'x', ctrlKey: true })), undefined)
})

test('DoubleTap fires on the second tap inside the window and resets', () => {
  const taps = new DoubleTap()
  assert.equal(taps.tap(1000), false)
  assert.equal(taps.tap(1000 + DOUBLE_TAP_MS), true)
  // The pair is consumed: a third tap starts a new sequence.
  assert.equal(taps.tap(1000 + DOUBLE_TAP_MS + 10), false)
  assert.equal(taps.tap(1000 + DOUBLE_TAP_MS + 20), true)
})

test('DoubleTap misses slow taps and interrupted ones', () => {
  const taps = new DoubleTap()
  assert.equal(taps.tap(1000), false)
  assert.equal(taps.tap(1000 + DOUBLE_TAP_MS + 1), false)
  assert.equal(taps.tap(5000), false)
  taps.interrupt()
  assert.equal(taps.tap(5010), false)
})
