import { useCallback, useEffect, useState } from "react";
import { getInstagramAvailability, type InstagramAvailability } from "@/lib/instagram";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { SessionCard } from "./SessionCard";

/** Fired after the connection changes, so an open Analyzer page re-reads it. */
export const INSTAGRAM_CONNECTION_EVENT = "instagram-connection";

/** Account settings: how the Content Analyzer reads Instagram (Apify or burner cookies). */
export function InstagramConnectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [availability, setAvailability] = useState<InstagramAvailability | null>(null);
  const load = useCallback(() => {
    getInstagramAvailability()
      .then(setAvailability)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Instagram connection</DialogTitle>
          <DialogDescription>
            How the Content Analyzer reads posts and profiles: your own Apify token or a
            burner account's cookies. Yours only, never shared with other accounts.
          </DialogDescription>
        </DialogHeader>
        <SessionCard
          inDialog
          availability={availability}
          onChange={() => {
            load();
            window.dispatchEvent(new Event(INSTAGRAM_CONNECTION_EVENT));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
