// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useAuth } from "@/lib/auth";
import { CLIPS_AVAILABILITY, type ClipSession } from "@/lib/clips";
import { putCached } from "@/lib/local-cache";
import { useChapters } from "./ClipBlocks";

// The chapters row of a clip: what it holds from the first frame until the request has ended. A request that ends with
// no chapters must leave the row saying so (with Try again), never nothing: the page under it would jump up. With no AI
// connected there is nothing to ask and no row at all.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clip: ClipSession = {
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
};

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let replies: Array<{ status: number; body: unknown }> = [];
let asked: string[] = [];
/** what the server says of this install: is an AI connected */
let ai = true;
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));

function Row() {
  const making = useChapters(clip, true, () => {});
  return (
    <p>
      {making.pending ? "generating" : making.failed ? `failed: ${making.failed}` : "nothing"}
      <button onClick={making.retry}>Try again</button>
    </p>
  );
}
const mount = () => {
  asked = [];
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(String(url));
    if (String(url).endsWith("/availability")) return new Response(JSON.stringify({ cloud: false, ai }), { status: 200 });
    const r = replies.shift() ?? { status: 400, body: { error: "No more replies" } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(<Row />));
};
const says = () => host!.querySelector("p")!.firstChild!.textContent;

afterEach(() => {
  ai = true;
  useAuth.getState().setAuth(true, null);
  if (root) act(() => root!.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

it("a request that ends with no chapters leaves the row in place, saying why, and Try again asks once more", async () => {
  replies = [
    { status: 400, body: { error: "No AI is set up for you yet." } },
    { status: 200, body: { ...clip, chapters: [{ t: 0, title: "Warm-up" }] } },
  ];
  mount();
  expect(says()).toBe("generating"); // the first frame
  await flush();
  expect(says()).toBe("failed: No AI is set up for you yet."); // never "nothing"
  act(() => host!.querySelector("button")!.click());
  expect(says()).toBe("generating");
  await flush();
  // the answer has chapters: the row keeps saying so until they are on the page's clip (this test's clip never changes),
  // so there is no frame with nothing between "generating" and the chapters
  expect(says()).toBe("generating");
});

it("an answer without chapters is a failure too, in plain words", async () => {
  replies = [{ status: 200, body: { ...clip, chapters: [] } }];
  mount();
  await flush();
  expect(says()).toBe("failed: Couldn't make chapters.");
});

it("with no AI connected, as the saved copy says before the first frame, it asks for nothing and draws no row", async () => {
  ai = false;
  useAuth.getState().setAuth(true, { username: "tiny-owner", role: "admin", cloud: false, off: [] });
  putCached("tiny-owner", CLIPS_AVAILABILITY, { cloud: false, ai: false });
  mount();
  expect(says()).toBe("nothing"); // the first frame
  await flush();
  expect(says()).toBe("nothing");
  expect(asked.filter((u) => u.includes("/blocks"))).toEqual([]);
});
