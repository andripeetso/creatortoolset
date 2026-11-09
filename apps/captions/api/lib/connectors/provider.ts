import type { Pulled } from "./platforms";
import type { StoredAccount } from "./store";
import type { PublicGridKeys } from "../instagram/graph";
import type { SessionSource } from "../../../contracts/connectors";

/**
 * The reader registry: each way of reading an account's numbers and posts is a SocialReader. The built-in readers
 * (official logins and Apify by handle) register in platforms.ts; anything else registers at boot with registerReader.
 * pullAccount uses the first registered reader whose canRead matches the account.
 */
export interface SocialReader {
  canRead(a: Pick<StoredAccount, "platform" | "via">): boolean;
  pull(a: StoredAccount, username: string): Promise<Pulled>;
  /** Set by a reader that reads through a session login: Settings → Connectors lists it under "Turn on extra things". */
  session?: SessionSource;
}

export const readers: SocialReader[] = [];

export function registerReader(r: SocialReader): void {
  readers.push(r);
}

export function readerFor(a: Pick<StoredAccount, "platform" | "via">): SocialReader | undefined {
  return readers.find((r) => r.canRead(a));
}

/** The session sources of the registered readers, for Settings → Connectors (none unless a plug-in registers one). */
export function sessionSources(): SessionSource[] {
  return readers.flatMap((r) => (r.session ? [r.session] : []));
}

/** Options for an anonymous public-grid read (the knobs the grid reader takes). */
export interface PublicGridOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxPages?: number;
}

/**
 * Reads a public Instagram grid as a logged-out visitor sees it. Only a plug-in registers one (its connectors.publicGrid);
 * without it the app has no such code path and the read comes back empty.
 */
export type PublicGridReader = (username: string, opts?: PublicGridOptions) => Promise<PublicGridKeys>;

let publicGrid: PublicGridReader | null = null;

export function registerPublicGridReader(r: PublicGridReader): void {
  if (publicGrid && publicGrid !== r) throw new Error("a public-grid reader is already registered");
  publicGrid = r;
}

export function publicGridReader(): PublicGridReader | null {
  return publicGrid;
}
