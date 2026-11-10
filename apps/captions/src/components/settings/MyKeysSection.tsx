import type { MyKeyEnv, MyKeyView } from "@contracts/service-keys";
import { useCachedLoad } from "@/lib/local-cache";
import { Card, ErrorRow, LoadingRow } from "./ui";
import { KeyRow } from "./KeyRow";
import type { ApiKeyRowId } from "./search";

async function json<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}
export const getMyKeys = () => fetch("/api/my-keys").then((r) => json<MyKeyView[]>(r));
/** The person's keys as the server lists them (set or not, the last 4 characters, never a key): the saved copy at once. */
export const useMyKeys = () => useCachedLoad<MyKeyView[]>("/api/my-keys", getMyKeys);
export const saveMyKey = (name: MyKeyEnv, value: string | null) =>
  fetch(`/api/my-keys/${name}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) }).then((r) => json(r));

/**
 * The person's own keys as rows in one card. The API keys page composes its sections from the same rows; the setup
 * dialog shows only the keys one tool needs (`only`).
 */
export function MyKeysSection({ only }: { only?: MyKeyEnv[] } = {}) {
  const { data: keys, error, refresh } = useMyKeys();
  const load = () => refresh().catch(() => {});
  if (!keys)
    return (
      <Card>
        {error ? <ErrorRow title="Couldn't load your keys" detail={error} retry={() => void load()} /> : <LoadingRow />}
      </Card>
    );
  return (
    <Card>
      {keys
        .filter((k) => !only || only.includes(k.env))
        .map((k) => (
          <KeyRow
            key={k.env}
            id={`api-key-${k.env}` as ApiKeyRowId}
            name={k.name}
            subtitle={k.what}
            where={k.where}
            set={k.set}
            last4={k.last4}
            served={k.server}
            save={(v) => saveMyKey(k.env, v).then(load)}
          />
        ))}
    </Card>
  );
}
