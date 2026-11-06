import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

vi.mock("./users", async (importOriginal) => ({ ...(await importOriginal<typeof import("./users")>()), bumpUsage: vi.fn() }));
vi.mock("./ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai-complete")>()),
  anyAiConfigured: () => true,
  completeWithFallback: vi.fn(async (_system, _prompt, _signal, parse) =>
    parse('{"lines":["keep moving","forward"]}'),
  ),
}));

import { aiApp } from "./ai";
import { completeWithFallback } from "./ai-complete";

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
    c.set("user", { username: "test", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/", aiApp);

const request = () =>
  app.request("/segment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      words: [
        { text: "keep", start: 0, end: 0.2 },
        { text: "moving", start: 0.25, end: 0.6 },
        { text: "forward", start: 0.9, end: 1.5 },
      ],
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cadence model request", () => {
  it("asks for thought lines and answers one mark per word", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    const [system, prompt] = vi.mocked(completeWithFallback).mock.calls[0];
    expect(system).toContain("one thought per line");
    expect(prompt).toContain("keep moving forward");
    // no box size and no timing columns: the marks don't depend on either
    expect(prompt).not.toMatch(/\d+\|keep/);
    expect(await response.json()).toEqual({ marks: [2, 0, 2] });
  });

  it("rejects an empty model answer rather than marking a fallback as matched", async () => {
    vi.mocked(completeWithFallback).mockImplementationOnce(
      async (_system, _prompt, _signal, parse) => parse!("{}"),
    );
    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The model returned no caption lines",
    });
  });
});
