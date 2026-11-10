import { useEffect, useState } from "react";
import type { ServiceKeyEnv, ServiceKeyView } from "@contracts/service-keys";
import { useAuth } from "@/lib/auth";
import { Card, ErrorRow, LoadingRow, Section } from "./ui";
import { KeyRow } from "./KeyRow";
import type { ServerKeyRowId } from "./search";
import { msg } from "./helpers";

async function json<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}
const getServerKeys = () => fetch("/api/service-keys").then((r) => json<ServiceKeyView[]>(r));
const saveServerKey = (name: ServiceKeyEnv, value: string | null) =>
  fetch(`/api/service-keys/${name}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) }).then((r) => json(r));

/**
 * Admin → Server keys: the fallback keys for everyone on this server who has no key of their own. A key in the server's
 * .env is shown read-only ("Set in .env"); one pasted here is shown masked and can be replaced or removed (the .env's
 * key applies again). Hidden on an own-computer install, where the .env is the only place.
 */
export function ServerKeysTab() {
  const hosted = useAuth((s) => s.hosted);
  const [keys, setKeys] = useState<ServiceKeyView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => getServerKeys().then(setKeys).catch((e) => setError(msg(e)));
  useEffect(() => {
    if (hosted) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosted]);
  if (!hosted) return null;
  if (!keys)
    return (
      <Section title="Fallback keys">
        <Card>{error ? <ErrorRow title="Couldn't load the server keys" detail={error} retry={() => (setError(null), void load())} /> : <LoadingRow />}</Card>
      </Section>
    );
  return (
    <Section id="server-keys" title="Fallback keys">
      <Card>
        {keys.map((k) => (
          <KeyRow
            key={k.env}
            id={`server-key-${k.env}` as ServerKeyRowId}
            name={k.name}
            subtitle={k.what}
            where={k.where}
            set={!!k.source}
            last4={k.last4}
            readOnly={k.source === "server"}
            removeBody="The server's .env key applies again, or none if there is none."
            save={(v) => saveServerKey(k.env, v).then(load)}
          />
        ))}
      </Card>
    </Section>
  );
}
