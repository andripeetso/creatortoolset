import type { Collection, Piece, PieceItem } from "../../contracts/library";
import { ToolError, str, when, type Args, type ToolContext, type ToolModule } from "./types";

// Finals for the assistant: the finished pieces a person keeps (a piece holds versions, one can be the winner), read
// and changed through the routes the Finals pages use. Linking a piece to a Workshop session is api/mcp.ts's own tool
// (finals_link_session): finals_pieces gives it the piece's id.

const enc = encodeURIComponent;
/** Finals is the plain top-level folder named Finals in the account's Media Library (the Finals page finds it the same way). */
const isFinals = (c: Collection) => c.kind === "manual" && c.parentId === null && c.name === "Finals";
const READ_ONLY = "This piece holds a version this account may not change, so the piece is read only here.";
/** How long a piece stays in the Finals trash: the library's own number (PIECE_TRASH_DAYS in api/library/trash.ts), as the page's question says it. */
const TRASH_DAYS = 5;

/** What GET /api/library/workshop says of a piece linked to a Workshop session. */
type Linked = { sessionId: string; status?: string; description?: string; versions?: Record<string, { text: string }> };

/** The account's own Media Library (the first one), as the start of its routes: its Finals are the ones the Finals page shows. */
const home = async (ctx: ToolContext): Promise<string> => {
  const lib = (await ctx.json<{ libraries: Array<{ id: string }> }>("/api/library")).libraries[0];
  if (!lib) throw new ToolError("This account has no Media Library yet.");
  return `/api/library/${enc(lib.id)}`;
};

/** The pieces of the Finals folder, oldest first as the route gives them; none while nothing was ever sent to Finals. */
const listed = async (ctx: ToolContext, lib: string, trash = false): Promise<Piece[]> => {
  const finals = (await ctx.json<{ collections: Collection[] }>(`${lib}/collections`)).collections.find(isFinals);
  return finals ? (await ctx.json<{ pieces: Piece[] }>(`${lib}/pieces?collectionId=${enc(finals.id)}${trash ? "&trash=1" : ""}`)).pieces : [];
};

/** One piece by its id, its own route, and whether it is in the trash (the piece itself does not say). */
const one = async (ctx: ToolContext, lib: string, id: unknown) => {
  const pid = typeof id === "string" ? id.trim() : "";
  if (!pid) throw new ToolError("Give piece: the piece's id (finals_pieces lists them).");
  const at = `${lib}/pieces/${enc(pid)}`;
  const [piece, trash] = await Promise.all([ctx.json<Piece>(at), ctx.json<{ pieces: Piece[] }>(`${lib}/pieces?trash=1`)]);
  return { at, piece, trashed: trash.pieces.some((p) => p.id === pid) };
};

/**
 * A piece as the AI reads it: its versions in the page's order. A version's id here is the one the piece's routes and
 * the Workshop take (the piece item's), never the Media Library's own id of the file.
 */
const row = (ctx: ToolContext, p: Piece, linked?: Linked, more?: (i: PieceItem) => Args) => ({
  id: p.id,
  name: p.label,
  versions: p.items.map((i) => ({ id: i.id, ...(i.label ? { name: i.label } : {}), ...(i.winner ? { winner: true } : {}), ...more?.(i) })),
  ...(linked ? { session: linked.sessionId, ...(linked.status ? { session_status: linked.status } : {}) } : {}),
  link: `${ctx.origin}/finals/${p.id}`,
});

const given = (a: Args, k: string) => a[k] !== undefined && a[k] !== null;

