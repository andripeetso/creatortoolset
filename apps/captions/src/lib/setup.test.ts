import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissSetup, DOWNLOAD_URL, firstProjectName, MAKE_NAMES, resumeStep, SETUP_PATH, SIDE_STEPS, setupDismissed, setupFinished, setupOpen, setupOpensItself,
  setupStepFromParam, shareDownload, stepsFor, toolForPath, toolsFor,
} from "./setup";
import { TOOLS } from "@contracts/tools";

afterEach(() => vi.unstubAllGlobals());

describe("setup steps", () => {
  it("is the same three screens for every way of working", () => {
    expect(stepsFor()).toEqual(["agents", "make", "try"]);
    expect(stepsFor()).toBe(SETUP_PATH);
    // it takes no answer at all; called as the old one was, with each saved answer, the path is still the same
    const asBefore = stepsFor as (talk?: string | null) => readonly string[];
    for (const talk of ["app", "chat", "both", null]) expect(asBefore(talk)).toEqual(["agents", "make", "try"]);
  });

  it("keeps Connect, Folders and How as screens a link can open, off the path", () => {
    for (const s of SIDE_STEPS) {
      expect(setupStepFromParam(s)).toBe(s);
      expect(stepsFor()).not.toContain(s);
    }
  });

  it("maps the old step ids to the screen they now belong to", () => {
    expect(setupStepFromParam("tools")).toBe("make");
    expect(setupStepFromParam("ai")).toBe("agents");
    expect(setupStepFromParam("project")).toBe("make");
    expect(setupStepFromParam("left")).toBe("try");
    expect(setupStepFromParam("done")).toBe("try");
  });

  it("names no step for an empty, unknown or inherited id", () => {
    expect(setupStepFromParam(null)).toBeNull();
    expect(setupStepFromParam("start")).toBeNull();
    expect(setupStepFromParam("constructor")).toBeNull();
  });
});

describe("the first project, made on What do you make?", () => {
  it("is named after the one thing picked, else My videos", () => {
    expect(firstProjectName(["podcast"], 0)).toBe(MAKE_NAMES.podcast);
    expect(firstProjectName(["reel", "ad"], 0)).toBe("My videos");
    expect(firstProjectName([], 0)).toBe("My videos");
  });
  it("is not made when the account already has a project", () => {
    expect(firstProjectName(["podcast"], 1)).toBeNull();
    expect(firstProjectName([], 3)).toBeNull();
  });
});

describe("setupOpen", () => {
  const fresh = { done: false, tools: null };
  it("opens by itself only on a first run that isn't finished", () => {
    expect(setupOpen(fresh, null, { firstRun: true, phone: false })).toBe(true);
    expect(setupOpen(fresh, null, { firstRun: false, phone: false })).toBe(false); // a project, or more than one login
    expect(setupOpen({ done: true, tools: ["workshop"] }, null, { firstRun: true, phone: false })).toBe(false); // saved by the old setup
  });
  it("opens when a link asks for it, finished or not", () => {
    expect(setupOpen({ done: true, tools: [] }, "agents", { firstRun: false, phone: false })).toBe(true);
  });
  it("never opens on a phone, asked for or not", () => {
    expect(setupOpen(fresh, null, { firstRun: true, phone: true })).toBe(false);
    expect(setupOpen(fresh, "try", { firstRun: true, phone: true })).toBe(false);
  });
  it("stays shut with no setup to show (a guest, the demo)", () => {
    expect(setupOpen(null, "agents", { firstRun: true, phone: false })).toBe(false);
  });
});

describe("the download link a phone is given", () => {
  it("uses the share sheet, else the clipboard, else shows the address", async () => {
    const share = vi.fn(async () => {});
    const writeText = vi.fn(async () => {});
    expect(await shareDownload({ share, clipboard: { writeText } } as unknown as Navigator)).toBe("shared");
    expect(share).toHaveBeenCalledWith({ url: DOWNLOAD_URL });
    expect(await shareDownload({ clipboard: { writeText } } as unknown as Navigator)).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(DOWNLOAD_URL);
    expect(await shareDownload({} as Navigator)).toBe("shown");
    const denied = { clipboard: { writeText: () => Promise.reject(new Error("denied")) } } as unknown as Navigator;
    expect(await shareDownload(denied)).toBe("shown");
  });
});

describe("setupFinished", () => {
  it("counts setup as finished only once done is saved with tools picked (a view saved by the old setup counts)", () => {
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
    expect(resumeStep()).toBe("agents");
  });

  it("never reopens on a screen that is off the path (one an older build remembered)", () => {
    for (const old of ["how", "connect", "folders"]) {
      vi.stubGlobal("sessionStorage", { getItem: () => old, setItem: () => {} });
      expect(resumeStep()).toBe("agents");
    }
    vi.stubGlobal("sessionStorage", { getItem: () => "project", setItem: () => {} });
    expect(resumeStep()).toBe("make");
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
    expect(resumeStep()).toBe("agents");
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
