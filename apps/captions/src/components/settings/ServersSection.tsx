import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { Cloud, Globe, Laptop, Link2, Plus, Server } from "lucide-react";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, RowMenu, Section, Status, InUse } from "./ui";
import { CopyBox } from "./copy-box";
import { tell, useThisMac } from "./ThisMacSection";
import { UpdateStatus, useServerUpdate } from "./ServerUpdateSection";
import { useAuth } from "@/lib/auth";

/** The server built into the Mac app (Servers.swift `thisMacID`). */
const THIS_MAC = "this-mac";
/** The site's own link to the source code, whose front page leads to the self-hosting guide (SELF_HOSTING.md). */
const GUIDE = "https://creatortoolset.com/api/landing/github";

/** Switching swaps the whole window for another server's data: said once, at the click (here and in the account menu). */
export async function switchServer(v: { id: string; name: string }, open?: { name: string }) {
  const ok = await confirmDialog({
    title: `Switch to ${v.name}?`,
    body: `${v.name} opens in this window, with its own workspaces${open ? `, separate from ${open.name}` : ""}.`,
    ok: "Switch",
  });
  if (ok) tell(`select:${v.id}`);
}

/**
 * Settings → Servers (the Mac app only): the servers this app opens, one at a time. The active one has a green dot and
 * Active, every other one has a Switch button in the same place. Every change goes to the app, which holds the list; this page only shows it.
 */
export function ServersSection() {
  const s = useThisMac(true);
  // the window's own server, for its admin: what waits, and Update server in its row's menu (This Mac updates with the app)
  const admin = useAuth((a) => a.me?.role === "admin");
  const update = useServerUpdate(admin && !!s?.servers.some((v) => v.current && v.id !== THIS_MAC));
  const [params, setParams] = useSearchParams();
  const [late, setLate] = useState(false);
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");

  // `?add=1` opens Add server once (the add-computer dialog links here), then the parameter goes
  useEffect(() => {
    if (params.get("add") !== "1") return;
    setAdding(true);
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete("add");
      return next;
    }, { replace: true });
  }, [params, setParams]);

  // the app answers every poll; a silent one for a while is a failed load, not a spinner (or its last answer) forever
  const silent = !s || !!s.saved;
  useEffect(() => {
    if (!silent) return;
    const t = window.setTimeout(() => setLate(true), 8000);
    return () => window.clearTimeout(t);
  }, [silent]);

  const open = s?.servers.find((v) => v.current);
  const added = s?.servers.some((v) => v.id !== THIS_MAC);
  const switchTo = (v: { id: string; name: string }) => switchServer(v, open);

  return (
    <>
      <Section
        id="servers-list"
        title="Servers"
        action={
          <Button size="xs" variant="ghost" onClick={() => setAdding(true)}>
            <Plus className="size-3" /> Add server
          </Button>
        }
      >
        <Card>
          {!s || (late && silent) ? (
            late ? (
              <ErrorRow title="Could not reach the Mac app" retry={() => { setLate(false); tell("state"); }} />
            ) : (
              <LoadingRow />
            )
          ) : s.servers.length === 0 ? (
            <EmptyRow title="No servers" />
          ) : (
            s.servers.map((v) => (
              <ListRow
                key={v.id}
                icon={v.id === THIS_MAC ? <Laptop /> : <Globe />}
                title={
                  <>
                    {v.name}
                    {v.id !== THIS_MAC && <span className="ml-2 font-normal text-muted-foreground">{v.url}</span>}
                  </>
                }
                status={v.current && update.view ? <UpdateStatus view={update.view} busy={update.busy} /> : undefined}
                actions={
                  <>
                    <End className="w-[4.5rem]">
                      {v.current ? (
                        // the server the window is on, not a quiet "fine": the kit's green state
                        <InUse>Active</InUse>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => void switchTo(v)}>
                          Switch
                        </Button>
                      )}
                    </End>
                    {/* the menu is last, as on every Settings row. This Mac is never stored in the app's list, so Rename
                        and Remove would do nothing there: it keeps the menu's place, so Switch and Active stay in one column */}
                    {v.id !== THIS_MAC ? (
                      <RowMenu
                        label={`${v.name} actions`}
                        items={[
                          ...(v.current && update.view && update.view.behind > 0 && !update.busy
                            ? [{ label: update.view.failed ? "Retry update" : "Update server", onSelect: update.ask }]
                            : []),
                          {
                            label: "Rename",
                            onSelect: async () => {
                              const name = (await promptDialog({ title: "Rename server", value: v.name, ok: "Rename" }))?.trim();
                              if (name) tell(`rename:${v.id}:${name}`);
                            },
                          },
                          {
                            label: "Remove",
                            destructive: true,
                            confirm: { title: `Remove ${v.name}?`, body: "It is removed from this Mac's list of servers.", ok: "Remove" },
                            onSelect: () => tell(`remove:${v.id}`),
                          },
                        ]}
                      />
                    ) : (
                      added && <span aria-hidden className="size-7" />
                    )}
                  </>
                }
              />
            ))
          )}
        </Card>
        {s?.problem && (
          <Card>
            <ErrorRow title={s.problem} />
          </Card>
        )}
      </Section>

      <Section title="New server">
        <Card>
          <ListRow icon={<Cloud />} title="Creator Toolset Cloud" actions={<End><Status>Coming soon</Status></End>} />
          <ListRow
            icon={<Server />}
            title="Your own server"
            actions={
              <End>
                <Button size="sm" variant="outline" asChild>
                  <a href={GUIDE} target="_blank" rel="noreferrer">Setup guide</a>
                </Button>
              </End>
            }
          />
        </Card>
      </Section>

      {open && open.id !== THIS_MAC && <SignInLink />}

      <FormDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add server"
        description="Its address, or a sign-in link created on it."
        submitLabel="Add server"
        onSubmit={() => {
          const a = address.trim();
          if (!a) return;
          tell(`add:${a}`);
          setAddress("");
          setAdding(false);
        }}
      >
        <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://studio.example.com" aria-label="Server address" />
      </FormDialog>
    </>
  );
}

