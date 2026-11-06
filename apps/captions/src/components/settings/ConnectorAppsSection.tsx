import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, Dot, Group, Loading, Notice, Row } from "./ui";
import { msg } from "./helpers";

type AppView = { set: boolean; id: string; fromEnv: boolean; configId?: string };
type View = { meta: AppView; google: AppView; tiktok: AppView; tiktokVerify: string; redirects: Record<"meta" | "google" | "tiktok", string> };

const APPS = [
  { kind: "meta", label: "Meta (Instagram & Facebook)", idLabel: "App ID", secretLabel: "App secret", where: "developers.facebook.com → your app → App settings → Basic" },
  { kind: "google", label: "Google (YouTube)", idLabel: "Client ID", secretLabel: "Client secret", where: "console.cloud.google.com → Google Auth Platform → Clients" },
  { kind: "tiktok", label: "TikTok", idLabel: "Client key", secretLabel: "Client secret", where: "developers.tiktok.com → your app → Credentials" },
] as const;

const input = "w-full rounded-md border border-input bg-background px-2 py-1 text-xs";
const save = (body: unknown) =>
  fetch("/api/connectors/apps", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => {
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
  });

/**
 * Settings → Admin → Connector apps: the keys of the apps registered at Meta, Google and TikTok, pasted here (by the
 * owner or an agent in the author's browser) instead of the server's .env. Secrets are never shown back.
 */
export function ConnectorAppsSection() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const load = () =>
    fetch("/api/connectors/apps")
      .then((r) => r.json() as Promise<View>)
      .then(setView)
      .catch((e) => setError(msg(e)));
  useEffect(() => void load(), []);
  if (!view) return error ? <Notice tone="error">{error}</Notice> : <Loading />;

  const submit = (kind: string) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setError(null);
    save({ kind, ...f })
      .then(() => (setSaved(kind), load()))
      .catch((x) => setError(msg(x)));
  };

  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      <Group title="Connector apps" hint="The apps each login runs through (Settings → Connectors). Register them once, paste their keys here. Secrets are stored on the server and never shown again.">
        <Card>
          {APPS.map((a) => {
            const v = view[a.kind];
            return (
              <Row
                key={a.kind}
                label={
                  <span className="flex items-center gap-2">
                    <Dot on={v.set} /> {a.label} {saved === a.kind && <span className="text-xs text-emerald-500">saved</span>}
                  </span>
                }
                hint={
                  <>
                    Redirect URL to register: <code className="select-all break-all">{view.redirects[a.kind]}</code>
                    <br />
                    Keys: {a.where}
                    {v.fromEnv && <> · set in the server's .env</>}
                  </>
                }
              >
                <form onSubmit={submit(a.kind)} className="grid w-full gap-1.5 sm:w-80">
                  <input name="id" defaultValue={v.id} placeholder={a.idLabel} aria-label={a.idLabel} className={input} />
                  <input name="secret" type="password" autoComplete="off" placeholder={v.set ? `${a.secretLabel} (kept; paste to replace)` : a.secretLabel} aria-label={a.secretLabel} className={input} />
                  {a.kind === "meta" && <input name="configId" defaultValue={v.configId} placeholder="Login configuration ID (Facebook Login for Business)" aria-label="Configuration ID" className={input} />}
                  <Button type="submit" size="sm" variant="outline">
                    Save
                  </Button>
                </form>
              </Row>
            );
          })}
          <Row label="TikTok site check" hint={<>TikTok asks to find a file at https://creatortoolset.com/tiktok….txt to prove the site is ours. {view.tiktokVerify ? `Serving ${view.tiktokVerify}.` : ""}</>}>
            <form onSubmit={submit("tiktokVerify")} className="grid w-full gap-1.5 sm:w-80">
              <input name="name" defaultValue={view.tiktokVerify} placeholder="File name, e.g. tiktokAbC123.txt" aria-label="File name" className={input} />
              <input name="content" placeholder="What the file says" aria-label="File content" className={input} />
              <Button type="submit" size="sm" variant="outline">
                Save
              </Button>
            </form>
          </Row>
        </Card>
      </Group>
    </>
  );
}
