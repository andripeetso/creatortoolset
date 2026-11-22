import { useEffect, useState } from "react";
import type { LocalModel } from "@contracts/service-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { useSetup } from "@/lib/setup";
import { Card, FormDialog, ListRow, Row, RowMenu, Status } from "./ui";
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
 * Settings → Providers: a model the person runs themselves (api/local-model.ts), in a card of its own under the
 * provider list. The row shows the model and its address; the dialog takes the address and the model's name, and lists
 * what that address has so a name can be picked instead of typed. Only an install's own admin gets it (a hosted server
 * refuses its routes); like the Anthropic key, it is hidden while the account has an AI provider and no local model
 * saved (until the setup is known, too).
 */
export function LocalModelRow() {
  const mine = useAuth((s) => s.kind !== "cloud" && s.me?.role === "admin");
  const ownAi = useSetup((s) => s.view?.have.includes("ownAi") ?? true);
  const { data, refresh } = useCachedLoad<Partial<LocalModel>>(mine ? ROUTE : null, getLocalModel, { own: true });
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

  if (!mine || !data || (ownAi && !data.url)) return null;
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

  // the two fields are one width, so their left edges line up
  const input = "h-8 w-full font-mono text-xs sm:w-64";
  return (
    <>
      <Card>
        {/* no search id: the search index can't tell an install's own admin from everyone else, and a hit must land on a row */}
        <ListRow
          title="Local model"
          subtitle="Used by the tools before the Anthropic API key."
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
                      confirm: { title: "Remove the local model?", body: "The tools stop using it.", ok: "Remove" },
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
                Add
              </Button>
            )
          }
        />
      </Card>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={set ? "Change local model" : "Add local model"}
        submitLabel={set ? "Save" : "Add"}
        onSubmit={submit}
        busy={busy}
        error={error}
      >
        <Row className="p-0 sm:p-0" title="Address" control={<Input aria-label="Address" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:11434" required autoComplete="off" spellCheck={false} className={input} />} />
        <Row className="p-0 sm:p-0" title="Model" control={<Input aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} required autoComplete="off" spellCheck={false} className={input} />}>
          {listed.length > 0 && (
            <div data-local-models className="flex max-h-44 flex-col gap-1.5 overflow-y-auto [scrollbar-gutter:stable]">
              {listed.map((m) => (
                <Button key={m} type="button" variant={model.trim() === m ? "secondary" : "outline"} size="sm" className="shrink-0 justify-start font-normal" onClick={() => setModel(m)}>
                  <span className="truncate font-mono text-xs">{m}</span>
                </Button>
              ))}
            </div>
          )}
        </Row>
      </FormDialog>
    </>
  );
}
