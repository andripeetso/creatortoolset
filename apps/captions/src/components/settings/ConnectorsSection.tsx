import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { AtSign, Facebook, Instagram, Music2, RefreshCw, Youtube, type LucideIcon } from "lucide-react";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { ApifyCard } from "@/components/instagram/ApifyCard";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { analyzerHome, getInstagramAvailability, type InstagramAvailability } from "@/lib/instagram";
import { useWorkspace } from "@/lib/workspace";
import {
  LOGINS,
  PLATFORMS,
  addHandle,
  disconnectAccount,
  getConnectors,
  linkAccount,
  loginHref,
  pullAccountNow,
  type ConnectedAccount,
  type ConnectorsView,
  type SocialPlatform,
} from "@/lib/connectors";
import { Card, Dot, Footnote, Group, Loading, Notice, Row } from "./ui";
import { fmtAgo, msg, selectCls } from "./helpers";

export const PLATFORM_ICON: Record<SocialPlatform, LucideIcon> = { instagram: Instagram, facebook: Facebook, youtube: Youtube, tiktok: Music2, x: AtSign };
const ENV: Record<string, string> = { meta: "META_APP_ID + META_APP_SECRET", google: "GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET", tiktok: "TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET" };
const n = (v?: number) => (v === undefined ? "" : v >= 10_000 ? `${Math.round(v / 1000).toLocaleString("en-US")}k` : v.toLocaleString("en-US"));

/**
 * Settings → Connectors: where each person brings their own accounts and scraping key.
 * Logins read their own numbers; anything else by handle on their own Apify token. `back` = where a login returns
 * (the setup dialog passes its own step).
 */
