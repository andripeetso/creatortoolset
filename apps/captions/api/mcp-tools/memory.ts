import { MEMORY_QUOTE_MIN, even, type MemoryFact } from "../../contracts/memory";
import { ToolError, str, type ToolModule } from "./types";

/**
 * The assistant remembers: what the person says about themselves or their work is kept for later chats (api/memory.ts).
 * These two descriptions are all that tells the AI when to keep something, so they say what it is for and what it is
 * never for. The check that the quote is the person's own is the route's, in code: a wrong call is refused there.
 */
export const memoryTools: ToolModule = {
  defs: [
    {
      name: "remember",
      description:
        "Keep a standing preference about the user or their work for later chats. quote: their exact words. rule: it as one clean instruction. To reword a kept one, quote its words. Not for the piece at hand.",
      inputSchema: { type: "object", properties: { quote: str, rule: str, project_only: { type: "boolean" } }, required: ["quote", "rule"] },
      dockOnly: true,
    },
    { name: "forget", description: "Remove a kept fact when the user asks. quote: its words.", inputSchema: { type: "object", properties: { quote: str } }, dockOnly: true },
  ],
  handlers: {
    remember: async (a, ctx) => {
      const f = await ctx.json<MemoryFact>("/api/memory", "POST", { quote: a.quote, rule: a.rule, project: a.project_only === true });
      return { kept: f.text, ...(f.project ? { for_project: f.project.name } : {}) };
    },
    forget: async (a, ctx) => {
      const q = even(String(a.quote ?? ""));
      if (q.length < MEMORY_QUOTE_MIN) throw new ToolError("Give the words of the fact to remove.");
      // only what this chat's prompt holds: another project's facts are not this chat's to name or remove
      const { facts } = await ctx.json<{ facts: MemoryFact[] }>("/api/memory?here=1");
      const hits = facts.filter((f) => [f.text, f.said].some((t) => t && (even(t).includes(q) || q.includes(even(t)))));
      if (!hits.length) throw new ToolError("Nothing kept says that.");
      if (hits.length > 1) throw new ToolError(`Several kept facts say that: quote one of them in full. ${hits.map((f) => JSON.stringify(f.text)).join(", ")}`);
      await ctx.api(`/api/memory/${hits[0]!.id}`, "DELETE");
      return { forgot: hits[0]!.text };
    },
  },
  steps: { remember: "Keeping that in mind", forget: "Forgetting that" },
};
