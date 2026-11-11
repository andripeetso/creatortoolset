import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ClipSession } from "@/lib/clips";
import { useAutoChapters, wantsChapters } from "./ClipBlocks";

const clip = (over: Partial<ClipSession> = {}): ClipSession => ({
  id: "c1",
  name: "Tiny Acrobatics warm-up",
  duration: 4,
  bytes: 1,
  mime: "video/mp4",
  status: "ready",
  progress: 1,
  createdAt: 0,
  updatedAt: 0,
  hasTranscript: true,
  hasThumb: false,
  ...over,
});

// the first frame: a static render runs no effects, so this is what is drawn before the request starts
function First({ session, owns }: { session: ClipSession; owns: boolean }) {
  return <>{useAutoChapters(session, owns, () => {}) ? "making chapters" : "quiet"}</>;
}
const first = (session: ClipSession, owns = true) => renderToStaticMarkup(<First session={session} owns={owns} />);

it("says chapters are being made on the first frame of a clip that will get them", () => {
  expect(first(clip())).toBe("making chapters");
});

it("stays quiet where no chapters are asked for", () => {
  expect(first(clip(), false)).toBe("quiet"); // someone else's clip
  expect(first(clip({ hasTranscript: false }))).toBe("quiet");
  expect(first(clip({ status: "processing" }))).toBe("quiet");
  expect(first(clip({ chapters: [{ t: 0, title: "Warm-up" }] }))).toBe("quiet");
  expect(wantsChapters(clip({ blocks: [{ id: "chapters", kind: "chapters", chapters: [{ t: 0, title: "Warm-up" }] }] }), true)).toBe(false);
});
