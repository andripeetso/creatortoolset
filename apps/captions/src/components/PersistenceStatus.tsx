import { Check, Loader2, TriangleAlert } from "lucide-react";
import { getProjectPersistenceStatus } from "@/lib/persistence-status";
import { useStudio } from "@/lib/store";

function useProjectPersistenceStatus() {
  const projectId = useStudio((s) => s.projectId);
  const serverProjectReady = useStudio((s) => s.serverProjectReady);
  const saveState = useStudio((s) => s.saveState);
  const localSaveState = useStudio((s) => s.localSaveState);
  const clips = useStudio((s) => s.clips);
  return getProjectPersistenceStatus({
    projectId,
    serverProjectReady,
    saveState,
    localSaveState,
    clips,
  });
}

export function PersistenceBadge({ compact = false }: { compact?: boolean }) {
  const status = useProjectPersistenceStatus();
  if (status.badge === "NO PROJECT OPEN") return null;

  const tone =
    status.tone === "saved"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : status.tone === "saving"
        ? "border-zinc-500/40 bg-zinc-500/10 text-zinc-300"
        : status.tone === "warning"
          ? "border-amber-500/35 bg-amber-500/10 text-amber-300"
          : "border-rose-500/35 bg-rose-500/10 text-rose-300";
  const Icon =
    status.tone === "saved"
      ? Check
      : status.tone === "saving"
        ? Loader2
        : TriangleAlert;

  return (
    <span
      role={status.fullySaved ? "status" : "alert"}
      title={status.message ?? "This project is fully saved on the server."}
      className={`flex shrink-0 items-center gap-1.5 rounded-md border font-medium tracking-normal ${tone} ${compact ? "px-1.5 py-1 text-[9px]" : "px-2 py-1 text-[10px]"}`}
    >
      <Icon
        className={`shrink-0 ${compact ? "h-3 w-3" : "h-3.5 w-3.5"} ${status.tone === "saving" ? "animate-spin" : ""}`}
      />
      <span>{status.badge}</span>
    </span>
  );
}
