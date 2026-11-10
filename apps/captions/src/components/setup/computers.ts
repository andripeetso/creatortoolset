import { useCachedLoad } from "@/lib/local-cache";

/** One computer of this account as the setup steps show it (api/setup.ts GET /computers). */
export interface ComputerInfo {
  id: string;
  name: string;
  online: boolean;
  drivers: Array<{ driver: string; installed: boolean; signedIn?: boolean; version?: string }>;
}

/** This computer, and the account's other computers that report to this server. */
export interface ComputersView {
  here: { name: string; linked: boolean; hostname: string | null };
  others: ComputerInfo[];
}

export const getComputers = (): Promise<ComputersView | null> =>
  fetch("/api/setup/computers")
    .then((r) => (r.ok ? (r.json() as Promise<ComputersView>) : null))
    .catch(() => null);

/**
 * The computers as the setup steps read them: the saved copy at once (lib/local-cache.ts), read again when a setup step
 * saves or a computer comes online or reports its AI tools. A failed read keeps the saved copy.
 */
export const useComputers = () =>
  useCachedLoad<ComputersView>(
    "/api/setup/computers",
    async () => {
      const v = await getComputers();
      if (!v) throw new Error("Couldn't reach this computer");
      return v;
    },
    { topic: ["setup", "devices"] },
  );

const LAN = /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local)$/i;

/**
 * The web address of another server, as typed: origin only. A bare name is https, except on this network (localhost,
 * a .local name, a private address), where a home server has no certificate and it is plain http. Other schemes are refused.
 */
export function serverUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t || (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !/^https?:\/\//i.test(t))) return null; // ftp:// and the like
  const typed = /^https?:\/\//i.test(t);
  let u: URL;
  try {
    u = new URL(typed ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (!typed && LAN.test(u.hostname)) u = new URL(`http://${t}`);
  if (u.protocol === "http:" && !LAN.test(u.hostname)) return null;
  return u.origin;
}
