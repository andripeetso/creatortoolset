import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { Cloud, Globe, Laptop, Link2, Plus, Server } from "lucide-react";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, RowMenu, Section, Status, StatusDot } from "./ui";
import { tell, useThisMac } from "./ThisMacSection";

/** The server built into the Mac app (Servers.swift `thisMacID`). */
const THIS_MAC = "this-mac";
/** The site's own link to the source code, whose front page leads to the self-hosting guide (SELF_HOSTING.md). */
const GUIDE = "https://creatortoolset.com/api/landing/github";

/**
 * Settings → Servers (the Mac app only): the servers this app opens, one at a time. The active one has a green dot and
 * Active, every other one has a Switch button in the same place. Every change goes to the app, which holds the list; this page only shows it.
 */
export function ServersSection() {
  const s = useThisMac(true);
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

  // the app answers every poll; a silent one for a while is a failed load, not a spinner forever
  useEffect(() => {
    if (s) return;
    const t = window.setTimeout(() => setLate(true), 8000);
    return () => window.clearTimeout(t);
  }, [s]);

  const open = s?.servers.find((v) => v.current);
  const added = s?.servers.some((v) => v.id !== THIS_MAC);
  // switching swaps the whole window for another server's data: say so once, at the click, not on the row
  const switchTo = async (v: { id: string; name: string }) => {
    const ok = await confirmDialog({
      title: `Switch to ${v.name}?`,
      body: `This window opens ${v.name}. It has its own projects${open ? `, separate from ${open.name}` : ""}. Switch back here, or in the Servers menu.`,
      ok: "Switch",
    });
    if (ok) tell(`select:${v.id}`);
  };

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
          {!s ? (
            late ? (
              <ErrorRow title="The Mac app did not answer" retry={() => { setLate(false); tell("state"); }} />
            ) : (
              <LoadingRow />
            )
          ) : s.servers.length === 0 ? (
            <EmptyRow title="No servers yet" />
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
                actions={
                  <>
                    <End className="w-[4.5rem]">
                      {v.current ? (
                        // the kit's green dot, with the word itself green and as large as the row's title: this is
                        // the server the window is on, not a quiet "fine"
                        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                          <StatusDot tone="ok" /> Active
                        </span>
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
                            confirm: { title: `Remove ${v.name}?`, body: "It leaves this Mac's list. Its data stays on the server.", ok: "Remove" },
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

      <Section title="Get a server">
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

      {open && open.id !== THIS_MAC && <SignInLink server={open.name} />}

      <FormDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add server"
        description="Its address, or a sign-in link made on it."
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
 * A one-time link that signs another computer into the open server as you: paste it into Add server there. Shown for
 * an added server only: This Mac's server has no https address, and Add server takes no other.
 */
function SignInLink({ server }: { server: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mint = () => {
    setBusy(true);
    setError(null);
    fetch("/api/auth/link", { method: "POST" })
      .then((r) => (r.ok ? (r.json() as Promise<{ path: string | null }>) : Promise.reject(new Error(String(r.status)))))
      // path null: a server with no sign-in, where the address alone opens it
      .then((j) => setLink(`${window.location.origin}${j.path ?? ""}`))
      .catch(() => setError("Couldn't make a link. Sign in again and try."))
      .finally(() => setBusy(false));
  };

  return (
    <Section title={`Open ${server} on another computer`}>
      <Card>
        <ListRow
          id="sign-in-another"
          icon={<Link2 />}
          title="Sign-in link"
          subtitle="Paste it into Add server on the other computer. Works once, within 60 seconds."
          actions={
            <End>
              <Button size="sm" variant="outline" disabled={busy} onClick={mint}>
                Make a link
              </Button>
            </End>
          }
        />
        {/* under the row, in its text column (the icon column is 20px + the 12px gap) */}
        {(link || error) && (
          <div className="flex items-center gap-2 py-2.5 pl-11 pr-3 sm:pl-12 sm:pr-4">
            {link && (
              <>
                <code className="min-w-0 flex-1 truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs">{link}</code>
                <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(link)}>
                  Copy
                </Button>
              </>
            )}
            {error && <Status tone="broken">{error}</Status>}
          </div>
        )}
      </Card>
    </Section>
  );
}
