import { create } from "zustand";
import type { AssistantView } from "@contracts/assistant";

/**
 * The dock's client (components/assistant/AssistantDock.tsx) and its server calls (api/assistant.ts). The dock is open
 * or collapsed (it starts collapsed).
 */

type AssistantState = {
  /** the dock is collapsed to its chat bubble */
  collapsed: boolean;
  /** the setup choice was asked for (openAssistant("setup")): show the choices again */
  setupAsked: boolean;
  set: (patch: Partial<Pick<AssistantState, "collapsed" | "setupAsked">>) => void;
};

export const useAssistant = create<AssistantState>((set) => ({
  // folded to its bubble until clicked: setup is the one first-run flow, the chat never opens by itself
  collapsed: true,
  setupAsked: false,
  set: (patch) => set(patch),
}));

/** Open the dock from anywhere; "setup" starts it at the choice of setup paths. */
export function openAssistant(mode?: "setup"): void {
  useAssistant.getState().set({ collapsed: false, setupAsked: mode === "setup" });
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
export const stopTurn = () => call<AssistantView>("/stop", "POST");
export const keySaved = (env: string) => call<AssistantView>("/saved", "POST", { env });
export const cancelSecret = () => call<AssistantView>("/cancel", "POST");
export const navigated = () => call<AssistantView>("/navigated", "POST");
export const startOver = () => call<AssistantView>("", "DELETE");
export const openPast = (id: string) => call<AssistantView>(`/past/${encodeURIComponent(id)}/open`, "POST");
export const deletePast = (id: string) => call<AssistantView>(`/past/${encodeURIComponent(id)}`, "DELETE");

/** A conversation as plain text, for Copy. */
export const chatText = (messages: Array<{ role: string; text: string }>): string =>
  messages
    .filter((m) => m.text.trim())
    .map((m) => `${m.role === "user" ? "Me" : m.role === "note" ? "Note" : "Assistant"}:\n${m.text.trim()}`)
    .join("\n\n");

/** The key goes straight from the box to my-keys: the assistant's record only ever sees "saved". */
export const saveKey = (env: string, value: string) =>
  fetch(`/api/my-keys/${encodeURIComponent(env)}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  }).then(async (r) => (r.ok ? { ok: true as const } : { ok: false as const, error: ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't save the key" }));
