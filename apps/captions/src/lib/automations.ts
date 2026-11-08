import type { Automation } from "@contracts/automations";

/** Settings → Automations' calls (api/automations.ts). Creating one is done by the assistant or an AI over MCP. */

export type AutomationView = Automation & { running: boolean; nextRun: number | null };

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api/automations${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  if (!r) throw new Error("Can't reach the server");
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `Failed (${r.status})`);
  return data;
}

export const listAutomations = () => call<{ items: AutomationView[] }>("");
export const updateAutomation = (id: string, patch: { enabled?: boolean }) => call<AutomationView>(`/${id}`, "PATCH", patch);
export const deleteAutomation = (id: string) => call<{ ok: true }>(`/${id}`, "DELETE");
export const runAutomationNow = (id: string) => call<AutomationView>(`/${id}/run`, "POST");
