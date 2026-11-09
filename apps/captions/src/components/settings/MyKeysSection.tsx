import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { MyKeyEnv, MyKeyView } from "@contracts/service-keys";
import { Card, Group, Loading, Notice } from "./ui";
import { KeyRow } from "./ServiceKeysSection";

async function json<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}
const getKeys = () => fetch("/api/my-keys").then((r) => json<MyKeyView[]>(r));
const putKey = (name: MyKeyEnv, value: string | null) =>
  fetch(`/api/my-keys/${name}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) }).then((r) => json(r));

const SERVER = { admin: "The server's key serves you (platform admin)" } as const;

/**
 * Settings → API keys, your part: this account's own keys for the paid services. Each one is billed by its provider to
 * the person whose key it is; the tools that need one say which to add here.
 */
export function MyKeysSection({ only }: { only?: MyKeyEnv[] } = {}) {
  const [keys, setKeys] = useState<MyKeyView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => getKeys().then(setKeys).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => void load(), []);
  const run = (p: Promise<unknown>) => p.then(load).catch((e) => setError(String(e.message ?? e)));
  if (!keys) return error ? <Notice tone="error">{error}</Notice> : <Loading />;
  const rows = (
    <Card>
      {keys
        .filter((k) => !only || only.includes(k.env))
        .map((k) => (
          <KeyRow
            key={k.env}
            k={k}
            status={k.set ? `Yours · …${k.last4}` : k.server ? SERVER[k.server] : "Not set"}
            on={k.set || !!k.server}
            canForget={k.set}
            save={(v) => run(putKey(k.env, v))}
          />
        ))}
    </Card>
  );
  // the setup dialog shows a few rows in place, with its own words around them
  if (only)
    return (
      <>
        {rows}
        {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
      </>
    );
  return (
    <Group
      title="Your keys"
      hint="Your own keys for the services the tools call. The cost is yours, paid to that service: this site never pays for them and never shares a key with anyone else. A tool without the key it needs says which one to add."
    >
      {rows}
      <p className="mt-2 text-xs text-muted-foreground">
        Reading other creators' Instagram posts uses your own Apify key, in{" "}
        <Link to="/settings/connectors" replace className="underline">
          Settings → Connectors
        </Link>
        . AI runs on your own Claude or ChatGPT login in{" "}
        <Link to="/settings/providers" replace className="underline">
          Settings → Providers
        </Link>
        ; the Anthropic key here is for when you have none.
      </p>
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
    </Group>
  );
}
