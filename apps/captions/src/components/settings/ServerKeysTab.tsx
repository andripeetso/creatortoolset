import type { ServiceKeyEnv, ServiceKeyView } from "@contracts/service-keys";
import { hasTeam, useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { Switch } from "@/components/ui/switch";
import { Card, ErrorRow, LoadingRow, Row, Section, saveFailed } from "./ui";
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
const getTeamUse = () => fetch("/api/service-keys/team-use").then((r) => json<{ on: boolean }>(r));
const saveTeamUse = (on: boolean) =>
  fetch("/api/service-keys/team-use", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) }).then((r) => json(r));

/**
 * Settings → API keys → Server keys: the server's own keys. They serve an admin who has no key of their own, nobody
 * else unless Team use (the last row) is on (serverKeyOf, api/my-keys.ts). A key in the server's .env is shown read-only; one pasted here is shown masked
 * and can be changed or removed (the .env's key applies again). Hidden on an own-computer install, where the .env is
 * the only place.
 */
export function ServerKeysTab() {
  const teamHere = useAuth((s) => hasTeam(s.kind));
  // where each key is set and its last 4 characters, never a key
  const { data: keys, error, refresh } = useCachedLoad<ServiceKeyView[]>(teamHere ? "/api/service-keys" : null, getServerKeys, { own: true });
  const load = () => refresh().catch(() => {});
  const team = useCachedLoad<{ on: boolean }>(teamHere ? "/api/service-keys/team-use" : null, getTeamUse, { own: true });
  if (!teamHere) return null;
  if (!keys)
    return (
      <Section title="Server keys">
        <Card>{error ? <ErrorRow title="Could not load server keys" detail={error} retry={() => void load()} /> : <LoadingRow />}</Card>
      </Section>
    );
  return (
    <Section id="server-keys" title="Server keys">
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
            removeBody="The key in the server's settings file (.env) applies again."
            save={(v) => saveServerKey(k.env, v).then(load)}
          />
        ))}
        <Row
          title="Team use"
          description="Your team uses these keys, and team budgets run on the Anthropic key."
          control={
            <Switch
              checked={!!team.data?.on}
              disabled={!team.data}
              aria-label="Team use"
              onCheckedChange={(on) =>
                void saveTeamUse(on)
                  .then(() => team.refresh())
                  .catch(() => saveFailed("Could not save Team use"))
              }
            />
          }
        />
      </Card>
    </Section>
  );
}
