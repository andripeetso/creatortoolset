import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { ServiceKeyEnv, ServiceKeyView } from "@contracts/service-keys";
import { Button } from "@/components/ui/button";
import { Card, Loading, Notice, Row } from "./ui";

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
    <>
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
    </>
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
          <span className={`text-xs ${on ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>{status}</span>
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
          className="h-8 w-40 rounded-md border border-input bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-violet-500 focus:outline-none"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!value.trim()}>
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