export const finalsTools: ToolModule = {
  defs: [
    {
      name: "finals_pieces",
      description:
        "The user's Finals pieces (finished work, each kept in versions), newest first: id, name, each version's id and name, which is the winner, the Workshop session it is linked to, its link in the app. limit defaults to 20; piece (an id) gives that one in full, with each version's post description and where it was posted.",
      inputSchema: { type: "object", properties: { limit: { type: "integer" }, piece: str } },
    },
    {
      name: "finals_piece_update",
      description:
        'Change one Finals piece (piece: its id): name renames it, winner is a version\'s id ("none" clears it), order is version ids first to last (ones left out follow as they are). With version (its id), version_name and post_description set that version\'s own ("" removes it).',
      inputSchema: {
        type: "object",
        properties: { piece: str, name: str, winner: str, order: { type: "array", items: str }, version: str, version_name: str, post_description: str },
        required: ["piece"],
      },
    },
    {
      name: "finals_piece_trash",
      description: `Move a Finals piece (its id) to the trash, where it stays ${TRASH_DAYS} days, or bring it back with restore: true. Its versions stay in the Media Library. With no piece, lists what is in the trash.`,
      inputSchema: { type: "object", properties: { piece: str, restore: { type: "boolean" } } },
    },
  ],
  handlers: {
    finals_pieces: async (a, ctx) => {
      const lib = await home(ctx);
      const links = (await ctx.json<{ pieces: Record<string, Linked> }>("/api/library/workshop")).pieces;
      if (a.piece) {
        const { piece, trashed } = await one(ctx, lib, a.piece);
        const linked = links[piece.id];
        return {
          ...row(ctx, piece, linked, (i) => {
            // the version's own post description, else the one its Workshop session holds for it
            const text = i.postDescription ?? linked?.versions?.[i.id]?.text;
            return {
              ...(text ? { post_description: text } : {}),
              ...(i.postings.length ? { posted: i.postings.map((p) => ({ platform: p.platform, ...(p.url ? { url: p.url } : {}), at: when(p.postedAt) })) } : {}),
            };
          }),
          ...(linked?.description ? { session_post_description: linked.description } : {}),
          ...(trashed ? { trashed: true } : {}),
          ...(piece.writable === false ? { read_only: true } : {}),
        };
      }
      const limit = Math.min(100, Math.max(1, Math.floor(Number(a.limit)) || 20));
      const all = (await listed(ctx, lib)).reverse();
      return {
        pieces: all.slice(0, limit).map((p) => row(ctx, p, links[p.id])),
        ...(all.length > limit ? { note: `The newest ${limit} of ${all.length}: give limit for more.` } : {}),
      };
    },
    finals_piece_update: async (a, ctx) => {
      if (!["name", "winner", "order", "version_name", "post_description"].some((k) => given(a, k)))
        throw new ToolError("Nothing to change: give a name, a winner, an order, or a version with its version_name or post_description.");
      const own = given(a, "version_name") || given(a, "post_description");
      if (own && !a.version) throw new ToolError("Give version: the id of the version whose name or post description this is.");
      const name = given(a, "name") ? String(a.name).trim() : undefined;
      if (name === "") throw new ToolError("A piece needs a name.");
      if (given(a, "order") && !Array.isArray(a.order)) throw new ToolError("order is a list of version ids.");
      const { at, piece } = await one(ctx, await home(ctx), a.piece);
      if (piece.writable === false) throw new ToolError(READ_ONLY);

      // everything is checked against this one read before the first write, so a refusal changes nothing
      const versionOf = (id: unknown): PieceItem => {
        const found = piece.items.find((i) => i.id === String(id).trim());
        if (!found) throw new ToolError(`This piece has no version ${String(id)}: finals_pieces with piece lists its versions.`);
        return found;
      };
      // "none" clears the winner, and so does an empty answer
      const noWinner = given(a, "winner") && /^(none)?$/i.test(String(a.winner).trim());
      const winner = given(a, "winner") && !noWinner ? versionOf(a.winner) : undefined;
      const version = own ? versionOf(a.version) : undefined;
      const first = given(a, "order") ? (a.order as unknown[]).map(versionOf) : [];
      if (new Set(first).size !== first.length) throw new ToolError("order names a version twice.");

      const changed: string[] = [];
      let now = piece;
      const save = async (item: PieceItem, body: Args) => void (now = await ctx.json<Piece>(`${at}/items/${enc(item.id)}`, "PATCH", body));
      if (name !== undefined && name !== piece.label) {
        now = await ctx.json<Piece>(at, "PATCH", { label: name });
        changed.push("renamed");
      }
      if (first.length) {
        // positions 1..n in the new order; only a version whose place changed is written, as a drag on the page does
        const moved = [...first, ...piece.items.filter((i) => !first.includes(i))].flatMap((i, n) => (i.position === n + 1 ? [] : [{ i, position: n + 1 }]));
        for (const m of moved) await save(m.i, { position: m.position });
        if (moved.length) changed.push("order changed");
      }
      if (version) {
        // "" is an answer here: it removes the version's own name or post description
        await save(version, { ...(given(a, "version_name") ? { label: String(a.version_name) } : {}), ...(given(a, "post_description") ? { postDescription: String(a.post_description) } : {}) });
        // said from what the piece now holds, so "saved" and "removed" are what happened
        const saved = now.items.find((i) => i.id === version.id);
        if (saved && saved.label !== version.label) changed.push(saved.label ? "version named" : "version's name removed");
        if (saved && saved.postDescription !== version.postDescription) changed.push(saved.postDescription ? "post description saved" : "post description removed");
      }
      const had = piece.items.find((i) => i.winner);
      if (winner && !winner.winner) {
        await save(winner, { winner: true });
        changed.push("winner set");
      } else if (noWinner && had) {
        await save(had, { winner: false });
        changed.push("winner cleared");
      }
      // the route keeps a post description up to its own limit and cuts the rest without a word
      const kept = version && given(a, "post_description") ? (now.items.find((i) => i.id === version.id)?.postDescription ?? "") : "";
      const cut = kept && kept.length < String(a.post_description).length;
      return {
        ...row(ctx, now),
        changed,
        ...(cut ? { note: `The post description was cut to its first ${kept.length.toLocaleString("en-US")} characters: that is the longest one kept.` } : {}),
        ...(changed.length ? {} : { note: "Nothing changed: the piece was like this already." }),
      };
    },
    finals_piece_trash: async (a, ctx) => {
      const lib = await home(ctx);
      if (!a.piece) return { trash: (await listed(ctx, lib, true)).map((p) => ({ id: p.id, name: p.label, versions: p.items.length })) };
      const { at, piece, trashed } = await one(ctx, lib, a.piece);
      const said = { id: piece.id, name: piece.label };
      if (a.restore === true) {
        if (!trashed) throw new ToolError(`"${piece.label}" isn't in the trash.`);
        await ctx.json(`${at}/restore`, "POST");
        return { ...said, restored: true, link: `${ctx.origin}/finals/${piece.id}` };
      }
      if (trashed) throw new ToolError(`"${piece.label}" is in the trash already: restore: true brings it back.`);
      if (piece.writable === false) throw new ToolError(READ_ONLY);
      await ctx.sure(`Move the piece "${piece.label}" to the trash? Its versions stay in the Media Library. The piece is gone for good after ${TRASH_DAYS} days.`);
      await ctx.json(`${at}/trash`, "POST");
      return { ...said, trashed: true, note: `Its versions stay in the Media Library. restore: true brings the piece back for ${TRASH_DAYS} days, then it is gone for good.` };
    },
  },
  // one line per tool, so each is true whatever the call does (finals_piece_trash also lists and restores)
  steps: {
    finals_pieces: "Looking through your Finals",
    finals_piece_update: "Updating a Finals piece",
    finals_piece_trash: "Working in the Finals trash",
  },
  // a change's card opens the piece
  work: (name, _a, r) => {
    const changed = name === "finals_piece_update" && Array.isArray(r.changed) ? r.changed.join(", ") : "";
    return changed
      ? { card: { id: `finals:${String(r.id)}`, kind: "link", title: String(r.name), href: `/finals/${String(r.id)}`, status: "done", detail: changed.replace(/^./, (c) => c.toUpperCase()) } }
      : null;
  },
};
