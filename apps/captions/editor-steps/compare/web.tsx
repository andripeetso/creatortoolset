import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Scale } from "lucide-react";
import type { ProvidersView, Selection } from "@contracts/providers";
import { AppBar } from "@/components/AppBar";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Card, EmptyRow, ListRow, Section, SettingsSelect } from "@/components/settings/ui";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCachedLoad } from "@/lib/local-cache";
import { activeSet, effectiveSelection, effortLabel, getProviders, modelName, modelsOf } from "@/lib/providers";
import { DRAFT_KINDS, draftKindLabel, type DraftKind } from "@/lib/workshop";
import { defineWebPlugin } from "../../src/lib/plugin";

const API = "/api/x/compare";

/** GET/POST /api/x/compare/sessions/:id (plugin.ts view): `ai` is there only once the compare is decided. */
interface CompareView {
  sessionId: string;
  picked: "A" | "B" | "neither" | null;
  sides: Array<{ label: "A" | "B"; status: "writing" | "ready" | "error"; markdown?: string; error?: string; ai?: { name: string; model: string; effort: Selection["effort"] } }>;
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as T;
}

/** The AIs the Workshop answers this person with, one per model (as the session's model chip lists them). */
function aisOf(view: ProvidersView | null): Array<{ value: string; label: string; ai: Selection }> {
  const active = view && activeSet(view);
  if (!view || !active) return [];
  return active.settings.instances
    .filter((i) => i.enabled)
    .flatMap((inst) => {
      const models = modelsOf(view, inst);
      const { effort } = effectiveSelection(active.settings, inst, models);
      return models.map((model) => ({ value: `${inst.id}\n${model}`, label: `${inst.name} · ${modelName(model)}`, ai: { instance: inst.id, model, effort } }));
    });
}

const aiName = (ai: { name: string; model: string; effort: Selection["effort"] }) => `${ai.name} · ${modelName(ai.model)} · ${effortLabel(ai.effort)}`;

function ComparePage() {
  const { sessionId = "" } = useParams();
  const url = `${API}/sessions/${sessionId}`;
  const load = useCachedLoad<{ compare: CompareView | null }>(url, () => call(url));
  const [providers, setProviders] = useState<ProvidersView | null>(null);
  useEffect(() => void getProviders().then(setProviders).catch(() => setProviders(null)), []);
  const ais = useMemo(() => aisOf(providers), [providers]);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [kind, setKind] = useState<DraftKind>("reel");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = a || ais[0]?.value || "";
  const second = b || ais.find((x) => x.value !== first)?.value || "";
  const cmp = load.data?.compare ?? null;
  const writing = !!cmp && !cmp.picked && cmp.sides.some((s) => s.status === "writing");

  const act = async (fn: () => Promise<{ compare: CompareView }>) => {
    setBusy(true);
    setError("");
    try {
      load.set({ compare: (await fn()).compare });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    act(() => call(url, { a: ais.find((x) => x.value === first)?.ai, b: ais.find((x) => x.value === second)?.ai, kind, prompt: brief }));
  const pick = (side: "A" | "B" | null) => act(() => call(`${url}/pick`, { side }));

  return (
    <>
      <AppBar tool="Compare" trail={<Link to={`/workshop/sessions/${sessionId}`} className="text-muted-foreground hover:text-foreground">Session</Link>} />
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6">
        {(!cmp || cmp.picked) && (
          <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <SettingsSelect label="First AI" value={first} onValueChange={setA} options={ais} />
              <SettingsSelect label="Second AI" value={second} onValueChange={setB} options={ais} />
              <SettingsSelect label="What to write" value={kind} onValueChange={(k) => setKind(k as DraftKind)} options={DRAFT_KINDS.map((k) => ({ value: k.id, label: k.label }))} />
            </div>
            <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Brief" rows={3} />
            <div className="flex items-center gap-3">
              <Button onClick={() => void start()} disabled={busy || !first || !second || first === second}>
                Compare
              </Button>
              {error && <span className="text-sm text-destructive">{error}</span>}
            </div>
          </div>
        )}
        {cmp && (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              {cmp.sides.map((s) => (
                <section key={s.label} className={`flex min-w-0 flex-col rounded-xl border bg-card/40 ${cmp.picked === s.label ? "border-foreground/40" : "border-border/60"}`}>
                  <header className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2.5">
                    <span className="text-sm font-semibold">{s.label}</span>
                    {s.ai && <span className="truncate text-xs text-muted-foreground">{aiName(s.ai)}{cmp.picked === s.label ? " · picked" : ""}</span>}
                  </header>
                  <div className="min-h-40 px-4 py-3">
                    {s.status === "writing" && <p className="text-sm text-muted-foreground">Writing…</p>}
                    {s.error && <p className="text-sm text-destructive">{s.error}</p>}
                    {s.markdown && <MarkdownBody source={s.markdown} media={false} />}
                  </div>
                  {!cmp.picked && (
                    <footer className="border-t border-border/50 px-4 py-2.5">
                      <Button size="sm" onClick={() => void pick(s.label)} disabled={busy || writing || s.status !== "ready"}>
                        Pick {s.label}
                      </Button>
                    </footer>
                  )}
                </section>
              ))}
            </div>
            {!cmp.picked ? (
              <div className="flex items-center gap-3">
                <Button variant="outline" onClick={() => void pick(null)} disabled={busy || writing}>
                  Neither
                </Button>
                {error && <span className="text-sm text-destructive">{error}</span>}
              </div>
            ) : (
              cmp.picked !== "neither" && (
                <Link to={`/workshop/sessions/${cmp.sessionId}`} className="text-sm underline underline-offset-4">
                  Open the session
                </Link>
              )
            )}
          </>
        )}
      </main>
    </>
  );
}

type Tally = { rows: Array<{ name: string; model: string; counts: Partial<Record<DraftKind, number>> }> };

function CompareSettings() {
  const { data } = useCachedLoad<Tally>(`${API}/tally`, () => call(`${API}/tally`));
  return (
    <Section title="Picks">
      <Card>
        {!data ? null : data.rows.length === 0 ? (
          <EmptyRow title="No picks yet" />
        ) : (
          data.rows.map((r) => (
            <ListRow
              key={`${r.name}\n${r.model}`}
              title={`${r.name} · ${modelName(r.model)}`}
              subtitle={DRAFT_KINDS.filter((k) => r.counts[k.id]).map((k) => `${draftKindLabel(k.id)} ${r.counts[k.id]}`).join(" · ")}
            />
          ))
        )}
      </Card>
    </Section>
  );
}

const open = (id: string) => {
  window.history.pushState(window.history.state, "", `/compare/${id}`);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
};

export default defineWebPlugin({
  id: "compare",
  name: "Compare",
  about: "Two of your AIs write the same draft, names hidden until you pick one.",
  routes: [{ path: "/compare/:sessionId", element: <ComparePage /> }],
  itemActions: { session: [{ label: "Compare", icon: Scale, gate: "compare", onRun: open }] },
  settings: [{ id: "compare", title: "Compare", icon: Scale, body: <CompareSettings /> }],
});
