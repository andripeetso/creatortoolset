import { keepLoud, LOUDNESS_TASK, measureLoud } from "../../editor/analyze";
import { measurable } from "../../editor/media";
import { taskKind } from "../tasks";

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
  async run(input, ctx) {
    const src = ctx.where === "server" ? await measurable(input.version, input.sourceKey) : await ctx.file("src");
    ctx.beat("Measuring the sound");
    return { result: { blocks: Array.from(await measureLoud(src, ctx.signal)) } };
  },
  apply: (t, r) => keepLoud(t.input.version, r.blocks),
});
