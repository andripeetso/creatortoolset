import type { LibraryViewer } from "../../contracts/library-source";
import { givenLibrary, libraryRole } from "./access";

/**
 * Who reads the library: whoever libraryRole names (its owner), or a member the owner gave its workspace (givenLibrary,
 * Settings → Team), who sees all of it. The read routes ask here; every write asks libraryRole, so a given member writes nothing.
 */
export async function readerOf(username: string, libraryId: string): Promise<LibraryViewer | null> {
  const role = libraryRole(username, libraryId);
  if (role) return { username, role };
  return (await givenLibrary(username, libraryId)) ? { username, role: "member", given: true } : null;
}
