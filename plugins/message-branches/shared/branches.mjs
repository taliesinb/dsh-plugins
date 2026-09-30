/**
 * Pure branch-tree arithmetic shared by the host (tests) and the browser bundle.
 *
 * A "family" is one root session plus every session forked from it,
 * transitively. Every member except the root carries `firstOwnTurn`: the turn
 * number of the first turn the member produced itself (its inherited prefix
 * holds the turns below). Turn numbers are per-log counters that a fork child
 * continues, so the same turn number names the same conversation position in
 * every member of a family.
 *
 * Family JSON (the host route's answer):
 *   { root: id, members: { [id]: { id, parent, firstOwnTurn, createdAt, previews: { [turn]: text } } } }
 *   The root has parent === null and firstOwnTurn === 1.
 *
 * `previews[turn]` is the first line of the user prompt that opened `turn`
 * in that member's OWN events — recorded only for the turns that are branch
 * points somewhere in the family, so the versions list can show every
 * alternative without loading the sessions.
 */

/**
 * @typedef {{ id: string, parent: string | null, firstOwnTurn: number, createdAt: number, previews: Record<string, string> }} Member
 * @typedef {{ root: string, members: Record<string, Member> }} Family
 */

/**
 * The ancestor chain of `id`, root first: [{ id, firstOwnTurn }, …, { id, firstOwnTurn }].
 * @param {Family} family
 * @param {string} id
 * @returns {Member[]}
 */
export function chainOf(family, id) {
  const chain = []
  const seen = new Set()
  let cursor = family.members[id]
  while (cursor !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    chain.push(cursor)
    cursor = cursor.parent === null ? undefined : family.members[cursor.parent]
  }
  return chain.reverse()
}

/**
 * The member that produced turn `turn` of session `id`'s log: the deepest
 * ancestor (or `id` itself) whose `firstOwnTurn` is ≤ `turn`.
 * @param {Family} family
 * @param {string} id
 * @param {number} turn
 * @returns {Member | undefined}
 */
export function ownerOf(family, id, turn) {
  const chain = chainOf(family, id)
  let owner
  for (const member of chain) {
    if (member.firstOwnTurn <= turn) owner = member
    else break
  }
  return owner
}

/**
 * Key of the shared history below `turn`: the ancestor chain restricted to
 * members whose first own turn is < `turn`.
 * @param {Family} family
 * @param {string} id
 * @param {number} turn
 */
function prefixKey(family, id, turn) {
  return chainOf(family, id)
    .filter(member => member.firstOwnTurn < turn)
    .map(member => member.id)
    .join('>')
}

/**
 * The alternatives at turn `turn` as seen from session `id`: every distinct
 * member that produced a turn `turn` on top of the same history, oldest
 * first. Always contains the owner of `id`'s own turn `turn` (when it exists).
 * A result of length ≤ 1 means the message has no other versions.
 * @param {Family} family
 * @param {string} id
 * @param {number} turn
 * @returns {Member[]}
 */
export function siblingsAt(family, id, turn) {
  const key = prefixKey(family, id, turn)
  const owners = new Map()
  for (const candidate of Object.values(family.members)) {
    if (prefixKey(family, candidate.id, turn) !== key) continue
    const owner = ownerOf(family, candidate.id, turn)
    if (owner === undefined) continue
    owners.set(owner.id, owner)
  }
  return [...owners.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/**
 * Whether `id` has at least one other version at any turn — used to decide
 * whether a family is worth a tree view.
 * @param {Family} family
 */
export function hasBranches(family) {
  return Object.keys(family.members).length > 1
}

/**
 * Tree rows for the navigator: depth-first, children under their parent,
 * each row `{ member, depth }`. Children are grouped by their branch turn
 * (ascending), then by creation time.
 * @param {Family} family
 * @returns {Array<{ member: Member, depth: number }>}
 */
export function treeRows(family) {
  const children = new Map()
  for (const member of Object.values(family.members)) {
    if (member.parent === null) continue
    const list = children.get(member.parent) ?? []
    list.push(member)
    children.set(member.parent, list)
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.firstOwnTurn - b.firstOwnTurn || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }
  const rows = []
  const visited = new Set()
  const walk = (member, depth) => {
    if (visited.has(member.id)) return
    visited.add(member.id)
    rows.push({ member, depth })
    for (const child of children.get(member.id) ?? []) walk(child, depth + 1)
  }
  const root = family.members[family.root]
  if (root !== undefined) walk(root, 0)
  return rows
}

/**
 * Next title for a branch child: the parent's title with DSH's fork
 * convention ` (n)`, where n is one past the highest existing sibling number
 * of that base (so a second edit of the same message does not reuse ` (1)`).
 * @param {string} parentTitle
 * @param {readonly string[]} siblingTitles - titles of the parent's existing children
 * @returns {string}
 */
export function branchTitle(parentTitle, siblingTitles) {
  const parsed = /^(.*?)\s*\((\d+)\)$/u.exec(parentTitle)
  const base = parsed?.[1] ?? parentTitle
  let highest = parsed?.[2] === undefined ? 0 : Number(parsed[2])
  for (const title of siblingTitles) {
    const match = /^(.*?)\s*\((\d+)\)$/u.exec(title)
    if (match !== null && match[1] === base) highest = Math.max(highest, Number(match[2]))
  }
  return `${base} (${highest + 1})`
}
