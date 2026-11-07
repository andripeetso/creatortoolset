import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AdminPanel, type AdminTab } from "@/components/AdminPanel";
import { Switch } from "@/components/ui/switch";
import { getProviders, saveWorkspace } from "@/lib/providers";
import type { ProviderSettings, ProvidersView } from "@contracts/providers";
import { cn } from "@/lib/utils";
import { EffortSelect, Loading, ModelSelect, Notice } from "./ui";
import { ConnectorAppsSection } from "./ConnectorAppsSection";
import { API_MODELS, msg } from "./helpers";

const TABS: Array<{ id: AdminTab | "ai" | "apps"; label: string }> = [
  { id: "users", label: "Users" },
  { id: "access", label: "Access" },
  { id: "projects", label: "All projects" },
  { id: "guests", label: "Guests" },
  { id: "ai", label: "AI access" },
  { id: "apps", label: "Connector apps" },
];

/** Settings → Admin (admins only): the old admin dialog's tabs, and who gets the workspace's AI. */
export function AdminSection({ sub }: { sub?: string }) {
  const tab = TABS.find((t) => t.id === sub)?.id ?? "users";
  return (
    <>
      <div role="tablist" aria-label="Admin" className="mb-5 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={`/settings/admin/${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            replace
            className={cn(
              "-mb-px border-b-2 px-2.5 py-2 text-sm transition-colors",
              tab === t.id ? "border-violet-500 font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
      {tab === "ai" ? <AiAccessSection /> : tab === "apps" ? <ConnectorAppsSection /> : <AdminPanel tab={tab} />}
    </>
  );
}

/**
 * The Anthropic API key for guests and the demo, only when switched on. Team members' AI is in Settings → Team: their
 * own, or a monthly API budget; the workspace's providers (the owner's own logins) answer admins only.
 */
function AiAccessSection() {
  const [view, setView] = useState<ProvidersView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getProviders().then(setView).catch((e) => setError(msg(e)));
  }, []);

  if (error && !view) return <Notice tone="error">Could not load the AI settings: {error}</Notice>;
  if (!view) return <Loading />;
  const ws = view.workspace;
  if (!ws) return <Notice tone="error">The workspace's providers are not available to this account.</Notice>;

  const api = ws.settings.api;
  const save = async (next: ProviderSettings) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveWorkspace(next);
      setView((v) => (v && v.workspace ? { ...v, workspace: { ...v.workspace, settings: saved } } : v));
    } catch (e) {
      setError(msg(e));
    } finally {
      setSaving(false);
    }
  };
  const setApi = (patch: Partial<ProviderSettings["api"]>) => void save({ ...ws.settings, api: { ...api, ...patch } });

  // The dark cards match the admin tables they sit beside.
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border border-zinc-800 bg-[#16161c] p-5 text-xs text-zinc-400">
        Your AI providers (your own Claude and ChatGPT logins) answer only you and the other admins. Team members connect
        their own, or get a monthly API budget: <Link to="/settings/team" replace className="text-violet-400 hover:underline">Settings → Team</Link>.
      </div>
      <div className="rounded-xl border border-zinc-800 bg-[#16161c] p-5 text-zinc-200">
        <p className="text-xs text-zinc-400">
          The server's keys (Settings → API keys) serve guests and the demo only when switched on here, and team members
          on an API budget (Settings → Team) for AI and transcripts. The server pays for every call; everyone else uses
          their own keys (Settings → My API keys).
          {saving && <span className="ml-2 text-zinc-500">Saving…</span>}
        </p>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <div className="mt-4 divide-y divide-zinc-800 rounded-lg border border-zinc-800 px-3">
          <Toggle
            label="Guests"
            hint="People using the tools without an account: their AI, cloud transcripts and the Audio Enhancer run on the server's keys, under the guest caps."
            on={api.guests}
            onChange={(on) => setApi({ guests: on })}
          />
          <Toggle label="Demo account" hint="Visitors who read through the demo account: their AI and anything else they reach run on the server's keys." on={api.demo} onChange={(on) => setApi({ demo: on })} />
          <div className="flex flex-wrap items-center gap-2 py-3">
            <span className="mr-auto text-xs text-zinc-400">Model and effort for these calls</span>
            <ModelSelect value={api.model} options={API_MODELS} onChange={(m) => setApi({ model: m })} />
            <EffortSelect value={api.effort} onChange={(e) => setApi({ effort: e })} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-200">{label}</div>
        <div className="text-xs text-zinc-500">{hint}</div>
      </div>
      <Switch checked={on} onCheckedChange={onChange} aria-label={`${label}: ${on ? "on" : "off"}`} />
    </div>
  );
}
