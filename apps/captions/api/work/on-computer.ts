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
}

export const onComputer: {
  on: boolean;
  pkg: WorkPackage | null;
  paths: Record<string, string>;
  server: WorkServer | null;
  /** what the step left for the server to do (Review's filing): read by the worker after the step, reset by turnOn */
  effects: WorkResult["effects"];
} = {
  on: false,
  pkg: null,
  paths: {},
  server: null,
  effects: {},
};

/** Turns the seams on for one step: `paths` is version id → the resolved local file. */
export function turnOn(pkg: WorkPackage, paths: Record<string, string>, server: WorkServer): void {
  Object.assign(onComputer, { on: true, pkg, paths, server, effects: {} });
}

/** Turns them off; the step's `effects` stay readable until the next turnOn. */
export function turnOff(): void {
  Object.assign(onComputer, { on: false, pkg: null, paths: {}, server: null });
}

/** A server read (work/serve.ts serveCall), as the held job's account and edit: only the plain extra arguments go. */
export const ask = <T = string>(fn: string, ...args: unknown[]): Promise<T> => onComputer.server!.call(fn, args) as Promise<T>;

/** The gate's output the server ran at claim (analyze.ts analyzeGate, index.ts indexGate). */
export const gateOf = <T>(): T => onComputer.pkg!.gate as T;

/** The file this step reads for a version: the one the worker resolved (a copy on this computer, else the server's proxy). */
export function pathOf(versionId: string): string {
  const p = onComputer.paths[versionId];
  if (p) return p;
  const f = onComputer.pkg?.files.find((x) => x.id === versionId);
  throw new Error(`${f ? `“${f.title}”` : "A file"} is not on this computer for this step`);
}
