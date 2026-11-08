import { useCallback, useState } from "react";
import { Link } from "react-router";
import { Captions, ChevronLeft, CloudOff } from "lucide-react";
import { useStudio } from "@/lib/store";
import { flushPendingSave } from "@/lib/persist";
import { canUseCloud, useMe } from "@/lib/auth";
import { CLOUD_MODEL_ID } from "@/lib/transcribe";
import { MobileImport } from "@/components/mobile/MobileImport";
import { MobileTranscribe } from "@/components/mobile/MobileTranscribe";
import { MobileEditor } from "@/components/mobile/MobileEditor";
import { MobileExport } from "@/components/mobile/MobileExport";
import { PersistenceBadge } from "@/components/PersistenceStatus";
import { confirmDiscardUnsavedProject } from "@/lib/persistence-guard";

type Step = "import" | "transcribe" | "edit" | "export";

const STEP_LABEL: Record<Step, string> = {
  import: "1 · Import",
  transcribe: "2 · Transcribe",
  edit: "3 · Edit",
  export: "4 · Export",
};

/** Account without cloud access — mobile has no on-device fallback. */
function CloudLocked() {
  return (
    <div className="pt-safe pb-safe flex h-dvh flex-col items-center justify-center bg-zinc-950 px-8 text-zinc-200">
      <CloudOff className="h-10 w-10 text-zinc-500" />
      <h1 className="mt-4 text-center text-xl font-semibold tracking-tight">
        Cloud transcription is off for this account
      </h1>
      <p className="mt-2 max-w-xs text-center text-sm leading-6 text-zinc-400">
        Mobile captioning needs the cloud engine — ask an admin to enable it.
      </p>
      <Link
        to="/m"
        className="mt-6 text-sm text-violet-300 active:text-violet-200"
      >
        All tools
      </Link>
    </div>
  );
}

/**
 * The mobile caption flow (/m/captions): one clip, cloud transcription
 * only, four steps. The desktop editor's multi-clip machinery (clip pool,
 * apply-master, timeline) is untouched — this drives the same store
 * with a single clip and hides everything else.
 */
export default function MobileCaptionPage() {
  const me = useMe();
  const [step, setStep] = useState<Step>("import");
  const fileName = useStudio((s) => s.fileName);
  const hasCurrent = useStudio((s) => s.clips.length > 0);

  const startWithFile = useCallback((file: File, script: string) => {
    if (!confirmDiscardUnsavedProject("Start a new project")) return;
    void flushPendingSave();
    const st = useStudio.getState();
    st.reset();
    st.importFiles([file]);
    st.setScript(script);
    // no setup dialog on mobile
    st.dismissSetup();
    // cloud-only: set the engine without persisting over the desktop choice
    useStudio.setState({ model: CLOUD_MODEL_ID });
    setStep("transcribe");
  }, []);

  if (me === null) return <div className="h-dvh bg-zinc-950" />;
  if (!canUseCloud(me)) return <CloudLocked />;

  const back =
    step === "edit"
      ? () => setStep("import")
      : step === "export"
        ? () => setStep("edit")
        : null;

  const title =
    step === "import"
      ? "Caption Studio"
      : step === "transcribe"
        ? "Transcribing"
        : fileName.replace(/\.[^.]+$/, "") || "Caption Studio";

  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-zinc-200">
      <header className="pt-safe flex h-14 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-925 px-2">
        {back ? (
          <button
            onClick={back}
            title="Back"
            className="rounded-lg p-2 text-zinc-300 active:bg-zinc-800"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        ) : (
          <Link
            to="/m"
            title="All tools"
            className="rounded-lg p-2 text-zinc-300 active:bg-zinc-800"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
        )}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-600">
          <Captions className="h-4 w-4 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-4">{title}</p>
          <p className="mt-0.5 text-[10px] text-zinc-500">{STEP_LABEL[step]}</p>
        </div>
        {hasCurrent && <PersistenceBadge compact />}
      </header>

      {step === "import" && (
        <MobileImport
          onPick={startWithFile}
          hasCurrent={hasCurrent}
          onContinue={() => setStep("edit")}
        />
      )}
      {step === "transcribe" && (
        <MobileTranscribe
          onDone={() => setStep("edit")}
          onRestart={() => {
            if (!confirmDiscardUnsavedProject("Restart this project")) return;
            void flushPendingSave();
            useStudio.getState().reset();
            setStep("import");
          }}
        />
      )}
      {step === "edit" && <MobileEditor onExport={() => setStep("export")} />}
      {step === "export" && <MobileExport />}
    </div>
  );
}