/**
 * The right end of a row on this page: a button for something to do, or the kit's Status for a state, in the same box,
 * so every row is the same height. A server row gives it one width, so Switch and Active end on one line.
 */
function End({ className, children }: { className?: string; children: ReactNode }) {
  return <span data-row-end className={cn("flex h-8 items-center justify-end", className)}>{children}</span>;
}

/**
 * A one-time link that signs another computer in to the open server, as the same account: pasted into Add server there. Shown for
 * an added server only: This Mac's server has no https address, and Add server takes no other.
 */
function SignInLink() {
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mint = () => {
    setBusy(true);
    setError(null);
    fetch("/api/auth/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then((r) => (r.ok ? (r.json() as Promise<{ path: string | null }>) : Promise.reject(new Error(String(r.status)))))
      // path null: a server with no sign-in, where the address alone opens it
      .then((j) => setLink(`${window.location.origin}${j.path ?? ""}`))
      .catch(() => setError("Could not create a link. Sign in again and retry."))
      .finally(() => setBusy(false));
  };

  return (
    <Section title="Another computer">
      <Card>
        <div>
          <ListRow
            id="sign-in-another"
            icon={<Link2 />}
            title="Sign-in link"
            subtitle="Works once, within 60 seconds, in Add server on the other computer."
            status={error ? <Status tone="broken">{error}</Status> : undefined}
            actions={
              <End>
                <Button size="sm" variant="outline" disabled={busy} onClick={mint}>
                  Create link
                </Button>
              </End>
            }
          />
          {link && (
            <div className="px-3 pb-3 sm:px-4">
              <CopyBox text={link} />
            </div>
          )}
        </div>
      </Card>
    </Section>
  );
}
