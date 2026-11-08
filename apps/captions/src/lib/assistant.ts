import { create } from "zustand";
import type { AssistantView } from "@contracts/assistant";

/**
 * The dock's client (components/assistant/AssistantDock.tsx) and its server calls (api/assistant.ts). The dock is open
 * or collapsed, and whether this browser has chosen a setup path, are per-viewer conveniences kept in localStorage.
 */

type AssistantState = {
  /** the dock is collapsed to its chat bubble */
  collapsed: boolean;
  /** the setup choice was asked for (openAssistant("setup")): show the choices again */
  setupAsked: boolean;
  set: (patch: Partial<Pick<AssistantState, "collapsed" | "setupAsked">>) => void;
};

export const useAssistant = create<AssistantState>((set) => ({
  collapsed: false,
  setupAsked: false,
  set: (patch) => set(patch),
}));

/** Open the dock from anywhere; "setup" starts it at the choice of setup paths. */
export function openAssistant(mode?: "setup"): void {
  useAssistant.getState().set({ collapsed: false, setupAsked: mode === "setup" });
}

const keyOf = (user: string, what: string) => `ct-assistant:${what}:${user}`;

/** This browser's remembered answer for one account (no storage = not remembered). */
export function rememberedFor(user: string): string | null {
  try {
    return localStorage.getItem(keyOf(user, "choice"));
  } catch {
    return null;
  }
}

/** "self" | "chat" | "later" */
export function remember(user: string, value: string): void {
  try {
    localStorage.setItem(keyOf(user, "choice"), value);
  } catch {
    /* private window or blocked storage: the answer is just asked again */
  }
}

/** A JSON call to the assistant; a refusal carries the server's sentence. */
async function call<T>(path: string, method = "GET", body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string; code?: string }> {
  const r = await fetch(`/api/assistant${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  if (!r) return { ok: false, error: "Can't reach the server" };
  const data = (await r.json().catch(() => ({}))) as T & { error?: string; code?: string };
  return r.ok ? { ok: true, data } : { ok: false, error: data.error ?? `Failed (${r.status})`, code: data.code };
}

export const getAssistant = () => call<AssistantView>("");
export const sendTurn = (text: string) => call<AssistantView>("/turn", "POST", { text });
export const keySaved = (env: string) => call<AssistantView>("/saved", "POST", { env });
export const cancelSecret = () => call<AssistantView>("/cancel", "POST");
export const navigated = () => call<AssistantView>("/navigated", "POST");

/** The key goes straight from the box to my-keys: the assistant's record only ever sees "saved". */
export const saveKey = (env: string, value: string) =>
  fetch(`/api/my-keys/${encodeURIComponent(env)}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  }).then(async (r) => (r.ok ? { ok: true as const } : { ok: false as const, error: ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't save the key" }));
