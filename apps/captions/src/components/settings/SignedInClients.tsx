import { useEffect, useState } from "react";
import { Bot, Laptop, Monitor, Plus, Smartphone, Tablet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { accessName, connectionLine, ms, revokeClient, revokeOtherClients, revokePairingLink, useAccess, type ClientSession, type CreatedLink } from "@/lib/access";
import { Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Section } from "./ui";
import { CreateLinkDialog, PairingLinkCard } from "./PairingLinks";

const ICONS = { mobile: Smartphone, tablet: Tablet, desktop: Laptop, bot: Bot, unknown: Monitor } as const;

/** The time each second while something on screen counts (a link's expiry, a connection's length). */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [on]);
  return now;
}

/** One signed-in phone, iPad, browser or app: its kind, name, "os · app version", how it is connected, and Revoke. */
export function ClientRow({ session, now, onRevoke }: { session: ClientSession; now: number; onRevoke: (id: string) => Promise<void> }) {
  const [revoking, setRevoking] = useState(false);
  const { client } = session;
  const Icon = ICONS[client.deviceType ?? "unknown"] ?? Monitor;
  const about = [client.os, client.appVersion, session.scopes.includes("write") ? null : accessName(session.scopes)].filter(Boolean).join(" · ");
  const revoke = async () => {
    setRevoking(true);
    await onRevoke(session.sessionId).catch((e: Error) => toast.error("Could not revoke it", { description: e.message }));
    setRevoking(false);
  };
  return (
    <ListRow
      icon={<Icon />}
      title={
        <span className="flex items-center gap-1.5">
          <span className="truncate">{client.label || session.label || client.model || client.os || session.subject || "Device"}</span>
          {session.current && <span className="shrink-0 rounded-md border border-border/50 bg-muted/50 px-1 py-0.5 text-[10px] font-normal text-muted-foreground">This device</span>}
        </span>
      }
      subtitle={about || undefined}
      status={connectionLine(session, now)}
      actions={
        !session.current && (
          <Button size="sm" variant="outline" className="text-red-600 dark:text-red-400" disabled={revoking} onClick={() => void revoke()}>
            Revoke
          </Button>
        )
      }
    />
  );
}

/**
 * Settings → Computers → Phones: the live pairing links and every phone, iPad and browser signed in to this server, live
 * from the server's access events. Create link makes a one-time link; Revoke others signs out every one but this device.
 * `create` opens Create link (the page's `?phone=1`).
 */
export function PhonesSection({ create, onCreateChange }: { create: boolean; onCreateChange: (open: boolean) => void }) {
  const { view, error, apply, retry } = useAccess();
  // the codes this page made, by link id: never stored, never listed by the server
  const [made, setMade] = useState<Map<string, CreatedLink>>(() => new Map());
  const [newest, setNewest] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);
  const links = (view?.pairingLinks ?? []).filter((l) => !Number.isNaN(ms(l.expiresAt)));
  const sessions = view?.clientSessions ?? [];
  const now = useNow(links.length > 0 || sessions.some((s) => s.connected || s.current));
  const live = links.filter((l) => ms(l.expiresAt) > now);
  const others = sessions.some((s) => !s.current);

  const created = (link: CreatedLink) => {
    setMade((m) => new Map(m).set(link.id, link));
    setNewest(link.id);
    apply("pairingLinkUpserted", { id: link.id, label: link.label, scopes: link.scopes, createdAt: link.createdAt, expiresAt: link.expiresAt });
  };
  const revokeLink = async (id: string) => {
    await revokePairingLink(id);
    apply("pairingLinkRemoved", { id });
  };
  const revokeOne = async (sessionId: string) => {
    await revokeClient(sessionId);
    apply("clientRemoved", { sessionId });
  };
  const revokeRest = async () => {
    setRevokingOthers(true);
    try {
      await revokeOtherClients();
      for (const s of sessions) if (!s.current) apply("clientRemoved", { sessionId: s.sessionId });
    } catch (e) {
      toast.error("Could not revoke the others", { description: e instanceof Error ? e.message : undefined });
    }
    setRevokingOthers(false);
  };

  const action = (
    <span className="flex items-center gap-1">
      <Button size="xs" variant="ghost" disabled={!others || revokingOthers} onClick={() => void revokeRest()}>
        Revoke others
      </Button>
      <span data-settings-row="create-link">
        <Button size="xs" variant="ghost" onClick={() => onCreateChange(true)}>
          <Plus className="size-3" /> Create link
        </Button>
      </span>
    </span>
  );

  return (
    <Section id="phones" title="Phones" action={action}>
      <Card>
        {!view && error ? (
          <ErrorRow title="Could not load signed-in devices" detail={error} retry={retry} />
        ) : !view ? (
          <LoadingRow />
        ) : live.length === 0 && sessions.length === 0 ? (
          <EmptyRow title="No signed-in devices" description="A phone or iPad signs in here with a link from Create link." />
        ) : null}
        {live.map((l) => (
          <PairingLinkCard key={l.id} link={l} created={made.get(l.id)} now={now} startOpen={l.id === newest} onRevoke={revokeLink} />
        ))}
        {sessions.map((s) => (
          <ClientRow key={s.sessionId} session={s} now={now} onRevoke={revokeOne} />
        ))}
      </Card>
      <CreateLinkDialog open={create} onOpenChange={onCreateChange} onCreated={created} />
    </Section>
  );
}
