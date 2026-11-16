import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "video-languages-"));
process.env.DATA_DIR = dataDir;
delete process.env.APP_SECRET;
process.env.DEEPGRAM_API_KEY = "dg";
afterAll(() => {
  delete process.env.DEEPGRAM_API_KEY;
  rmSync(dataDir, { recursive: true, force: true });
});

const { videoLanguages } = await import("./video-languages");
const { speechFor, writeVoicePrefs } = await import("./speech");

const projects = path.join(dataDir, "workshop", "projects");
mkdirSync(projects, { recursive: true });
const project = (id: string, createdAt: number, languages?: string[]) =>
  writeFileSync(path.join(projects, `${id}.json`), JSON.stringify({ id, owner: "local", name: id, createdAt, updatedAt: createdAt, ...(languages ? { languages } : {}) }));
project("estonian", 1, ["et"]); // the oldest: things from before workspaces belong to it
project("unset", 2);

it("a workspace's videos are heard in its own language; one with none set, in the person's own list", async () => {
  writeVoicePrefs("local", { languages: ["en"] });
  expect(await videoLanguages("local", "estonian")).toEqual(["et"]);
  expect(await videoLanguages("local", "unset")).toBeUndefined();
  // a thing from before workspaces (no id, or one that is not theirs) is the first brand's
  expect(await videoLanguages("local", undefined)).toEqual(["et"]);
  expect(await videoLanguages("local", "someone-elses")).toEqual(["et"]);
  // nobody, or a person with no workspace: the person's own list
  expect(await videoLanguages(null, "estonian")).toBeUndefined();
  expect(await videoLanguages("nobody", "estonian")).toBeUndefined();

  // what the speech engine is then asked in
  expect(speechFor("local", "transcripts", await videoLanguages("local", "estonian"))).toMatchObject({ languages: ["et"] });
  expect(speechFor("local", "transcripts", await videoLanguages("local", "unset"))).toMatchObject({ languages: ["en"] });
});
