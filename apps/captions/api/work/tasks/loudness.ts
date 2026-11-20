import { LOUD_WAIT_MS } from "../../editor/sound-wait";
import { taskKind } from "../tasks";

/** The kind's name (editor/analyze.ts LOUDNESS_TASK). The editor's code is loaded only when a task runs: importing it here
 *  would pull the editor and the library into the task kinds and close an import loop (library/worker → … → here). */
const LOUDNESS_TASK = "nle-loudness";


/**
 * A library version's sound measured for the editor's Normalize and Lower Under Voice (editor/analyze.ts measureLoud,
 * src/lib/nle/loudness.ts). Processing, so it runs where the file is: on the asker's computer that has it (`device`,
 * its path there in `paths.src`), or on the server only when This Mac is the server or its video work is on (tasks.ts
 * placeTask). The server's proxy is never sent down to be measured. The blocks go to the editor cache, once per version.
 */
export interface LoudnessInput {
  /** the library version; the task's ref */
  version: string;
  sourceKey: string;
  device?: string;
  paths?: { src?: string };
}

taskKind<LoudnessInput, { blocks: number[] }>(LOUDNESS_TASK, {
  can: (d, t) => d.id === t.input.device,
  // nobody with the file came: fails as expired, which the editor says plainly (sound.ts NO_COMPUTER)
  ttlMs: LOUD_WAIT_MS,
  async run(input, ctx) {
    const [{ measureLoud }, { measurable }] = await Promise.all([import("../../editor/analyze"), import("../../editor/media")]);
    const src = ctx.where === "server" ? await measurable(input.version, input.sourceKey) : await ctx.file("src");
    ctx.beat("Measuring the sound");
    return { result: { blocks: Array.from(await measureLoud(src, ctx.signal)) } };
  },
  apply: async (t, r) => (await import("../../editor/analyze")).keepLoud(t.input.version, r.blocks),
});
