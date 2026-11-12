import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissSetup, DOWNLOAD_URL, endIntro, firstProjectName, introPlays, introSeen, JOB_SETUP, jobNeeds, jobsFor, MAKE_NAMES, markIntroSeen, resumeStep, startIntro, toolsWithJob, useIntro, SETUP_PATH, SIDE_STEPS, setupDismissed, setupFinished, setupOpen, setupOpensItself,
  setupStepFromParam, shareDownload, stepsFor, toolForPath, toolsFor, seedSetup, useWorkPrefs,
} from "./setup";
import { useAuth } from "./auth";
import { putCached, readCached } from "./local-cache";
import { readiness, TOOLS, type Tool } from "@contracts/tools";
import { JOBS } from "@contracts/work-prefs";

afterEach(() => vi.unstubAllGlobals());

describe("setup steps", () => {
  it("is five screens, and a sixth that installs Creator Toolset in her AI apps after In my own AI or Both", () => {
    // Pick your look, Connect your AI, What do you make?, What do you want to do first?, How do you work best?
    const five = ["theme", "agents", "make", "job", "how"];
    expect(stepsFor()).toEqual(five);
    expect(stepsFor()).toEqual(SETUP_PATH);
    for (const talk of ["app", null, undefined]) expect(stepsFor(talk)).toEqual(five);
    // the owner picked Both and setup "ended abruptly": the answer is carried out on a screen of its own, last
    for (const talk of ["chat", "both"]) expect(stepsFor(talk)).toEqual([...five, "own"]);
    // the account screen is last of all, and only when the Mac app offers a sign-in that works
    expect(stepsFor("app", true)).toEqual([...five, "account"]);
    expect(stepsFor("both", true)).toEqual([...five, "own", "account"]);
    expect(stepsFor("both", false)).not.toContain("account");
  });

  it("opens the two new screens from a link, and no old id lands on them", () => {
    expect(setupStepFromParam("theme")).toBe("theme");
    expect(setupStepFromParam("job")).toBe("job");
    for (const old of ["tools", "ai", "project", "left", "done", "try"]) expect(["theme", "job"]).not.toContain(setupStepFromParam(old));
  });

  it("keeps Connect, Folders and the AI apps screen as screens a link can open alone", () => {
    for (const s of SIDE_STEPS) {
      expect(setupStepFromParam(s)).toBe(s);
      expect(stepsFor()).not.toContain(s);
    }
  });

  it("maps the old step ids to the screen they now belong to", () => {
    expect(setupStepFromParam("tools")).toBe("make");
    expect(setupStepFromParam("ai")).toBe("agents");
    expect(setupStepFromParam("project")).toBe("make");
    expect(setupStepFromParam("left")).toBe("make");
    expect(setupStepFromParam("done")).toBe("make");
    expect(setupStepFromParam("try")).toBe("make"); // the dropped "Try it" screen
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
    expect(setupOpen(fresh, "make", { firstRun: true, phone: true })).toBe(false);
  });
  it("stays shut with no setup to show (a guest, the demo)", () => {
    expect(setupOpen(null, "agents", { firstRun: true, phone: false })).toBe(false);
  });
});

