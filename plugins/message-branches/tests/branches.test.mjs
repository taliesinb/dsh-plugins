import { test } from 'node:test'
import assert from 'node:assert/strict'
import { branchTitle, chainOf, ownerOf, siblingsAt, treeRows } from '../shared/branches.mjs'

/**
 *   R (turns 1..5)
 *   ├─ A  forked at turn 3 (own turns 3, 4)
 *   │   └─ B forked from A at turn 3 (A's first own turn: same history as A)
 *   │   └─ C forked from A at turn 4
 *   └─ D  forked at turn 1 (first message edited)
 */
const family = {
  root: 'R',
  members: {
    R: { id: 'R', parent: null, firstOwnTurn: 1, createdAt: 1, previews: { 1: 'r1', 3: 'r3', 4: 'r4' } },
    A: { id: 'A', parent: 'R', firstOwnTurn: 3, createdAt: 2, previews: { 3: 'a3', 4: 'a4' } },
    B: { id: 'B', parent: 'A', firstOwnTurn: 3, createdAt: 3, previews: { 3: 'b3' } },
    C: { id: 'C', parent: 'A', firstOwnTurn: 4, createdAt: 4, previews: { 4: 'c4' } },
    D: { id: 'D', parent: 'R', firstOwnTurn: 1, createdAt: 5, previews: { 1: 'd1' } },
  },
}

const ids = members => members.map(m => m.id)

test('chainOf / ownerOf', () => {
  assert.deepEqual(ids(chainOf(family, 'B')), ['R', 'A', 'B'])
  assert.equal(ownerOf(family, 'B', 2).id, 'R')
  assert.equal(ownerOf(family, 'B', 3).id, 'B')
  assert.equal(ownerOf(family, 'A', 5).id, 'A')
  assert.equal(ownerOf(family, 'C', 3).id, 'A')
})

test('siblingsAt: alternatives share the history below the turn', () => {
  assert.deepEqual(ids(siblingsAt(family, 'R', 3)), ['R', 'A', 'B'])
  assert.deepEqual(ids(siblingsAt(family, 'A', 3)), ['R', 'A', 'B'])
  assert.deepEqual(ids(siblingsAt(family, 'B', 3)), ['R', 'A', 'B'])
  // Turn 4 seen from A: R's turn 4 sits on a different turn 3 → not a sibling.
  assert.deepEqual(ids(siblingsAt(family, 'A', 4)), ['A', 'C'])
  assert.deepEqual(ids(siblingsAt(family, 'R', 4)), ['R'])
  // Turn 2 is shared by everyone descending from R's turn 1: one version.
  assert.deepEqual(ids(siblingsAt(family, 'A', 2)), ['R'])
  // First-message edit: D is an alternative to R at turn 1, for every R descendant.
  assert.deepEqual(ids(siblingsAt(family, 'R', 1)), ['R', 'D'])
  assert.deepEqual(ids(siblingsAt(family, 'B', 1)), ['R', 'D'])
  assert.deepEqual(ids(siblingsAt(family, 'D', 1)), ['R', 'D'])
})

test('treeRows: depth-first, children by branch turn then age', () => {
  assert.deepEqual(treeRows(family).map(r => `${r.member.id}@${r.depth}`), ['R@0', 'D@1', 'A@1', 'B@2', 'C@2'])
})

test('branchTitle numbers past existing siblings', () => {
  assert.equal(branchTitle('fix login', []), 'fix login (1)')
  assert.equal(branchTitle('fix login', ['fix login (1)', 'other']), 'fix login (2)')
  assert.equal(branchTitle('fix login (2)', []), 'fix login (3)')
  assert.equal(branchTitle('fix login (2)', ['fix login (7)']), 'fix login (8)')
})
