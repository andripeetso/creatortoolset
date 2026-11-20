// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";

// The designs list draws many cards: a font is fetched once for all of them, and the words measured without it are
// forgotten once when it arrives (not once for every text of every card).
const forgetWords = vi.fn();
vi.mock("@/lib/design/layout", async (load) => ({ ...(await load<typeof import("@/lib/design/layout")>()), forgetWords }));
const { fontLoad } = await import("./DesignThumb");

it("fetches a font once for every card, and forgets the measured words once when it arrives", async () => {
  const fetchFont = vi.fn(() => Promise.resolve([]));
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: fetchFont, check: () => false } });
  const cards = [fontLoad('700 100px "Anton"'), fontLoad('700 100px "Anton"'), fontLoad('700 100px "Anton"')];
  await Promise.all(cards);
  expect(fetchFont).toHaveBeenCalledTimes(1);
  expect(forgetWords).toHaveBeenCalledTimes(1);
  await fontLoad('400 100px "Caveat"');
  expect([fetchFont.mock.calls.length, forgetWords.mock.calls.length]).toEqual([2, 2]);
});
