import os from "node:os";
import type { Machine } from "../../contracts/providers";
import { machineDisks } from "./disks";

/**
 * The machine block a computer worker sends with every work claim (api/work/routes.ts): its cores, memory and load, so
 * load balancing can score it, and on Linux the network shares it has connected (disks.ts), so the server finds which of
 * its person's folders it reaches (lib/storage.ts withMounts) and hands it the file's path on the share, not a download.
 * A Mac app's own report carries its disks; the worker on a Mac sends none, and the server keeps those.
 */
export async function machineNow(): Promise<Machine> {
  const cpus = os.cpus().length || 1;
  const gb = (n: number) => Math.round((n / 2 ** 30) * 10) / 10;
  return {
    os: process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux",
    host: os.hostname(),
    cpus,
    memGb: gb(os.totalmem()),
    freeGb: gb(os.freemem()),
    load: Math.min(1, Math.round((os.loadavg()[0]! / cpus) * 100) / 100),
    ...(process.platform === "linux" ? { disks: await machineDisks() } : {}),
  };
}
