import { Hono } from "hono";
import type { AuthVars } from "../auth";
import { findUser } from "../users";
import { libraryRole } from "./access";
import { libraryDb } from "./db";

/**
 * Per-collection grants (library_grants): the library's owner shares one collection with an account. A granted
 * account sees the assets of that collection through the built-in policy (sources.ts). No grant, no access: the
 * default stays owner-only. The grant does not make a member a library member: libraryRole still decides that.
 */

/** Whether the account holds a grant on any collection that contains the asset. */
export const grantedTo = (username: string, assetId: string): boolean =>
  !!libraryDb()
    .prepare(
      "SELECT 1 FROM library_grants g JOIN collection_items i ON i.collection_id = g.collection_id WHERE g.username = ? AND i.asset_id = ? LIMIT 1",
    )
    .get(username, assetId);

export const grantsOf = (collectionId: string): string[] =>
  (libraryDb().prepare("SELECT username FROM library_grants WHERE collection_id = ? ORDER BY username").all(collectionId) as { username: string }[]).map(
    (r) => r.username,
  );

/** An account was deleted: its grants go with it. */
export function forgetGrants(username: string): void {
  libraryDb().prepare("DELETE FROM library_grants WHERE username = ?").run(username);
}

/** The collection's library, when the account owns that library; else null (answered as 404, like every library route). */
function ownedCollection(username: string, collectionId: string): { library_id: string } | null {
  const row = libraryDb().prepare("SELECT library_id FROM collections WHERE id = ?").get(collectionId) as { library_id: string } | undefined;
  return row && libraryRole(username, row.library_id) === "owner" ? row : null;
}

export const grantsApp = new Hono<{ Variables: AuthVars }>();

grantsApp.get("/collections/:id/grants", (c) => {
  const id = c.req.param("id");
  if (!ownedCollection(c.get("user").username, id)) return c.json({ error: "Not found", code: "not_found" }, 404);
  return c.json({ grants: grantsOf(id) });
});

grantsApp.put("/collections/:id/grants/:username", (c) => {
  const id = c.req.param("id");
  if (!ownedCollection(c.get("user").username, id)) return c.json({ error: "Not found", code: "not_found" }, 404);
  const target = findUser(c.req.param("username"));
  if (!target) return c.json({ error: "No such account" }, 404);
  libraryDb()
    .prepare("INSERT OR IGNORE INTO library_grants (collection_id, username, granted_by, created_at) VALUES (?, ?, ?, ?)")
    .run(id, target.username, c.get("user").username, Date.now());
  return c.json({ grants: grantsOf(id) });
});

grantsApp.delete("/collections/:id/grants/:username", (c) => {
  const id = c.req.param("id");
  if (!ownedCollection(c.get("user").username, id)) return c.json({ error: "Not found", code: "not_found" }, 404);
  libraryDb().prepare("DELETE FROM library_grants WHERE collection_id = ? AND username = ?").run(id, c.req.param("username"));
  return c.json({ grants: grantsOf(id) });
});
