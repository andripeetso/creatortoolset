import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissSetup, MAKE_NAMES, neighbours, resumeStep, SETUP_STEPS, setupDismissed, setupFinished, setupOpensItself, setupStepFromParam, stageOf, stepsFor, toolForPath, toolsFor } from "./setup";
import { TOOLS } from "@contracts/tools";

afterEach(() => vi.unstubAllGlobals());

describe("setup steps", () => {
  it("keeps the click path as before (mode, make, project, agents, done) and puts Connect and Folders beside it", () => {
    expect(SETUP_STEPS).toEqual(["how", "make", "project", "agents", "connect", "folders", "done"]);
    expect(stepsFor("both")).toEqual(["how", "make", "project", "agents", "done"]);
    expect(stepsFor(null)).toEqual(["how", "make", "project", "agents", "done"]);
  });

  it("skips Agents on the In the app path, and never puts Connect or Folders on the click path", () => {
    expect(stepsFor("app")).toEqual(["how", "make", "project", "done"]);
    expect(stepsFor("chat")).toContain("agents");
    for (const t of ["app", "chat", "both", null] as const) {
      expect(stepsFor(t)).not.toContain("connect");
      expect(stepsFor(t)).not.toContain("folders");
    }
  });

  it("gives the three bar stages to Connect, Agents and Folders, and none to the other steps", () => {
    expect(SETUP_STEPS.map(stageOf)).toEqual([-1, -1, -1, 1, 0, 2, -1]);
  });

  it("goes Back and Continue along the mode's path, and a side step returns to done", () => {
    expect(neighbours("make", "both")).toEqual({ before: "how", after: "project" });
    expect(neighbours("agents", "both")).toEqual({ before: "project", after: "done" });
    expect(neighbours("done", "both")).toEqual({ before: "agents", after: "done" });
    expect(neighbours("done", "app")).toEqual({ before: "project", after: "done" });
    expect(neighbours("connect", "both")).toEqual({ before: "done", after: "done" });
    expect(neighbours("folders", "chat")).toEqual({ before: "done", after: "done" });
  });

  it("maps the old step ids to the step they now belong to", () => {
    expect(setupStepFromParam("tools")).toBe("make");
    expect(setupStepFromParam("ai")).toBe("agents");
    expect(setupStepFromParam("connect")).toBe("connect");
    expect(setupStepFromParam("left")).toBe("done");
    expect(setupStepFromParam("project")).toBe("project");
  });

  it("names no step for an empty, unknown or inherited id", () => {
    expect(setupStepFromParam(null)).toBeNull();
    expect(setupStepFromParam("start")).toBeNull();
    expect(setupStepFromParam("constructor")).toBeNull();
  });
});

describe("setupFinished", () => {
  it("counts setup as finished only after Done saved it with tools picked", () => {
    expect(setupFinished({ done: false, tools: ["workshop"] })).toBe(false);
    expect(setupFinished({ done: true, tools: ["workshop"] })).toBe(true);
    expect(setupFinished({ done: true, tools: null })).toBe(false); // closed early by an older build
    expect(setupFinished({ done: true, tools: [] })).toBe(true); // nothing ticked is still a saved answer
  });
});

describe("Not now and resume", () => {
  it("reopens at the step Not now was pressed on", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "agents", setItem: () => {} });
    expect(resumeStep()).toBe("agents");
  });

  it("starts at the first step when the stored step is not a step", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "tools-old-junk", setItem: () => {} });
    expect(resumeStep()).toBe("how");
  });

  it("starts at the first step when storage throws", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(resumeStep()).toBe("how");
  });

  it("keeps a dismissal for this page load even when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    dismissSetup();
    expect(setupDismissed()).toBe(true);
  });
});

it("knows each tool's pages", () => {
  expect(toolForPath("/analyzer/accounts/1")).toBe("instagram");
  expect(toolForPath("/library")).toBe("media");
  expect(toolForPath("/video-notes/abc")).toBe("notes");
  expect(toolForPath("/settings/setup")).toBeNull();
  expect(toolForPath("/")).toBeNull();
});

it("always on: the Plan and Make tools, whatever the answer; the Workshop and the rest are not part of the pick", () => {
  const defaults = ["instagram", "workshop", "review", "media", "editor"];
  expect(toolsFor(["newsletter", "article"], TOOLS)).toEqual(defaults);
  expect(toolsFor([], TOOLS)).toEqual(defaults);
  expect(toolsFor(["thread"], TOOLS)).toEqual(defaults);
  expect(toolsFor(["reel"], ["workshop", "review"])).toEqual(["workshop", "review"]); // only what the account may use
});

it("an answer switches on only the extra that clearly fits it", () => {
  expect(toolsFor(["reel"], TOOLS)).toEqual(["instagram", "workshop", "captions", "review", "media", "editor"]);
  expect(toolsFor(["podcast"], TOOLS)).toContain("enhance");
  expect(toolsFor(["recording"], TOOLS)).toContain("notes");
  expect(toolsFor(["course"], TOOLS)).toContain("guides");
  expect(toolsFor(["podcast"], TOOLS)).not.toContain("captions");
  expect(toolsFor(["youtube", "carousel", "ad"], TOOLS)).toEqual(toolsFor([], TOOLS)); // no extra fits
});

it("Video Cleaner and Story Splitter are never switched on by an answer", () => {
  for (const m of ["reel", "youtube", "carousel", "ad", "podcast", "course", "recording", "thread", "newsletter", "article", "other"] as const) {
    expect(toolsFor([m], TOOLS)).not.toContain("clean");
    expect(toolsFor([m], TOOLS)).not.toContain("stories");
  }
});


it("names all eleven makes", () => {
  expect(Object.keys(MAKE_NAMES)).toHaveLength(11);
});

describe("setup opens by itself only on a first sign-in", () => {
  it("an existing account never gets it, even with no projects", () => {
    expect(setupOpensItself({ logins: 57, loaded: true, projects: 0 })).toBe(false);
  });
  it("waits for the projects to load: a failed load is not a brand-new account", () => {
    expect(setupOpensItself({ logins: 1, loaded: false, projects: 0 })).toBe(false);
  });
  it("a first sign-in with no project opens it; a project closes it", () => {
    expect(setupOpensItself({ logins: 1, loaded: true, projects: 0 })).toBe(true);
    expect(setupOpensItself({ logins: 1, loaded: true, projects: 2 })).toBe(false);
  });
});
