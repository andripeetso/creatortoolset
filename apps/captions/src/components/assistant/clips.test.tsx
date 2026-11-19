// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { CLIP_CARDS, MAX_CLIPS, readClips, withClips, type DraggedClip } from "@/lib/chat-clips";
import { turnOf } from "./AssistantDock";
import { Composer } from "./Composer";
import { EMPTY_DRAFT, draftEmpty, type Draft } from "./draft";

// Clips dragged from the Media Library into the chat: a chip each in the box, removable, a clip twice is once, and the
// message carries their version ids (what the tools take) with nothing to upload.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cartwheel: DraggedClip = { id: "ast_1", versionId: "v_1", title: "Tiny Acrobatics cartwheel", thumbUrl: "/api/library/media/v_1/thumb" };
const handstand: DraggedClip = { id: "ast_2", versionId: "v_2", title: "Tiny Acrobatics handstand" };
const drop = (data: Record<string, string>) => ({ getData: (t: string) => data[t] ?? "" });

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
});

it("a drop of the library's clips reads each one; anything else is none", () => {
  expect(readClips(drop({ [CLIP_CARDS]: JSON.stringify([cartwheel, handstand, { id: "x" }]) }))).toEqual([cartwheel, handstand]);
  expect(readClips(drop({ [CLIP_CARDS]: "not json" }))).toEqual([]);
  expect(readClips(drop({ "text/plain": "hello" }))).toEqual([]);
});

it("a clip already in the box, or twice in one drop, is added once; never more than the limit", () => {
  expect(withClips([cartwheel], [cartwheel, handstand, handstand])).toEqual([cartwheel, handstand]);
  const many = Array.from({ length: MAX_CLIPS + 5 }, (_, i) => ({ id: `a${i}`, versionId: `v${i}`, title: `Clip ${i}` }));
  expect(withClips([], many)).toHaveLength(MAX_CLIPS);
  expect(draftEmpty({ ...EMPTY_DRAFT, clips: [cartwheel] })).toBe(false);
});

it("each clip is a chip with its picture and name; its × takes that one out", () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const noop = () => {};
  function Box() {
    const [draft, setDraft] = useState<Draft>({ ...EMPTY_DRAFT, clips: [cartwheel, handstand] });
    return <Composer draft={draft} setDraft={setDraft} onSend={noop} onStop={noop} onFiles={noop} onPaste={() => false} quote={null} onDropQuote={noop} waiting={false} />;
  }
  act(() => root!.render(<Box />));
  expect(host.textContent).toContain("Tiny Acrobatics cartwheel");
  expect(host.textContent).toContain("Tiny Acrobatics handstand");
  expect(host.querySelector<HTMLImageElement>('img[src="/api/library/media/v_1/thumb"]')).not.toBeNull();
  act(() => host!.querySelector<HTMLButtonElement>('button[aria-label="Remove Tiny Acrobatics cartwheel"]')!.click());
  expect(host.textContent).not.toContain("Tiny Acrobatics cartwheel");
  expect(host.textContent).toContain("Tiny Acrobatics handstand");
});

it("the message carries the clips as version ids, and nothing to upload", () => {
  expect(turnOf({ text: "Use these", clips: [cartwheel, handstand] })).toEqual({ text: "Use these", clips: ["v_1", "v_2"] });
  expect(turnOf({ text: "Hi" })).toEqual({ text: "Hi" });
});
