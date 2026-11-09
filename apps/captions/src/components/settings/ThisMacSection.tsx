import { useEffect, useState } from "react";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { postToApp } from "@/lib/mac-record";
import { Card, Dot, Group, Loading, Notice, Row } from "./ui";

/** Inside the Mac app (it sets <html data-mac-this-mac>): Settings shows This Mac. A browser or an older app never does. */
export const hasThisMac = () => typeof document !== "undefined" && document.documentElement.dataset.macThisMac === "1";

/** What the app reports (apps/mac ThisMacBridge.swift `thisMacState`). */
type ThisMacState = {
  answer: string;
  aiOn: boolean;
  running: number;
  lastError: string | null;
  notice: string | null;
  paired: boolean;
  problem: string | null;
  servers: Array<{ id: string; name: string; url: string; current: boolean }>;
};

/** `thismac-<what>` to the app; it answers every one with a `mac-this` event carrying its state. */
const tell = (what: string) => postToApp(`thismac-${what}`);

function useThisMac(): ThisMacState | null {
  const [state, setState] = useState<ThisMacState | null>(null);
  useEffect(() => {
    const on = (e: Event) => setState((e as CustomEvent<ThisMacState>).detail);
    window.addEventListener("mac-this", on);
    tell("state");
    // ponytail: polls while the section is open; the app could push on change if this ever matters
    const timer = setInterval(() => tell("state"), 3000);
    return () => {
      window.removeEventListener("mac-this", on);
      clearInterval(timer);
    };
  }, []);
  return state;
}

/**
 * Settings → This Mac (the Mac app only): use this Mac for your AI and the servers this app opens. The app holds all of
 * it; this page only shows it and sends the clicks.
 */
export function ThisMacSection() {
  const s = useThisMac();
  const [address, setAddress] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  if (!s) return <Loading />;

  return (
    <>
      <Group title="This Mac" hint="Use this Mac for your AI, and the servers this app opens. The one with the dot is open now.">
        <Card>
          <Row label="Use this Mac for my AI" hint={s.answer}>
            <Switch checked={s.aiOn} aria-label="Use this Mac for my AI" onCheckedChange={(on) => tell(on ? "ai:on" : "ai:off")} />
          </Row>
          {s.aiOn && s.running > 0 && <Row label={`Running ${s.running} job${s.running === 1 ? "" : "s"}`} />}
          {s.paired && (
            <Row label="Remove this Mac from my account" hint="Turn it on again to pair it.">
              <ConfirmButton
                label="Remove"
                confirmLabel="Click again to remove"
                onConfirm={() => tell("forget")}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-red-500/50 hover:text-red-600 dark:hover:text-red-300"
                armedClassName="border-red-500/60 text-red-600 dark:text-red-300"
              />
            </Row>
          )}
        </Card>
        {s.lastError && <Notice tone="error">{s.lastError}</Notice>}
        {s.notice && <Notice>{s.notice}</Notice>}
      </Group>

      <Group title="Servers" hint="The servers this app opens. The one with the dot is open now.">
        <Card>
          {s.servers.map((v) => (
            <Row
              key={v.id}
              label={
                renaming?.id === v.id ? (
                  <Input
                    autoFocus
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: v.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        tell(`rename:${v.id}:${renaming.name}`);
                        setRenaming(null);
                      }
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    className="h-8 max-w-xs"
                  />
                ) : (
                  <span className="flex items-center gap-2">
                    <Dot on={v.current} />
                    {v.name}
                  </span>
                )
              }
              hint={v.url}
            >
              <div className="flex items-center gap-2">
                {!v.current && (
                  <Button size="sm" variant="outline" onClick={() => tell(`select:${v.id}`)}>Open</Button>
                )}
                {renaming?.id === v.id ? (
                  <Button size="sm" variant="outline" onClick={() => { tell(`rename:${v.id}:${renaming.name}`); setRenaming(null); }}>Done</Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: v.id, name: v.name })}>Rename</Button>
                )}
                {s.servers.length > 1 && (
                  <ConfirmButton
                    label="Remove"
                    confirmLabel="Click again to remove"
                    onConfirm={() => tell(`remove:${v.id}`)}
                    className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-red-500/50 hover:text-red-600 dark:hover:text-red-300"
                    armedClassName="border-red-500/60 text-red-600 dark:text-red-300"
                  />
                )}
              </div>
            </Row>
          ))}
        </Card>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!address.trim()) return;
            tell(`add:${address.trim()}`);
            setAddress("");
          }}
        >
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Server address, or a sign-in link from it" className="h-8" />
          <Button type="submit" size="sm" variant="outline" disabled={!address.trim()}>Add server</Button>
        </form>
        {s.problem && <Notice tone="error">{s.problem}</Notice>}
      </Group>
    </>
  );
}
