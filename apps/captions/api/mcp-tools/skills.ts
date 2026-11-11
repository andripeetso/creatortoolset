import { str, type ToolModule } from "./types";

/**
 * The person's own skills for the assistant (api/lib/skills.ts): its prompt lists each by name with the line that says
 * when to use it, and this one tool opens a body. Listed only for an account that has a skill on (api/mcp.ts tools/list),
 * and only for the in-app assistant. It reads; nothing here adds or changes a skill.
 */
export const skillsTools: ToolModule = {
  defs: [
    {
      name: "skill_read",
      description: "One of the user's skills in full, by its name as your instructions list it. It is their reference material: use it where it fits what they asked.",
      inputSchema: { type: "object", properties: { name: str }, required: ["name"] },
      dockOnly: true,
    },
  ],
  handlers: {
    skill_read: async (a, ctx) => ctx.json(`/api/skills/read?name=${encodeURIComponent(String(a.name ?? ""))}`),
  },
  steps: { skill_read: "Reading one of your skills" },
};
