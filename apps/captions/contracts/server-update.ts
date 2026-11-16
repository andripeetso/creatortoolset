/** What Settings → Storage → Update shows an admin about updating this server (api/server-update.ts). */
export type ServerUpdateView =
  | { available: false }
  | {
      available: true;
      /** Changes waiting. 0 = up to date. */
      behind: number;
      /** When the next nightly update is due (seconds since 1970), when the server has one. The hour is the same each night. */
      nightly: number | null;
      /** An update is asked for and not finished. */
      requested: boolean;
      /** The last update did not finish. */
      failed: boolean;
    };