export function ConnectorsSection({ back = "/settings/connectors", compact }: { back?: string; compact?: boolean }) {
  const me = useAuth((s) => s.me);
  const projects = useWorkspace((s) => s.projects);
  const [view, setView] = useState<ConnectorsView | null>(null);
  const [avail, setAvail] = useState<InstagramAvailability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const [handle, setHandle] = useState<{ platform: SocialPlatform; text: string }>({ platform: "tiktok", text: "" });

  const reload = useCallback(
    () =>
      Promise.all([getConnectors(), getInstagramAvailability().catch(() => null)])
        .then(([v, a]) => {
          setView(v);
          setAvail(a);
        })
        .catch((e) => setError(msg(e))),
    [],
  );
  useEffect(() => void reload(), [reload]);
  // a pull runs on the server: look again a few times
  const watch = () => [4, 10, 25, 60].forEach((s) => window.setTimeout(() => void reload(), s * 1000));
  const act = (p: Promise<unknown>) => p.then(reload).catch((e) => setError(msg(e)));

  const back_ = params.get("connected") ? `${params.get("connected")} account(s) connected: reading their numbers now` : null;
  const backError = params.get("error");
  useEffect(() => {
    if (params.get("connected")) watch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!view) return error ? <Notice tone="error">{error}</Notice> : <Loading />;
  const admin = me?.role === "admin";

  const addByHandle = (e: FormEvent) => {
    e.preventDefault();
    if (!handle.text.trim()) return;
    void act(addHandle(handle.platform, handle.text.trim(), useWorkspace.getState().currentProjectId ?? undefined).then(() => (setHandle({ ...handle, text: "" }), watch())));
  };

  return (
    <>
      {(back_ || backError) && (
        <div className="mb-3">
          <Notice tone={backError ? "error" : "muted"}>
            {backError ?? back_}{" "}
            <button type="button" className="underline" onClick={() => setParams((p) => (p.delete("connected"), p.delete("error"), p), { replace: true })}>
              OK
            </button>
          </Notice>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      <Group title="Your accounts" hint="Each account, its project, and when it was last read.">
        {view.accounts.length === 0 ? (
          <Notice>Nothing connected yet. Log in below, or add a handle.</Notice>
        ) : (
          <Card>
            {view.accounts.map((a) => (
              <AccountRow key={a.key} a={a} projects={projects} onLink={(pid) => void act(linkAccount(a.key, pid))} onPull={() => void act(pullAccountNow(a.key).then(watch))} onRemove={() => act(disconnectAccount(a.key))} />
            ))}
          </Card>
        )}
      </Group>

      <Group title="Log in to your accounts" hint="Your own numbers (reach, watch time, saves) that public scraping can't see. Free.">
        <Card>
          {LOGINS.map((l) => (
            <Row
              key={l.id}
              label={l.label}
              hint={
                view.logins[l.id] ? (
                  l.gives
                ) : admin ? (
                  <>
                    Not set up yet: register the app and paste its keys in{" "}
                    <Link to="/settings/admin/apps" className="underline">
                      Admin → Connector apps
                    </Link>{" "}
                    (or {ENV[l.id]} in the server's .env). Redirect URL: <code className="select-all break-all">{view.redirects[l.id]}</code>
                  </>
                ) : (
                  "Not available yet"
                )
              }
            >
              {view.logins[l.id] && (
                <Button asChild size="sm" variant="outline">
                  <a href={loginHref(l.id, { back, projectId: useWorkspace.getState().currentProjectId ?? undefined })}>Connect</a>
                </Button>
              )}
            </Row>
          ))}
        </Card>
      </Group>

      <Group title="Add by handle" hint="Public profiles and posts of any account, read with your Apify key.">
        <form onSubmit={addByHandle} className="flex flex-wrap gap-2">
          <select value={handle.platform} onChange={(e) => setHandle({ ...handle, platform: e.target.value as SocialPlatform })} className={selectCls} aria-label="Platform">
            {PLATFORMS.filter((p) => p.id !== "instagram").map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <input value={handle.text} onChange={(e) => setHandle({ ...handle, text: e.target.value })} placeholder="@handle or profile link" className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs" />
          <Button type="submit" size="sm" variant="outline" disabled={!handle.text.trim() || !view.apify.configured}>
            Add
          </Button>
        </form>
        <Footnote>
          Each read costs your Apify credits. Instagram accounts go in the <Link to={analyzerHome()} className="underline">Content Analyzer</Link>.
          {!view.apify.configured && " Add your Apify key first."}
        </Footnote>
      </Group>

      <Group
        title="Your Apify key"
        hint="Your Instagram login gives you your own posts and their numbers. Other creators' posts, profiles and full comment threads need an Apify key of your own: Apify bills you for each read, the server never pays for it."
      >
        <ApifyCard availability={avail} onChange={() => void reload()} />
      </Group>
      {!compact && <div className="mt-8"><Footnote>Logins are read every 12 hours. Handles are read when you press Pull.</Footnote></div>}
    </>
  );
}

function AccountRow({ a, projects, onLink, onPull, onRemove }: { a: ConnectedAccount; projects: Array<{ id: string; name: string }>; onLink: (projectId: string | null) => void; onPull: () => void; onRemove: () => Promise<unknown> }) {
  const Icon = PLATFORM_ICON[a.platform];
  const s = a.stats ?? {};
  const facts = [
    s.followers !== undefined ? `${n(s.followers)} followers` : "",
    a.posts?.length ? `${a.posts.length} recent posts` : "",
    a.via === "login" ? "login" : "Apify",
    a.pulledAt ? `read ${fmtAgo(a.pulledAt)}` : "reading…",
  ].filter(Boolean);
  return (
    <Row
      label={
        <span className="flex items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">@{a.handle}</span>
          {a.name && a.name !== a.handle && <span className="truncate text-xs text-muted-foreground">{a.name}</span>}
          <Dot on={!a.pullError && !!a.pulledAt} />
        </span>
      }
      hint={
        <>
          {facts.join(" · ")}
          {a.pullError && <span className="block text-red-500">{a.pullError}</span>}
          {a.platform === "instagram" && a.analyzerId && (
            <Link to={`${analyzerHome()}/accounts/${a.analyzerId}`} className="ml-1 underline">
              Open in the Analyzer
            </Link>
          )}
        </>
      }
    >
      {a.platform !== "instagram" && (
        <select value={a.projectId ?? ""} onChange={(e) => onLink(e.target.value || null)} className={selectCls} aria-label="Project">
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <Button size="sm" variant="ghost" onClick={onPull} title="Read it again now">
        <RefreshCw className="h-3.5 w-3.5" />
      </Button>
      <ConfirmButton label="Disconnect" confirmLabel="Click again" onConfirm={() => void onRemove()} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-red-500" />
    </Row>
  );
}
