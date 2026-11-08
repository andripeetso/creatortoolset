/**
 * One guarded status change. Every lifecycle with a status field (jobs, sessions, approvals, sources…) declares
 * its allowed moves next to its union and changes status only through `move`, so the legal transitions are
 * written down in one place and an illegal one fails loudly instead of leaving a record in a state nothing
 * leaves.
 */
export type Moves<S extends string> = { readonly [K in S]: readonly S[] };

export class IllegalTransition extends Error {
  readonly what: string;
  readonly from: string;
  readonly to: string;
  constructor(what: string, from: string, to: string) {
    super(`${what}: can't go from "${from}" to "${to}"`);
    this.what = what;
    this.from = from;
    this.to = to;
  }
}

/** True when `from → to` is allowed (staying put always is). */
export function canMove<S extends string>(moves: Moves<S>, from: S, to: S): boolean {
  return from === to || moves[from]?.includes(to) === true;
}

/** Returns `to`, or throws `IllegalTransition`. Use as `x.status = move(MOVES, x.status, "done", "export job")`. */
export function move<S extends string>(moves: Moves<S>, from: S, to: S, what: string): S {
  if (!canMove(moves, from, to)) throw new IllegalTransition(what, from, to);
  return to;
}
