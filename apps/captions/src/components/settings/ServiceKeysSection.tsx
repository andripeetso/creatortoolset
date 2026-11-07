import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { ServiceKeyEnv, ServiceKeyView } from "@contracts/service-keys";
import { Button } from "@/components/ui/button";
import { Card, Group, Loading, Notice, Row } from "./ui";

async function json<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}
const getKeys = () => fetch("/api/service-keys").then((r) => json<ServiceKeyView[]>(r));
const putKey = (name: ServiceKeyEnv, value: string | null) =>
  fetch(`/api/service-keys/${name}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) }).then((r) => json(r));

/**
 * Settings → API keys: every outside service the
 * tools call, what it unlocks, where to get a key. A pasted key wins over the server's .env; Forget puts the .env's back.
 */
export function ServiceKeysSection() {
  const [keys, setKeys] = useState<ServiceKeyView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => getKeys().then(setKeys).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => void load(), []);
  const run = (p: Promise<unknown>) => p.then(load).catch((e) => setError(String(e.message ?? e)));
  if (!keys) return error ? <Notice tone="error">{error}</Notice> : <Loading />;
  return (
    <Group title="API keys" hint="The server's own keys: they serve you (the platform admin), members a workspace owner gave an API budget (AI and transcripts, billed to that budget), and guests and the demo when switched on in Server. Everyone else uses their own keys from Settings → My API keys.">
      <Card>
        {keys.map((k) => (
          <KeyRow
            key={k.env}
            k={k}
            status={k.source === "settings" ? `Saved here · …${k.last4}` : k.source === "server" ? `From the server's .env · …${k.last4}` : "Not set"}
            on={!!k.source}
            canForget={k.source === "settings"}
            save={(v) => run(putKey(k.env, v))}
          />
        ))}
      </Card>
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
    </Group>
  );
}

/** One key: what it unlocks, where to get one, its status (never the key), paste to save, Forget. */
export function KeyRow({ k, status, on, canForget, save }: { k: { name: string; what: string; where?: string }; status: string; on: boolean; canForget: boolean; save: (value: string | null) => Promise<unknown> }) {
  const [value, setValue] = useState("");
  return (
    <Row
      label={
        <span className="flex items-center gap-2">
          {k.name}
          <span className={`text-xs ${on ? "text-emerald-400" : "text-amber-400"}`}>{status}</span>
        </span>
      }
      hint={
        <>
          {k.what}{" "}
          {k.where && (
            <a href={k.where} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline">
              Get a key <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </>
      }
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void save(value.trim()).then(() => setValue(""));
        }}
      >
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={canForget ? "Replace key" : "Paste key"}
          aria-label={`${k.name} API key`}
          className="h-7 w-40 rounded-md border border-border bg-transparent px-2 text-xs outline-none focus:border-ring"
        />
        <Button type="submit" size="sm" variant="outline" className="h-7 text-xs" disabled={!value.trim()}>
          Save
        </Button>
        {canForget && (
          <Button type="button" size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => void save(null)}>
            Forget
          </Button>
        )}
      </form>
    </Row>
  );
}