describe("Home's welcome animation", () => {
  it("plays after the Done that finishes setup, and only then", () => {
    const first = { finishedBefore: false, seen: false, phone: false, still: false };
    expect(introPlays(first)).toBe(true); // Done on the last screen, or Not now before it
    expect(introPlays({ ...first, finishedBefore: true })).toBe(false); // the AI apps screen, opened again from Settings
    expect(introPlays({ ...first, seen: true })).toBe(false); // Not now showed it: finishing setup later does not show it again
    expect(introPlays({ ...first, phone: true })).toBe(false);
    expect(introPlays({ ...first, still: true })).toBe(false); // Reduce motion
  });
  it("remembers that it has played, also where the browser keeps nothing", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    markIntroSeen();
    expect(introSeen()).toBe(true);
  });
  it("runs what waited for it once: at the end or on Skip, and at once when it does not play", () => {
    const after = vi.fn();
    startIntro(false, after);
    expect(useIntro.getState().on).toBe(false);
    expect(after).toHaveBeenCalledTimes(1);
    startIntro(true, after);
    expect(useIntro.getState().on).toBe(true);
    expect(after).toHaveBeenCalledTimes(1);
    endIntro();
    endIntro(); // Skip pressed as it ends
    expect(useIntro.getState().on).toBe(false);
    expect(after).toHaveBeenCalledTimes(2);
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
    for (const at of ["theme", "agents", "job", "how"]) {
      vi.stubGlobal("sessionStorage", { getItem: () => at, setItem: () => {} });
      expect(resumeStep()).toBe(at);
    }
  });

  it("starts at the first step when the stored step is not a step", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "tools-old-junk", setItem: () => {} });
    expect(resumeStep()).toBe("theme");
  });

  it("never reopens on a screen that is off the path (one an older build remembered)", () => {
    for (const old of ["connect", "folders"]) {
      vi.stubGlobal("sessionStorage", { getItem: () => old, setItem: () => {} });
      expect(resumeStep()).toBe("theme");
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
    expect(resumeStep()).toBe("theme");
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

it("Story Splitter is never switched on by an answer", () => {
  for (const m of ["reel", "youtube", "carousel", "ad", "podcast", "course", "recording", "thread", "newsletter", "article", "other"] as const) {
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

describe("the work preferences' saved copy", () => {
  const saved = { talk: "both", check: "app", editor: null, makes: ["reel"] } as const;
  const answers = (body: unknown) => vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 200 }));
  const signIn = () => useAuth.setState({ me: { username: "tinyacrobatics" } as never });

  it("is in the store before the first render, so the setup window does not wait for the server", () => {
    signIn();
    putCached("tinyacrobatics", "/api/work-prefs", saved);
    seedSetup();
    expect(useWorkPrefs.getState().prefs).toEqual(saved);
  });

  it("keeps an answer ticked while the server's copy was on its way, when that copy says what was saved", async () => {
    signIn();
    putCached("tinyacrobatics", "/api/work-prefs", saved);
    seedSetup();
    answers(saved);
    const reading = useWorkPrefs.getState().load();
    useWorkPrefs.setState({ prefs: { ...saved, makes: ["reel", "ad"] } });
    await reading;
    expect(useWorkPrefs.getState().prefs?.makes).toEqual(["reel", "ad"]);
  });

  it("shows the server's copy when it differs from the saved one", async () => {
    signIn();
    putCached("tinyacrobatics", "/api/work-prefs", saved);
    seedSetup();
    answers({ ...saved, talk: "app" });
    await useWorkPrefs.getState().load();
    expect(useWorkPrefs.getState().prefs?.talk).toBe("app");
    expect(readCached<{ talk: string }>("tinyacrobatics", "/api/work-prefs")?.talk).toBe("app");
  });
});

describe("What do you want to do first?", () => {
  const all = [...TOOLS];
  it("offers only the jobs this account has a tool for, and Just look around always; the Video Cleaner is in none", () => {
    expect(jobsFor(all)).toEqual([...JOBS]);
    expect(jobsFor(["workshop", "captions"])).toEqual(["write", "captions", "look"]);
    expect(jobsFor(["editor"])).toEqual(["edit", "look"]); // one of its two tools is enough
    expect(jobsFor([])).toEqual(["look"]);
    for (const j of JOBS) expect(JOB_SETUP[j].tools).not.toContain("clean");
  });

  it("lists a job's missing required rows from the tools' own list (readiness), each once, never an optional one", () => {
    const have = ["deviceTranscripts", "library"] as const; // a fresh account on the Mac app
    const edit = jobNeeds("edit", all, [...have]);
    expect(edit.map((n) => n.anyOf)).toEqual([["ai"]]); // the library and transcripts are there; the AI Editor needs an AI
    expect(edit).toEqual(readiness("editor", [...have]).missing); // the same rows as the AI Editor's card
    expect(jobNeeds("ideas", all, [...have]).map((n) => n.form)).toEqual(["apify"]);
    expect(jobNeeds("write", all, [...have]).map((n) => n.anyOf)).toEqual([["ownAi"]]);
    for (const j of JOBS) expect(jobNeeds(j, all, []).some((n) => n.optional)).toBe(false);
  });

  it("counts the project as made (leaving setup makes it), and a job with nothing missing as ready", () => {
    for (const j of JOBS) expect(jobNeeds(j, all, []).some((n) => n.anyOf.includes("project"))).toBe(false);
    expect(jobNeeds("captions", all, [])).toEqual([]); // Caption Studio needs nothing it cannot do without
    expect(jobNeeds("look", all, [])).toEqual([]);
    expect(jobNeeds(null, all, [])).toEqual([]);
    expect(jobNeeds("write", all, ["ownAi"])).toEqual([]);
    // the Media Library and the AI Editor both need a library: one row
    expect(jobNeeds("edit", all, []).filter((n) => n.anyOf.includes("library"))).toHaveLength(1);
  });

  it("leaves out the rows of a tool the account may not use", () => {
    expect(jobNeeds("edit", ["media"], [])).toEqual(readiness("media", ["project"]).missing);
  });

  it("switches the job's tools on when setup is left", () => {
    const mine: Tool[] = ["instagram", "workshop", "captions", "media", "editor"];
    expect(toolsWithJob(["workshop", "media"], "captions", mine)).toEqual(["workshop", "captions", "media"]);
    expect(toolsWithJob(["workshop"], null, mine)).toEqual(["workshop"]);
    expect(toolsWithJob(["workshop"], "look", mine)).toEqual(["workshop"]);
    expect(toolsWithJob([], "captions", ["workshop"])).toEqual([]); // not a tool this account may use
  });
});
