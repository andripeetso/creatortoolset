// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const confirmed = vi.hoisted(() => ({ answer: false, asked: [] as string[] }));
vi.mock("@/lib/dialogs", () => ({
  confirmDialog: async (o: { title: string; body?: string }) => {
    confirmed.asked.push(`${o.title} ${o.body}`);
    return confirmed.answer;
  },
}));
const { InstagramAdd, RISK } = await import("./InstagramAdd");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  confirmed.asked = [];
});

async function open() {
  const posts: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posts.push(url);
    return new Response(JSON.stringify({ allowed: true, chrome: true, signedIn: false, signingIn: init?.method === "POST", error: null }), { headers: { "Content-Type": "application/json" } });
  });
  const el = document.createElement("div");
  document.body.append(el);
  await act(async () => {
    root = createRoot(el);
    root.render(<InstagramAdd open onOpenChange={() => {}} />);
  });
  const signIn = [...document.querySelectorAll("button")].find((b) => b.textContent === "Sign in")!;
  await act(async () => signIn.click());
  return posts;
}

describe("Add from Instagram, signed out", () => {
  it("shows the risks, and Sign in asks once more before Chrome opens", async () => {
    confirmed.answer = false;
    const posts = await open();
    expect(document.body.textContent).toContain(RISK);
    expect(confirmed.asked).toEqual([`Sign in to Instagram? ${RISK}`]);
    expect(posts).toEqual([]);
  });

  it("starts the sign-in once confirmed", async () => {
    confirmed.answer = true;
    expect(await open()).toEqual(["/api/library/instagram/login"]);
  });
});
