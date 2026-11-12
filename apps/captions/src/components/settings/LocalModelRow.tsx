import { useEffect, useState } from "react";
import type { LocalModel } from "@contracts/service-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCachedLoad } from "@/lib/local-cache";
import { FormDialog, ListRow, RowMenu, Status } from "./ui";
import { msg } from "./helpers";

const ROUTE = "/api/my-keys/local-model";

async function json<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as T;
}
const getLocalModel = () => fetch(ROUTE).then((r) => json<Partial<LocalModel>>(r));
const saveLocalModel = (body: LocalModel | { url: null }) =>
  fetch(ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => json(r));
/** What the server at this address lists; none when it does not answer (the person types the name then). */
const modelsAt = (url: string) =>
  fetch(`${ROUTE}/models?url=${encodeURIComponent(url)}`)
    .then((r) => json<{ models: string[] }>(r))
    .then((j) => j.models, () => [] as string[]);

/**
 * Settings → API keys → AI: a model the person runs themselves (api/local-model.ts). The row shows the model and its
 * address; the dialog takes the address and the model's name, and lists what that address has so a name can be picked
 * instead of typed. Shown by ApiKeysSection only to an install's own admin; `ownAi` hides it, like the Anthropic key,
 * while the account has an AI of its own and no local model saved.
 */
export function LocalModelRow({ ownAi }: { ownAi: boolean }) {
  const { data, refresh } = useCachedLoad<Partial<LocalModel>>(ROUTE, getLocalModel, { own: true });
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [model, setModel] = useState("");
  const [listed, setListed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // the models at the typed address, asked once the typing pauses
  useEffect(() => {
    if (!open) return;
    const address = url.trim();
    if (!address) return setListed([]);
    let stale = false;
    const t = setTimeout(() => void modelsAt(address).then((m) => !stale && setListed(m)), 400);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [open, url]);

  if (!data || (ownAi && !data.url)) return null;
  const set = !!data.url;

  const show = () => {
    setUrl(data.url ?? "");
    setModel(data.model ?? "");
    setListed([]);
    setError(null);
    setOpen(true);
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveLocalModel({ url: url.trim(), model: model.trim() });
      await refresh();
      setOpen(false);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* no search id: the search index can't tell an install's own admin from everyone else, and a hit must land on a row */}
      <ListRow
        title="Local model"
        subtitle="A model you run yourself. The tools send it their text jobs, before your Anthropic key"
        status={set ? <Status>{data.url}</Status> : undefined}
        actions={
          set ? (
            <>
              <span className="max-w-40 truncate font-mono text-xs text-muted-foreground">{data.model}</span>
              <RowMenu
                label="Local model actions"
                items={[
                  { label: "Change", onSelect: show },
                  {
                    label: "Remove",
                    destructive: true,
                    confirm: { title: "Remove the local model?", body: "The tools stop sending their text jobs to it.", ok: "Remove" },
                    onSelect: async () => {
                      await saveLocalModel({ url: null });
                      await refresh();
                    },
                  },
                ]}
              />
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={show}>
              Connect
            </Button>
          )
        }
      />
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={set ? "Change the local model" : "Connect a local model"}
        submitLabel={set ? "Save" : "Connect"}
        onSubmit={submit}
        busy={busy}
        submitDisabled={!url.trim() || !model.trim()}
        error={error}
      >
        <div className="space-y-1.5">
          <label htmlFor="local-model-address" className="text-xs text-muted-foreground">
            Address
          </label>
          <Input id="local-model-address" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:11434" autoComplete="off" spellCheck={false} className="h-8 font-mono text-xs" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="local-model-name" className="text-xs text-muted-foreground">
            Model
          </label>
          <Input id="local-model-name" value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" spellCheck={false} className="h-8 font-mono text-xs" />
          {listed.length > 0 && (
            <div data-local-models className="flex max-h-44 flex-col gap-1.5 overflow-y-auto [scrollbar-gutter:stable]">
              {listed.map((m) => (
                <Button key={m} type="button" variant={model.trim() === m ? "secondary" : "outline"} size="sm" className="shrink-0 justify-start font-normal" onClick={() => setModel(m)}>
                  <span className="truncate font-mono text-xs">{m}</span>
                </Button>
              ))}
            </div>
          )}
        </div>
      </FormDialog>
    </>
  );
}
