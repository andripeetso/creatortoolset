import { Hono } from "hono";
import type { AuthVars } from "../auth";
import { pluginUploadsTo } from "../lib/plugin";
import { sharedHere } from "../lib/workshop/workspace";
import { mayChange, mayUse, type SessionUser } from "../users";
import { askedWorkspace, ensureLibrary, librariesHere, mayAdd } from "./access";

/**
 * Where an upload from this request goes (owner, 2026-11-16: "Each workspace is its own client"). The server decides it
 * from the workspace the request works in; the caller never names a library. A plug-in may keep a workspace's uploads in
 * a store of its own (ServerPlugin.uploadsTo), or refuse the asker there. Every other workspace's go to that workspace's own
 * library, found or made as the Media Library page does. Refused: an account with the Media Library switched off, a
 * workspace this account can't see, and one where it may only look.
 */
export type UploadTarget = { target: string; libraryId?: string } | { error: string };

const NOT_YOURS = { error: "This account can't add footage to that workspace" };

export async function uploadTarget(user: SessionUser): Promise<UploadTarget> {
  if (user.role === "visitor" || !mayUse(user, "media") || (await askedWorkspace(user)) === null) return NOT_YOURS;
  const store = await pluginUploadsTo(user.username);
  if (typeof store === "object" && store) return store; // the plug-in's own refusal
  // the store's own login decides who sends there, as before; an account set to Read for the Media Library sends nothing
  if (store) return user.read?.includes("media") ? NOT_YOURS : { target: store };
  // a workspace the team's owner gave this person: the owner's library there, none made for them (GET /api/library)
  const libraryId = (await sharedHere(user)) ? (await librariesHere(user.username))[0]?.id : await ensureLibrary(user.username);
  if (!libraryId || !mayChange(user, "media") || !(await mayAdd(user, libraryId))) return NOT_YOURS;
  return { target: "library", libraryId };
}

// GET /api/upload-target → { target: "library" } | { target: <a plug-in's store> } | 403. Outside /api/library, whose tool
// gates answer first there: every refusal here is this answer's own (the Media Library switch is asked in uploadTarget).
export const uploadTargetApp = new Hono<{ Variables: AuthVars }>();
uploadTargetApp.get("/", async (c) => {
  const t = await uploadTarget(c.get("user"));
  return "error" in t ? c.json({ ...t, code: "forbidden" }, 403) : c.json({ target: t.target });
});
