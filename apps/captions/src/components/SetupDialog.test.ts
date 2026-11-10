import { describe, expect, it } from "vitest";
import { addToOwnAi } from "./SetupDialog";

const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const app = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, kind: "cli", found: true, signedIn: true, connected: false, mcp: "off", ...over });
/** A computer with these AI apps; `refuse` is the one whose add fails. Returns the fetch and the ids it was asked to add. */
function computer(rows: unknown[], refuse?: string, local = true) {
  const asked: string[] = [];
  const get = (async (_url: string, init?: RequestInit) => {
    if (!init) return reply({ local, rows });
    const id = (JSON.parse(String(init.body)) as { id: string }).id;
    asked.push(id);
    return reply({ ok: id !== refuse, added: [], failed: [] });
  }) as typeof fetch;
  return { get, asked };
}

describe("In my own AI and Both, on setup's last screen", () => {
  it("adds Creator Toolset to each AI app found on this computer, so the choice does the work", async () => {
    const c = computer([app("codex"), app("claude"), app("gemini", { mcp: "n/a" }), app("grok", { found: false })]);
    expect(await addToOwnAi(c.get)).toBeNull();
    expect(c.asked).toEqual(["codex", "claude"]);
  });

  it("says in one sentence when it could not, and where to do it later", async () => {
    expect(await addToOwnAi(computer([]).get)).toBe("No AI app was found on this computer to add Creator Toolset to. You can add it later in Settings → Headless access.");
    expect(await addToOwnAi(computer([app("codex")], "codex").get)).toBe("Creator Toolset couldn't be added to ChatGPT. You can add it later in Settings → Headless access.");
    const down = (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await addToOwnAi(down)).toBe("Creator Toolset couldn't be added to your AI. You can add it later in Settings → Headless access.");
  });

  it("adds nothing on a hosted server: there is no AI app on that computer", async () => {
    const c = computer([], undefined, false);
    expect(await addToOwnAi(c.get)).toBeNull();
    expect(c.asked).toEqual([]);
  });
});
