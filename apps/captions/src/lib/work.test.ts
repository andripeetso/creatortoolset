import { Clapperboard, NotebookPen } from "lucide-react";
import { describe, expect, it } from "vitest";
import { recentWork, workAt, type WorkItem } from "./work";

const edit = (id: string, at: number, title = `Edit ${id}`): WorkItem => ({ key: `edit:${id}`, kind: "Edit", icon: Clapperboard, title, to: `/editor/${id}`, at });
const session = (id: string, at: number): WorkItem => ({ key: `session:${id}`, kind: "Workshop", icon: NotebookPen, title: `Session ${id}`, to: `/workshop/sessions/${id}`, at });

describe("the work a new chat can carry on with", () => {
  it("is the newest of every kind together, newest first, and no more than asked", () => {
    const all = recentWork([[edit("a", 5), edit("b", 1)], [session("s", 3)], [edit("c", 9, " ")]], 2);
    // a thing with no name is left out
    expect(all.map((w) => w.key)).toEqual(["edit:a", "session:s"]);
  });
  it("is the thing whose page you are on, or inside (an edit's draft)", () => {
    const items = [edit("a", 1), edit("ab", 2), session("s", 3)];
    expect(workAt(items, "/editor/a")?.key).toBe("edit:a");
    expect(workAt(items, "/editor/ab/draft-2")?.key).toBe("edit:ab");
    expect(workAt(items, "/workshop/sessions/s")?.key).toBe("session:s");
    expect(workAt(items, "/editor")).toBeUndefined();
    expect(workAt(items, "/")).toBeUndefined();
  });
});
