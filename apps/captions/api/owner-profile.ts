import { readFileSync } from "node:fs";
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

// the profile as the file has it, by its path (a test swaps DATA_DIR); kept in step by the POST below
let known: { file: string; name: string } | undefined;
/**
 * The owner's name as the Mac app's account gave it (Apple may give none: ""). On the server on a Mac it is what the app
 * calls its owner until they type a name of their own (auth.ts sessionOf), so nobody is called by the account's
 * made-up name. Read once from the file, so a sign-in from before this was used counts too.
 */
export function ownerName(): string {
  if (known?.file !== FILE()) {
    let name = "";
    try {
      name = String((JSON.parse(readFileSync(FILE(), "utf-8")) as Partial<OwnerProfile>).name ?? "");
    } catch {
      /* no profile yet */
    }
    known = { file: FILE(), name };
  }
  return known.name;
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
    known = { file: FILE(), name };
    return c.json(profile);
  });
