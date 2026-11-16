/**
 * Item 4C: the seams. On a computer (CT_WORKER) the step code reads files, AI and server data through these. Each seam
 * function starts with one guard, `if (onComputer.on) …`; with the seams off (the server, This Mac) nothing changes.
 * This file has no imports but types, so every seam can read it without a cycle.
 */
import type { WorkPackage, WorkResult } from "../../contracts/work";

/** How a step on a computer reaches its server (built by 4D's worker on the work routes). */
export interface WorkServer {
  ai(body: unknown): Promise<unknown>;
  call(fn: string, args: unknown[]): Promise<unknown>;
  say(line: string): void;
  /** the rendered preview, for the server to file in Review (thumb and wave: paths relative to the data folder) */
  review(r: NonNullable<WorkResult["effects"]["review"]>): void;
}

export const onComputer: {
  on: boolean;
  pkg: WorkPackage | null;
  paths: Record<string, string>;
  server: WorkServer | null;
} = {
  on: false,
  pkg: null,
  paths: {},
  server: null,
};

/** Turns the seams on for one step: `paths` is version id → the resolved local file. */
export function turnOn(pkg: WorkPackage, paths: Record<string, string>, server: WorkServer): void {
  Object.assign(onComputer, { on: true, pkg, paths, server });
}

export function turnOff(): void {
  Object.assign(onComputer, { on: false, pkg: null, paths: {}, server: null });
}

/**
 * A server read (work/serve.ts serveCall), as the held job's account and edit: only the plain extra arguments go. The
 * route's body comes back as is: the answer, or `{ error }` when it refused.
 */
export async function ask<T = string>(fn: string, ...args: unknown[]): Promise<T> {
  const r = await onComputer.server!.call(fn, args);
  if (r && typeof r === "object" && typeof (r as { error?: unknown }).error === "string") throw new Error((r as { error: string }).error);
  return r as T;
}

/** The gate's output the server ran at claim (analyze.ts analyzeGate, index.ts indexGate). */
export const gateOf = <T>(): T => onComputer.pkg!.gate as T;

/** The file this step reads for a version: the one the worker resolved (a copy on this computer, else the server's proxy). */
export function pathOf(versionId: string): string {
  const p = onComputer.paths[versionId];
  if (p) return p;
  const f = onComputer.pkg?.files.find((x) => x.id === versionId);
  throw new Error(`${f ? `“${f.title}”` : "A file"} is not on this computer for this step`);
}
