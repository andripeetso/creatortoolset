import type { InstalledPack } from "@contracts/packs";
import { useCallback, useEffect, useState } from "react";
import type { CatalogEntry, UpdateRow } from "@contracts/pack-catalog";
import { browseCatalog, catalogUpdates } from "@/lib/pack-catalog";
import { msg } from "../settings/helpers";
import { listInstalled } from "./packs-api";
/** The catalog, the account's installed packs and the waiting updates, loaded once for the whole window. */
export function useCommunityData() {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [installed, setInstalled] = useState<InstalledPack[] | null>(null);
  const [updates, setUpdates] = useState<UpdateRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  // Separately, so a server with the catalog off still lists what's installed. The updates check is best effort
  // (without it there are simply no update marks); it also marks delisted packs on this account, so the installed
  // list is read after it.
  const reload = useCallback(
    () =>
      Promise.all([
        browseCatalog().then(
          (c) => (setCatalog(c), setCatalogError(null)),
          (e) => setCatalogError(msg(e)),
        ),
        catalogUpdates()
          .catch(() => [] as UpdateRow[])
          .then(async (u) => {
            setUpdates(u);
            setInstalled(await listInstalled());
            setError(null);
          })
          .catch((e) => setError(msg(e))),
      ]).then(() => undefined),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { catalog, catalogError, installed, updates, error, reload };
}
