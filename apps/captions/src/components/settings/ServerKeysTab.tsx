import type { ServiceKeyEnv, ServiceKeyView } from "@contracts/service-keys";
import { useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { Card, ErrorRow, LoadingRow, Section } from "./ui";
import { KeyRow } from "./KeyRow";
import type { ServerKeyRowId } from "./search";

async function json<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}
const getServerKeys = () => fetch("/api/service-keys").then((r) => json<ServiceKeyView[]>(r));
const saveServerKey = (name: ServiceKeyEnv, value: string | null) =>
  fetch(`/api/service-keys/${name}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) }).then((r) => json(r));

/**
 * Admin → Server keys: the server's own keys. They serve an admin who has no key of their own, nobody else
 * (serverKeyOf, api/my-keys.ts). A key in the server's
 * .env is shown read-only ("Set in .env"); one pasted here is shown masked and can be replaced or removed (the .env's
 * key applies again). Hidden on an own-computer install, where the .env is the only place.
 */
export function ServerKeysTab() {
  const hosted = useAuth((s) => s.hosted);
  // where each key is set and its last 4 characters, never a key
  const { data: keys, error, refresh } = useCachedLoad<ServiceKeyView[]>(hosted ? "/api/service-keys" : null, getServerKeys);
  const load = () => refresh().catch(() => {});
  if (!hosted) return null;
  if (!keys)
    return (
      <Section title="Fallback keys">
        <Card>{error ? <ErrorRow title="Couldn't load the server keys" detail={error} retry={() => void load()} /> : <LoadingRow />}</Card>
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
