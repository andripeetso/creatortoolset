import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { AuthVars } from "../../auth";
import { libraryDb } from "../../library/db";
import { enqueueJob } from "../../library/jobs";
import { addPicture } from "../animation-styles";
import { editRole, ownerOf, readDraft, readEdit, seesEdit, viewOf } from "../store";
import { cardFile, clearCards, readCards, saveCards } from "./state";
import { withdraw } from "./step";

/**
 * What the edit page does with a version's cards (contracts/editor.ts), inside /api/editor, for everyone who sees the
 * edit (store.ts editRole): a card's still, the 👍 that puts it in the workspace's animation style's Made & liked, and
 * Make cards again.
 */

export const cardsApp = new Hono<{ Variables: AuthVars }>();

const notFound = { error: "Not found", code: "not_found" };
/** The edit, when the caller sees it, and the version's card state, or null. */
async function load(user: string, id: string, variant: string) {
  const e = readEdit(id);
  const st = e && (await editRole(user, e)) && (await seesEdit(user, e)) ? readCards(e.id, variant) : null;
  return e && st ? { e, st } : null;
}

cardsApp.get("/:id/cards/:variant/:card/still", async (c) => {
  const { id, variant, card } = c.req.param();
  const r = await load(c.get("user").username, id, variant);
  const file = r?.st.drawn.includes(card) ? cardFile(id, variant, card, "middle") : null;
  const bytes = file && (await readFile(file).catch(() => null));
  if (!bytes) return c.json(notFound, 404);
  // the same address shows other cards after Make cards again
  return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
});

/** 👍: the card's middle still, as the Mac drew it, goes into the style's Made & liked. This is the only way an animation style's picture becomes `made`. */
cardsApp.post("/:id/cards/:variant/:card/like", async (c) => {
  const { id, variant, card } = c.req.param();
  const user = c.get("user").username;
  const r = await load(user, id, variant);
  const still = r?.st.drawn.includes(card) ? cardFile(id, variant, card, "middle") : null;
  if (!r || !still) return c.json(notFound, 404);
  if (!r.st.liked.includes(card)) {
    const added = await addPicture(ownerOf(r.e), r.st.style, still, "made");
    if (!added) return c.json({ error: "The animation style of these cards was deleted", code: "not_found" }, 404);
    if (typeof added === "string") return c.json({ error: added, code: "invalid" }, 400);
    // read again: the step may have written since
    const now = readCards(id, variant) ?? r.st;
    await saveCards(id, variant, { ...now, liked: [...now.liked, card] });
  }
  return c.json(viewOf(r.e));
});

/** Make cards again: what the version had goes, the B-roll is laid again (a cutaway a card had covered comes back) and the cards are made from nothing. */
cardsApp.post("/:id/cards/:variant/again", async (c) => {
  const { id, variant } = c.req.param();
  const e = readEdit(id);
  if (!e || !(await editRole(c.get("user").username, e)) || !(await seesEdit(c.get("user").username, e)) || !e.style?.animation || !readDraft(id, variant)) return c.json(notFound, 404);
  const db = libraryDb();
  const vid = `${id}:${variant}`;
  if (db.prepare("SELECT 1 FROM edit_jobs WHERE version_id = ? AND state IN ('queued', 'running')").get(vid)) {
    return c.json({ error: "This version is still being made", code: "conflict" }, 409);
  }
  withdraw(db, vid);
  await clearCards(id, variant);
  enqueueJob(db, e.workspaceId, vid, "broll", c.get("user").username, true, "edit_jobs");
  return c.json(viewOf(e));
});
