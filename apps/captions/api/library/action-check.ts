import { actionCard, type ActionAsk, type ActionNeeded } from "../../contracts/library";
import { folderIn } from "../../contracts/storage";
import { deviceByHost, deviceOf } from "../lib/devices";
import { ensureUseFolder, storageOf } from "../devices-storage";
import { offlineOf } from "../work/offline";
import { setupNeeded } from "./access";

/** The ask of a card, without what its card said. */
const askOf = ({ title: _t, line: _l, actions: _a, missing: _m, ...ask }: ActionNeeded): ActionAsk => ask as ActionAsk;

/**
 * A card asked again (its Retry, GET /api/assistant/action/:id): the card as it stands now, or null once its goal is
 * reached. A computer it could not find is looked for again by the name it had; found, its folder is asked for there.
 */
export async function recheckAction(username: string, a: ActionNeeded): Promise<ActionNeeded | null> {
  if (a.kind === "setup") return setupNeeded(username, a.workspace || undefined);
  if (a.kind === "downloads") return (offlineOf(username).downloads?.[a.libraryId]?.mode ?? "none") === "none" ? a : null;
  const role = a.kind === "projects" ? "projects" : "library";
  // shortcut: only the asker's own computers are looked for by name; a team worker's computer stays missing until its next claim
  const d = a.device ? deviceOf(a.device) : a.deviceName ? deviceByHost(username, a.deviceName) : undefined;
  if (!d) return actionCard(askOf(a));
  if (a.device) {
    const has = (await storageOf(username)).folders.some((f) => f.role === role && f.origin.host === d.id && folderIn(f, (w) => w === a.workspace));
    return has ? null : actionCard(askOf(a));
  }
  const r = await ensureUseFolder(username, a.workspace, role, d.id);
  return "wait" in r ? r.wait : "error" in r ? actionCard(askOf(a)) : null;
}
