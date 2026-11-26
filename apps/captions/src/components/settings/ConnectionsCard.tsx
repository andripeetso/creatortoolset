import { useCallback, useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { getEndpoints, getPhoneNotifications, hostOf, setPhoneNotifications, type Endpoint, type PhoneNotifications } from "@/lib/access";
import { setNetworkAccess, setReachFromAnywhere } from "@/lib/thisMac";
import { Card, Row, Section, Status, markSave } from "./ui";
import type { ThisMacState } from "./ThisMacSection";

/** Reach from anywhere's line for each state the Mac app reports. */
const REACH_LINES = {
  "signed-out": "Sign in to make this Mac available to your other devices.",
  off: "Make this Mac available to your other devices through your account.",
  unreachable: "On, but other devices can't reach this Mac.",
  available: "Available to your other devices through your account.",
  removed: "This Mac was removed from your account. Turn it on to add it again.",
} as const;
export type ReachState = keyof typeof REACH_LINES;
export const reachLine = (reach: ReachState) => REACH_LINES[reach];

/**
 * The Mac app's account switch: links this Mac to the account (its tunnel) so the account's phones list it with no code.
 * Not drawn outside the Mac app, or by an app that does not report it (or has no connect service).
 */
export function ReachFromAnywhereRow({ mac }: { mac: ThisMacState | null }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reach = mac?.reach;
  if (!reach || !(reach in REACH_LINES)) return null;
  const turn = async (on: boolean) => {
    setBusy(true);
    setProblem(await setReachFromAnywhere(on));
    setBusy(false);
  };
  return (
    <Row
      id="reach-from-anywhere"
      title="Reach from anywhere"
      description={reachLine(reach)}
      status={problem ? <Status tone="broken">{problem}</Status> : undefined}
      control={<Switch checked={reach === "available" || reach === "unreachable"} disabled={busy || reach === "signed-out"} aria-label="Reach from anywhere" onCheckedChange={(on) => void turn(on)} />}
    />
  );
}

/**
 * Send notifications to your phones: the account's phones hear when something starts to wait on the owner. Drawn only
 * for the owner of a computer on an account (the route refuses everyone else).
 */
export function PhoneNotificationsRow() {
  const [state, setState] = useState<PhoneNotifications | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => void getPhoneNotifications().then(setState, () => setState(null)), []);
  if (!state?.linked) return null;
  const turn = async (on: boolean) => {
    setBusy(true);
    setProblem(null);
    await markSave(setPhoneNotifications(on)).then(setState, (e: Error) => setProblem(e.message));
    setBusy(false);
  };
  return (
    <Row
      id="phone-notifications"
      title="Send notifications to your phones"
      description="Your phones are told when something waits on you: its title and one line, never media or chat."
      status={problem ? <Status tone="broken">{problem}</Status> : undefined}
      control={<Switch checked={state.on} disabled={busy} aria-label="Send notifications to your phones" onCheckedChange={(on) => void turn(on)} />}
    />
  );
}

/** After a Network access change the server restarts: asks for its addresses each second until they say the new state (20 s at most). */
async function untilAccess(on: boolean): Promise<Endpoint[] | null> {
  for (let tries = 0; tries < 20; tries++) {
    await new Promise((done) => setTimeout(done, 1000));
    const list = await getEndpoints().catch(() => null);
    if (list && list.some((e) => e.kind === "lan") === on) return list;
  }
  return null;
}

/**
 * This computer's connections: Network access (other devices on the network reach it; the switch is the Mac app's), the
 * addresses it is reachable at, and in the Mac app Reach from anywhere. Drawn only for the server on this computer
 * (ComputersSection): another server's addresses are not this computer's, and the switch would change the wrong one.
 */
export function ConnectionsCard({ inMac, mac }: { inMac: boolean; mac: ThisMacState | null }) {
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(() => {
    void getEndpoints().then(
      (e) => (setEndpoints(e), setFailed(false)),
      () => setFailed(true),
    );
  }, []);
  useEffect(load, [load]);
  const here = inMac ? "this Mac" : "this computer";
  const lan = endpoints?.find((e) => e.kind === "lan");
  const turn = async (on: boolean) => {
    setBusy(true);
    setProblem(null);
    const p = await setNetworkAccess(on);
    if (p) setProblem(p);
    else {
      const list = await untilAccess(on);
      if (list) setEndpoints(list);
      else setProblem("The server did not come back. Open it again in a moment.");
    }
    setBusy(false);
  };
  const description = busy
    ? "Restarting…"
    : !endpoints
      ? failed ? `Could not read the addresses of ${here}.` : "Loading…"
      : lan
        ? `Reachable on your network at ${hostOf(lan.httpBaseUrl)}.`
        : `Only ${here} can connect.`;
  return (
    <Section id="connections" title={inMac ? "This Mac" : "This computer"}>
      <Card>
        <Row
          id="network-access"
          title="Network access"
          description={description}
          status={problem ? <Status tone="broken">{problem}</Status> : undefined}
          control={<Switch checked={!!lan} disabled={!inMac || busy || !endpoints} aria-label="Network access" onCheckedChange={(on) => void turn(on)} />}
        />
        {(endpoints ?? [])
          .filter((e) => e !== lan)
          .map((e) => (
            <Row key={e.httpBaseUrl} title={e.kind === "tailnet" ? "Tailnet" : hostOf(e.httpBaseUrl)} description={`Reachable at ${e.httpBaseUrl}`} />
          ))}
        <ReachFromAnywhereRow mac={inMac ? mac : null} />
        <PhoneNotificationsRow />
      </Card>
    </Section>
  );
}
