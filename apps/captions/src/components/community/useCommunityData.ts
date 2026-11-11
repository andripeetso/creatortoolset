import type { InstalledPack } from "@contracts/packs";
import { useCallback, useEffect, useState } from "react";
import type { CatalogEntry, UpdateRow } from "@contracts/pack-catalog";
import { useCachedLoad } from "@/lib/local-cache";
import { browseCatalog, catalogUpdates, json } from "@/lib/pack-catalog";
import type { ServerPluginInfo } from "@/lib/plugin";
import type { FolderPlugins } from "@/lib/folder-plugins";
import { listInstalled } from "./packs-api";
/**
 * The catalog, the account's installed packs and the waiting updates, for the whole window: each is its saved copy at
 * once, read again when the window opens and when a pack is installed, updated or removed (here or in another window).
 */
export function useCommunityData() {
  // Separately from the account's packs, so a server with the catalog off still lists what's installed.
  const catalog = useCachedLoad<CatalogEntry[]>("/api/pack-catalog/public", () => browseCatalog(), { own: true });
  // The updates check is best effort (without it there are simply no update marks); it also marks delisted packs on this
  // account, so the installed list is read after it: the two are one saved value.
  const mine = useCachedLoad<{ updates: UpdateRow[]; installed: InstalledPack[] }>(
    "community/mine",
    async () => {
      const updates = await catalogUpdates().catch(() => [] as UpdateRow[]);
      return { updates, installed: await listInstalled() };
    },
    // own: a switch flipped while the list is still being read is read again after it, not answered by that older read
    { topic: ["packs", "pack-catalog"], own: true },
  );
  // The server's plug-ins (api/lib/plugin.ts describeServerPlugins). Best effort: without it the web half still lists.
  const plugins = useCachedLoad<ServerPluginInfo[]>("/api/plugins", () =>
    fetch("/api/plugins")
      .then((r) => json<{ plugins: ServerPluginInfo[] }>(r))
      .then((j) => j.plugins),
  );
  // The plug-ins in the person's own folder, on the Mac app's server (api/lib/folder-plugins.ts). Nothing anywhere else.
  // Never a saved copy: a row's switch shows what the server runs now.
  const [folderPlugins, setFolderPlugins] = useState<FolderPlugins | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/plugins/folder")
      .then((r) => json<FolderPlugins>(r))
      .then((j) => live && setFolderPlugins(j))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const refreshCatalog = catalog.refresh;
  const refreshMine = mine.refresh;
  const reload = useCallback(() => Promise.all([refreshCatalog().catch(() => {}), refreshMine().catch(() => {})]).then(() => undefined), [refreshCatalog, refreshMine]);
  return {
    catalog: catalog.data,
    catalogError: catalog.data ? null : catalog.error || null,
    installed: mine.data?.installed ?? null,
    updates: mine.data?.updates ?? [],
    error: mine.data ? null : mine.error || null,
    reload,
    serverPlugins: plugins.data ?? [],
    folderPlugins,
  };
}
