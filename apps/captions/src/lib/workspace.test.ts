import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "./workspace";
import type { WorkshopProject } from "./workshop";

const projects = [
  { id: "tiny-acrobatics", name: "Tiny Acrobatics" },
  { id: "tiny-homes", name: "Tiny Homes" },
] as WorkshopProject[];

/** A request the test answers when it chooses to. */
function held() {
  let answer!: (r: Response) => void;
  const response = new Promise<Response>((r) => (answer = r));
  return { response, answer: (body: unknown, status = 200) => answer(new Response(JSON.stringify(body), { status })) };
}

describe("switching project", () => {
  beforeEach(() => {
    useWorkspace.setState({ currentProjectId: "tiny-acrobatics", projects, loaded: true });
  });

  it("shows the other project at once, before the server answers", () => {
    vi.stubGlobal("fetch", vi.fn(() => held().response));
    void useWorkspace.getState().select("tiny-homes");
    expect(useWorkspace.getState().currentProjectId).toBe("tiny-homes");
  });

  it("is not undone by an answer that was asked for before the switch", async () => {
    const load = held();
    const patch = held();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => (init?.method === "PATCH" ? patch.response : load.response)));
    const loading = useWorkspace.getState().load();
    const switching = useWorkspace.getState().select("tiny-homes");
    patch.answer({ currentProjectId: "tiny-homes", projects });
    await switching;
    load.answer({ currentProjectId: "tiny-acrobatics", projects });
    await loading;
    expect(useWorkspace.getState().currentProjectId).toBe("tiny-homes");
  });

  it("goes back when the server refuses", async () => {
    const patch = held();
    vi.stubGlobal("fetch", vi.fn(() => patch.response));
    const switching = useWorkspace.getState().select("tiny-homes");
    patch.answer({ error: "Not found" }, 404);
    await expect(switching).rejects.toThrow("Not found");
    expect(useWorkspace.getState().currentProjectId).toBe("tiny-acrobatics");
  });
});
