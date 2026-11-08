import type { AssistantContext, AssistantImage } from "@contracts/assistant";

/**
 * What the user is looking at, sent with each assistant message: the page, a few lines that say what's on screen,
 * and (in the Mac app) a picture of it. Never a form field's value: text inside inputs, textareas and selects is
 * skipped, so a password or a half-typed draft can't leak into the chat.
 */

/** The dock's own card: its headings and text aren't "the page". */
export const DOCK = 'section[aria-label="Assistant"]';

// not aria-hidden: an open modal marks the whole page behind it hidden, and the page is still what you're on
const SKIP = "input,textarea,select,option,script,style,noscript";
const MAX_VISIBLE = 2000;

/** An element's readable text, without anything typed into a field. */
export function textOf(el: Element): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.textContent ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** The lines of `visible`, deduplicated and cut to 2000 characters. */
export function describePage({ crumb, dialog, headings }: { crumb?: string; dialog?: string; headings: string[] }): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (line: string, key: string) => {
    const k = key.toLowerCase();
    if (!key || seen.has(k)) return;
    seen.add(k);
    lines.push(line);
  };
  if (crumb) add(`Page: ${crumb}`, crumb);
  if (dialog) add(`Open dialog: ${dialog}`, dialog);
  for (const h of headings) add(`- ${h}`, h);
  return lines.join("\n").slice(0, MAX_VISIBLE);
}

const onScreen = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
};

export function pageContext(): AssistantContext {
  const crumbEl = document.querySelector("[data-page-title]");
  const dialogEl = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter((d) => !d.closest(DOCK)).at(-1);
  let dialog: string | undefined;
  if (dialogEl) {
    const labelled = dialogEl.getAttribute("aria-labelledby");
    const titleEl = labelled ? document.getElementById(labelled) : dialogEl.querySelector("h1,h2,h3");
    dialog = (titleEl ? textOf(titleEl) : dialogEl.getAttribute("aria-label")) || undefined;
  }
  const headings = [...document.querySelectorAll("h1,h2,h3")]
    .filter((h) => !h.closest(DOCK) && !h.closest("[data-page-title]") && onScreen(h))
    .map(textOf)
    .filter(Boolean)
    .slice(0, 30);
  const visible = describePage({ crumb: crumbEl ? textOf(crumbEl) : undefined, dialog, headings });
  return { path: location.pathname + location.search, title: document.title, ...(visible ? { visible } : {}) };
}

type SnapshotHandler = { postMessage: (body: unknown) => Promise<unknown> };
const snapshotHandler = (): SnapshotHandler | undefined =>
  (window as unknown as { webkit?: { messageHandlers?: { snapshot?: SnapshotHandler } } }).webkit?.messageHandlers?.snapshot;

/** A picture of the screen is only possible in the Mac app (it takes it natively; a browser would have to ask). */
export const canSnapshot = (): boolean => !!snapshotHandler();

/** The visible page as a PNG (at most 2000 px on its longest side), or null outside the Mac app or on failure. */
export async function snapshot(): Promise<AssistantImage | null> {
  const handler = snapshotHandler();
  if (!handler) return null;
  try {
    const data = await handler.postMessage(null);
    if (typeof data !== "string" || !data) return null;
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, ".");
    return { name: `Screen ${stamp}.png`, type: "image/png", data: data.replace(/^data:image\/png;base64,/, "") };
  } catch {
    return null;
  }
}
