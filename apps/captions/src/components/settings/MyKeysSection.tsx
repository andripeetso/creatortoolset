import { useEffect, useState } from "react";
import type { MyKeyEnv, MyKeyView } from "@contracts/service-keys";
import { Card, ErrorRow, LoadingRow } from "./ui";
import { KeyRow } from "./KeyRow";
import type { ApiKeyRowId } from "./search";
import { msg } from "./helpers";

async function json<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}
export const getMyKeys = () => fetch("/api/my-keys").then((r) => json<MyKeyView[]>(r));
export const saveMyKey = (name: MyKeyEnv, value: string | null) =>
  fetch(`/api/my-keys/${name}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) }).then((r) => json(r));

/**
 * The person's own keys as rows in one card. The API keys page composes its sections from the same rows; the setup
 * dialog shows only the keys one tool needs (`only`).
 */
export function MyKeysSection({ only }: { only?: MyKeyEnv[] } = {}) {
  const [keys, setKeys] = useState<MyKeyView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => getMyKeys().then(setKeys).catch((e) => setError(msg(e)));
  useEffect(() => void load(), []);
  if (!keys)
    return (
      <Card>
        {error ? <ErrorRow title="Couldn't load your keys" detail={error} retry={() => (setError(null), void load())} /> : <LoadingRow />}
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
            set={k.set || !!k.server}
            last4={k.last4}
            readOnly={!k.set && !!k.server}
            readOnlyText="From the server"
            save={(v) => saveMyKey(k.env, v).then(load)}
          />
        ))}
    </Card>
  );
}
