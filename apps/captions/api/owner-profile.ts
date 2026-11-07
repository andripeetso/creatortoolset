import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { env } from "./lib/env";
import type { AuthVars } from "./auth";

/**
 * The owner's profile on a server on their Mac: the name and email of the account they signed in with in the Mac app
 * (Apple or Google, through the account server). The app POSTs it after each sign-in; $DATA_DIR/owner-profile.json.
 * Admins only: on a server on a Mac that is its owner.
 */

export interface OwnerProfile {
  name: string;
  email: string;
  at: number;
}

const FILE = () => path.join(env.dataDir, "owner-profile.json");

export async function ownerProfile(): Promise<OwnerProfile | null> {
  try {
    return JSON.parse(await readFile(FILE(), "utf-8")) as OwnerProfile;
  } catch {
    return null;
  }
}

export const ownerProfileApp = new Hono<{ Variables: AuthVars }>()
  .use("*", async (c, next) => {
    if (c.get("user")?.role !== "admin") return c.json({ error: "Admins only" }, 403);
    await next();
  })
  .get("/", async (c) => c.json(await ownerProfile()))
  .post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; email?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    // Apple may hand over no name, and a hidden relay address: both are fine, anything else isn't
    if (name.length > 200 || !/^[^\s@]{1,100}@[^\s@]{1,200}$/.test(email)) return c.json({ error: "name and email please" }, 400);
    const profile: OwnerProfile = { name, email, at: Date.now() };
    await writeFile(`${FILE()}.tmp`, JSON.stringify(profile, null, 2), { mode: 0o600 });
    await rename(`${FILE()}.tmp`, FILE());
    return c.json(profile);
  });
