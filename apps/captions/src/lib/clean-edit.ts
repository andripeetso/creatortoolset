import type {
  EditAudit,
  EditMeasurement,
  EditOptions,
} from "@contracts/clean-edit";

async function editFetch(
  id: string,
  action: string,
  body: unknown,
  signal?: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(
      `/api/clean/sources/${encodeURIComponent(id)}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (response.status === 409 && attempt < 20 && !signal?.aborted) {
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      continue;
    }
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(data.error || "Could not render this edit.");
    }
    return response;
  }
}
// A single client clock orders draft requests even if the network delivers them
// out of order. Cancellation is explicit because proxies can buffer disconnects.
const client = crypto.randomUUID();
let revision = 0;
export async function draftFetch<T>(
  id: string,
  action: string,
  body: unknown,
  signal: AbortSignal,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const headers = {
    "Content-Type": "application/json",
    "X-Clean-Client": client,
    "X-Clean-Revision": String(++revision),
  };
  const cancel = () => {
    void fetch(
      `/api/clean/sources/${encodeURIComponent(id)}/${action === "score" || action === "sscd" ? action : "draft"}/cancel`,
      {
        method: "POST",
        headers,
        keepalive: true,
      },
    ).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    // Drafts never enter the 409 retry loop. The server replaces older work.
    const response = await fetch(
      `/api/clean/sources/${encodeURIComponent(id)}/${action}`,
      { method: "POST", headers, body: JSON.stringify(body), signal },
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Could not render this edit.");
    }
    return await read(response);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
export async function measureEdit(
  id: string,
  options: EditOptions,
  signal: AbortSignal,
): Promise<EditMeasurement> {
  return draftFetch(id, "measure", options, signal, (response) =>
    response.json(),
  );
}
export async function previewEditFrame(
  id: string,
  options: EditOptions,
  seconds: number,
  signal: AbortSignal,
) {
  return draftFetch(id, "frame", { options, seconds }, signal, (response) =>
    response.blob(),
  );
}
export async function downloadEdit(
  id: string,
  name: string,
  options: EditOptions,
) {
  const blob = await (await editFetch(id, "export", options)).blob();
  saveCleanBlob(blob, name.replace(/\.[^.]+$/, "") + "-edited.mp4");
}
export function saveCleanBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function auditEdit(
  id: string,
  options: EditOptions,
  signal: AbortSignal,
): Promise<EditAudit> {
  return draftFetch(id, "audit", options, signal, (response) =>
    response.json(),
  );
}
