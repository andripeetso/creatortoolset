import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { cachedUsage, clearAccountCache } from "@/lib/local-cache";
import { warmScreens } from "@/lib/warm-cache";
import { Card, Group, Row } from "./ui";

const size = (chars: number) =>
  chars >= 1048576 ? `${(chars / 1048576).toFixed(1)} MB` : chars >= 1024 ? `${Math.round(chars / 1024)} KB` : `${chars} B`;

/** Settings → Cache: the lists this app keeps on this computer so screens paint at once. Warm now fills them again;
 *  Clear drops them. Neither signs you out or touches your projects. */
export function StorageSection() {
  const me = useAuth((s) => s.me);
  const [usage, setUsage] = useState(() => cachedUsage(me?.username));
  const [busy, setBusy] = useState(false);

  const measure = useCallback(() => setUsage(cachedUsage(useAuth.getState().me?.username)), []);
  useEffect(() => measure(), [measure, me]);

  return (
    <Group title="Saved on this computer" hint="Lists kept here so each screen shows before the server answers.">
      <Card>
        <Row label="Lists" hint={usage.items ? `${usage.items} saved, ${size(usage.bytes)}` : "Nothing saved yet."}>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !me}
            onClick={async () => {
              setBusy(true);
              await warmScreens().catch(() => {});
              setBusy(false);
              measure();
            }}
          >
            Warm now
          </Button>
        </Row>
        <Row label="Clear" hint="Clears this account's saved lists only. Screens fetch again the next time you open them.">
          <Button
            size="sm"
            variant="outline"
            disabled={!usage.items}
            onClick={() => {
              clearAccountCache(me?.username);
              measure();
            }}
          >
            Clear
          </Button>
        </Row>
      </Card>
    </Group>
  );
}
