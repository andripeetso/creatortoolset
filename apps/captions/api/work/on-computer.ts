/** Item 4C: the seams. On a computer (CT_WORKER) the step code reads files, AI and server data through these. */
import type { WorkPackage } from "../../contracts/work";

/** How a step on a computer reaches its server (built by 4D's worker on the work routes). */
export interface WorkServer {
  ai(body: unknown): Promise<unknown>;
  call(fn: string, args: unknown[]): Promise<unknown>;
  say(line: string): void;
}

export const onComputer: { on: boolean; pkg: WorkPackage | null; paths: Record<string, string>; server: WorkServer | null } = {
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
