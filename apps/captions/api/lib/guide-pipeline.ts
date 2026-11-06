import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { aiFor, completeWithFallback } from "../ai-complete";
import { clipFramesDir, getClipRecordingPath } from "../clips";
import { env } from "./env";
import { extractClipJpegFrame } from "./clip-frame";
import {
  guideToMarkdown,
  parseGuidePlan,
  planToGuide,
  type GuideDoc,
  type GuideMedia,
} from "../../src/lib/guide";

const CLIPS_DIR = path.join(env.dataDir, "clips");
const GUIDE_PACK = 24_000;

function timedTranscript(
  words: { text: string; start: number; end?: number }[],
  max = GUIDE_PACK,
): string {
  const parts: string[] = [];
  let buf: string[] = [];
  let t0 = 0;
  const flush = () => {
    if (!buf.length) return;
    const mm = Math.floor(t0 / 60);
    const ss = Math.floor(t0 % 60);
    parts.push(
      `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${buf.join(" ")}`,
    );
    buf = [];
  };
  for (const w of words) {
    if (!buf.length) t0 = w.start;
    buf.push(w.text);
    if (w.start - t0 >= 10 || buf.join(" ").length > 140) flush();
  }
  flush();
  return parts.join("\n").slice(0, max);
}

async function loadClip(id: string): Promise<{
  name: string;
  duration: number;
  owner?: string;
  status?: string;
  chapters: { t: number; title: string }[];
  words: { text: string; start: number; end?: number }[];
}> {
  const dir = path.join(CLIPS_DIR, id);
  const meta = JSON.parse(
    await readFile(path.join(dir, "meta.json"), "utf-8"),
  ) as {
    name?: string;
    owner?: string;
    duration?: number;
    status?: string;
    chapters?: { t: number; title: string }[];
    blocks?: { kind: string; chapters?: { t: number; title: string }[] }[];
  };
  let words: { text: string; start: number; end?: number }[] = [];
  try {
    const tr = JSON.parse(
      await readFile(path.join(dir, "transcript.json"), "utf-8"),
    ) as { words?: { text: string; start: number; end?: number }[] };
    words = tr.words ?? [];
  } catch {
    /* none */
  }
  const chapters =
    meta.chapters?.length
      ? meta.chapters
      : meta.blocks?.find((b) => b.kind === "chapters")?.chapters ?? [];
  return {
    name: meta.name || "Untitled clip",
    duration: meta.duration || 0,
    owner: meta.owner,
    status: meta.status,
    chapters,
    words,
  };
}

export async function generateGuideFromClip({
  prompt,
  note,
  clipId,
  assetsDir,
}: {
  prompt: string;
  note?: string;
  clipId: string;
  assetsDir: string;
}): Promise<{ title: string; guide: GuideDoc; markdown: string }> {
  const clip = await loadClip(clipId);
  if (clip.status && clip.status !== "ready") {
    throw new Error("That clip is still processing");
  }
  if (!clip.words.length) {
    throw new Error("That clip has no transcript to write from");
  }
  const recording = await getClipRecordingPath(clipId);
  const excerpt = timedTranscript(clip.words);
  const chapterLines = clip.chapters
    .map((ch) => `- [${Math.round(ch.t)}s] ${ch.title}`)
    .join("\n");

  const user = [
    prompt.trim() ? `Author brief:\n${prompt.trim().slice(0, 4000)}` : "",
    note?.trim() ? `How to use this source:\n${note.trim().slice(0, 400)}` : "",
    `Title: ${clip.name}`,
    `Duration: ${Math.round(clip.duration)}s`,
    chapterLines ? `Chapters:\n${chapterLines}` : "",
    `Transcript:\n${excerpt}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const plan = await completeWithFallback(
    `You turn a narrated screen recording into a step-by-step how-to guide.
Return JSON only:
{"title":"short title","purpose":"one sentence goal","prerequisites":["optional"],"verification":["how to confirm it worked"],"steps":[{"title":"imperative","instruction":"1-3 sentences, what to click or type","startSec":0,"endSec":4,"atSec":1.2}]}
Rules:
- 3-12 steps covering the whole procedure, in order.
- Only facts from the transcript. Do not invent UI that is not spoken.
- startSec/endSec/atSec are seconds from the start and must match [mm:ss] markers.
- atSec is the moment the result is visible, usually shortly after the action is spoken.
- Skip greetings, recap, and outro.
- No markdown.`,
    user,
    undefined,
    (text) => parseGuidePlan(text, clip.duration),
    aiFor(clip.owner, "notes", "Guide Builder"),
  );

  await mkdir(assetsDir, { recursive: true });

  const mediaFor = async (
    index: number,
    atSec: number,
    alt: string,
  ): Promise<GuideMedia[]> => {
    if (!recording) return [];
    const requestedMs = Math.max(0, Math.round(atSec * 1000));
    try {
      const jpeg = await extractClipJpegFrame({
        src: recording,
        cacheDir: clipFramesDir(clipId),
        atMs: requestedMs,
      });
      if (!jpeg.length) return [];
      const assetId = `step-${index + 1}.jpg`;
      await writeFile(path.join(assetsDir, assetId), jpeg);
      return [
        {
          assetId,
          requestedMs,
          actualMs: requestedMs,
          alt,
        },
      ];
    } catch {
      return [];
    }
  };

  const filled: GuideMedia[][] = [];
  for (let i = 0; i < plan.steps.length; i++) {
    filled.push(await mediaFor(i, plan.steps[i].atSec, plan.steps[i].title));
  }

  const guide = planToGuide(plan, clipId, (i) => filled[i] ?? []);
  const title = plan.title || clip.name;
  return { title, guide, markdown: guideToMarkdown(title, guide) };
}
