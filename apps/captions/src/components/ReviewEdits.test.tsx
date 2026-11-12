import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { ReviewSlotContext } from "@/lib/plugin";
import ReviewEdits from "./ReviewEdits";

// The panel shows nothing until the version has a timeline (an AI edit's or an imported one) and it has loaded. Its chips, payload and ⌘Z need a DOM
//, so those are checked through edit-history.test.ts; this covers the first-paint rule.
const ctx = (version: object) => ({ version, api: {}, player: {}, composer: {}, history: {}, sent: [], manage: true }) as unknown as ReviewSlotContext;

test("the panel is empty until the version has a timeline and it has loaded", () => {
  expect(renderToStaticMarkup(<ReviewEdits {...ctx({ n: 1, timeline: false, fps: 25 })} />)).toBe("");
  expect(renderToStaticMarkup(<ReviewEdits {...ctx({ n: 1, timeline: true, fps: 25 })} />)).toBe("");
});
