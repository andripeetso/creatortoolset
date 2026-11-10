import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Plus } from "lucide-react";
import { promptDialog } from "@/lib/dialogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, Row, RowMenu, Section } from "./ui";
import { tell, useThisMac } from "./ThisMacSection";

/** A server on this Mac itself (the app's own server), which has no address worth showing. */
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/;

/**
 * Settings → Servers (the Mac app only): the servers this app opens. The dot marks the open one. Every change goes to the
 * app, which holds the list; this page only shows it.
 */
export function ServersSection() {
  const s = useThisMac(true);
  const [params, setParams] = useSearchParams();
  const [late, setLate] = useState(false);
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);

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

  const addButton = (
    <Button size="xs" variant="ghost" onClick={() => setAdding(true)}>
      <Plus className="size-3" /> Add server
    </Button>
  );

  return (
    <>
      <Section title="Servers" action={addButton}>
        <Card>
          {!s ? (
            late ? (
              <ErrorRow title="The Mac app did not answer" retry={() => { setLate(false); tell("state"); }} />
            ) : (
              <LoadingRow />
            )
          ) : s.servers.length === 0 ? (
            <EmptyRow title="No servers yet" description="The servers this app opens. Add one with its address." />
          ) : (
            s.servers.map((v) => (
              <ListRow
                key={v.id}
                icon={
                  v.current ? (
                    <span role="img" aria-label="Open now" className="block size-2 rounded-full bg-foreground" />
                  ) : (
                    <span aria-hidden className="block size-2" />
                  )
                }
                title={v.name}
                subtitle={LOOPBACK.test(v.url) ? "The server inside this app" : v.url}
                status={v.current ? "Open now" : undefined}
                actions={
                  <RowMenu
                    label={`${v.name} actions`}
                    items={[
                      ...(v.current ? [] : [{ label: "Open", onSelect: () => tell(`select:${v.id}`) }]),
                      {
                        label: "Rename",
                        onSelect: async () => {
                          const name = (await promptDialog({ title: "Rename server", value: v.name, ok: "Rename" }))?.trim();
                          if (name) tell(`rename:${v.id}:${name}`);
                        },
                      },
                      ...(s.servers.length > 1
                        ? [{
                            label: "Remove",
                            destructive: true,
                            confirm: { title: `Remove ${v.name}?`, body: "It leaves this Mac's list. Its data stays on the server.", ok: "Remove" },
                            onSelect: () => tell(`remove:${v.id}`),
                          }]
                        : []),
                    ]}
                  />
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

      <Section title="Open this server on another computer">
        <Card>
          <Row
            id="sign-in-another"
            title="Sign-in link"
            description="Make a link here, then paste it into Add server on the other computer. It works once, within 60 seconds."
            control={
              <Button size="sm" variant="outline" onClick={() => setLinkOpen(true)}>
                Make a link
              </Button>
            }
          />
        </Card>
      </Section>

      <FormDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add a server you host"
        description="A sign-in link made on that server works too."
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

      <SignInLinkDialog open={linkOpen} onOpenChange={setLinkOpen} />
    </>
  );
}

/** The one-time link another server's "I already have a server" step pastes. A new one replaces it. */
function SignInLinkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mint = () => {
    setError(null);
    fetch("/api/auth/link", { method: "POST" })
      .then((r) => (r.ok ? (r.json() as Promise<{ path: string | null }>) : Promise.reject(new Error(String(r.status)))))
      .then((j) => setLink(`${window.location.origin}${j.path ?? ""}`))
      .catch(() => setError("Couldn't make a link. Sign in again and try."));
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => { onOpenChange(o); if (!o) { setLink(null); setError(null); } }}
      title="Sign in another computer"
      submitLabel={link ? "New link" : "Make a link"}
      onSubmit={mint}
      error={error}
    >
      {link && (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs">{link}</code>
          <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(link)}>
            Copy
          </Button>
        </div>
      )}
    </FormDialog>
  );
}
