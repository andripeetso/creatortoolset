// the one rule, kept apart from place.ts so a tool can ask it without loading the AI Editor (place.ts imports engine.ts)

/**
 * Where a piece of processing runs: the one rule (local-first plan, D7). "server" = this server runs it now (on This Mac
 * that is the person's own computer); "computer" = one of the asker's computers takes it; "wait" = it waits with its line
 * and never falls through to the server. `reads`: it decodes video or sound; `open`: the server's video work is on for it
 * (serverWorks and the person's weight); `first`: the person prefers the server and it holds every file; `computer`: a
 * computer of theirs can take it now. The thunks run only when the answer needs them.
 */
export function mayRunHere(q: { reads: boolean; open: () => boolean; first?: () => boolean; computer: () => boolean }): "server" | "computer" | "wait" {
  // This Mac: open is always true (server-work.ts), the server being the person's own computer
  if (!q.reads) return "server";
  const open = q.open();
  if (open && q.first?.()) return "server";
  if (q.computer()) return "computer";
  return open ? "server" : "wait";
}
