/** One session of a family: the root or a fork descendant. */
export interface Member {
  readonly id: string
  /** Fork source, or null for the root. */
  readonly parent: string | null
  /** Turn number of the first turn this member produced itself (1 for the root). */
  readonly firstOwnTurn: number
  readonly createdAt: number
  /** First line of this member's own prompt at each turn that is a branch point in the family. */
  readonly previews: Readonly<Record<string, string>>
}

/** The tree of one root session and every session forked from it. */
export interface Family {
  readonly root: string
  readonly members: Readonly<Record<string, Member>>
}

export function chainOf(family: Family, id: string): Member[]
export function ownerOf(family: Family, id: string, turn: number): Member | undefined
export function siblingsAt(family: Family, id: string, turn: number): Member[]
export function hasBranches(family: Family): boolean
export function treeRows(family: Family): Array<{ member: Member, depth: number }>
export function branchTitle(parentTitle: string, siblingTitles: readonly string[]): string
