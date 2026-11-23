import { useEffect, useState } from "react";
import type { Me } from "@/lib/auth";
import { webPlugins } from "@/plugins.gen";

/**
 * The Face Blur plug-in as the Media Library sees it (editor-steps/blur-faces, docs/face-blur-intake-prd.md): whether it
 * is on in a workspace, and the blur state of one file from its GET /auto.
 */
export const FACE_BLUR = "blur-faces";

/** Face Blur is installed, on for this account, and not switched off in `workspace` (pluginsOff from useWorkspace). */
export function faceBlurOn(me: Me | null, pluginsOff: Record<string, string[]> | undefined, workspace: string | null | undefined, plugins: { id: string }[] = webPlugins): boolean {
  if (!me || !plugins.some((p) => p.id === FACE_BLUR)) return false;
  if (me.role !== "admin" && me.off.includes(FACE_BLUR)) return false;
  return !(pluginsOff?.[workspace ?? ""] ?? []).includes(FACE_BLUR);
}

/** plugin.ts GET /auto (PRD §3a) */
export type FaceBlurAuto = { can: boolean; why?: string; pausedUntil?: number; running?: string[]; failed?: { versionId: string; title: string; error: string }[] };

export type BlurState = { kind: "queued" } | { kind: "running" } | { kind: "failed" } | null;

/** One file's blur state: only a file marked Blur faces with no blurred version has one. */
export function blurState(versionId: string, notBlurred: boolean, auto: FaceBlurAuto | null): BlurState {
  if (!notBlurred) return null;
  if (auto?.failed?.some((f) => f.versionId === versionId)) return { kind: "failed" };
  if (auto?.running?.includes(versionId)) return { kind: "running" };
  return { kind: "queued" };
}

export const BLUR_WORDS = { queued: "Blur queued", running: "Blurring", failed: "Could not blur" } as const;

/** GET /auto while `on` (null: not read, absent, or failed: the file then reads as queued), read again every 15 s. */
export function useFaceBlurAuto(on: boolean): { auto: FaceBlurAuto | null; retry: (versionId: string) => Promise<void> } {
  const [auto, setAuto] = useState<FaceBlurAuto | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return setAuto(null);
    let live = true;
    const load = () =>
      fetch(`/api/x/${FACE_BLUR}/auto`)
        .then((r) => (r.ok ? (r.json() as Promise<FaceBlurAuto>) : null))
        .catch(() => null)
        .then((a) => live && setAuto(a));
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [on, n]);
  const retry = async (versionId: string) => {
    const r = await fetch(`/api/x/${FACE_BLUR}/auto/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versionId }) });
    if (!r.ok) throw new Error("Could not retry the blur");
    setN((x) => x + 1);
  };
  return { auto, retry };
}

const KEEP_KEY = "library-keep-as-filmed";
/** The libraries whose Blur faces checkbox was last left unticked (R11): this browser's own memory, never required. */
export function keptAsFilmed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEEP_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export function rememberKeepAsFilmed(libraryId: string, keep: boolean): void {
  try {
    const rest = keptAsFilmed().filter((id) => id !== libraryId);
    localStorage.setItem(KEEP_KEY, JSON.stringify(keep ? [...rest, libraryId] : rest));
  } catch {
    // no storage here: the choice lasts while the page is open
  }
}
