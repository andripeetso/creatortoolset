import type { FootageTarget } from "../../contracts/editor";
import { librariesHere, libraryRole } from "../library/access";
import { libraryDb } from "../library/db";
import { smartFolder } from "../library/organize";
import { pluginFootageTarget } from "../lib/plugin";

/** The folder footage picked from this computer is filed in: the talking takes an edit is built on (A-roll). */
export const A_ROLL = "A-roll";
/** It lists every clip sorted or filed as A-roll (library/roll.ts); a clip uploaded into it is filed as A-roll. */
const A_ROLL_QUERY = JSON.stringify({ roll: "a" });

/**
 * Where footage added to an edit from outside the library is filed: a plug-in's target when one answers (editor.ingest),
 * else the workspace's own library's A-roll folder (a smart folder over the clips' roll), made on first use. Null when the account has no library it may write to.
 */
export async function footageTargetFor(username: string): Promise<FootageTarget | null> {
  const plugin = await pluginFootageTarget(username);
  if (plugin) return plugin;
  const lib = (await librariesHere(username))[0]; // the workspace this request works in
  if (!lib || !libraryRole(username, lib.id)) return null;
  return { libraryId: lib.id, collectionId: smartFolder(libraryDb(), lib.id, A_ROLL, A_ROLL_QUERY, username) };
}
