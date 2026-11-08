import { useEffect } from "react";
import { Captions, TriangleAlert } from "lucide-react";
import { activeCadenceOutcome, useStudio } from "@/lib/store";
import { CLOUD_MODEL_ID } from "@/lib/transcribe";
import {
  CadenceProcessingStatus,
  CloudTranscriptionStatus,
  ExtractionProcessingStatus,
  ModelLoadingStatus,
  OnDeviceTranscriptionStatus,
  ScriptCheckProcessingStatus,
} from "../Player";

/**
 * Step 2: transcription, auto-started. The store handles the selected engine
 * and lands words + cues; this screen mirrors desktop processing feedback and
 * advances only after the visible 100% completion beat.
 */
export function MobileTranscribe({
  onDone,
  onRestart,
}: {
  onDone: () => void;
  onRestart: () => void;
}) {
  const status = useStudio((s) => s.status);
  const words = useStudio((s) => s.words);
  const duration = useStudio((s) => s.duration);
  const model = useStudio((s) => s.model);
  const cadenceRunOutcome = useStudio(activeCadenceOutcome);
  const cadenceApplied = useStudio((s) => s.cadenceApplied);

  useEffect(() => {
    const st = useStudio.getState();
    if (st.status.phase === "idle" || st.status.phase === "error") {
      st.runTranscription();
    }
  }, []);

  useEffect(() => {
    if (status.phase === "done" && words.length > 0) {
      // Match desktop's visible 100% completion beat before opening the editor.
      const t = setTimeout(onDone, 900);
      return () => clearTimeout(t);
    }
  }, [status, words, onDone]);

  const retry = () => useStudio.getState().runTranscription();

  // engine succeeded but heard nothing — no point opening the editor
  const noSpeech = status.phase === "done" && words.length === 0;
  const cadenceCompleted =
    status.phase === "done" &&
    cadenceApplied &&
    cadenceRunOutcome === "completed";

  const processingStatus = (() => {
    if (status.phase === "extracting") {
      return <ExtractionProcessingStatus duration={duration} />;
    }
    if (status.phase === "loading") {
      return (
        <ModelLoadingStatus
          progress={status.progress}
          detail={status.detail}
        />
      );
    }
    if (status.phase === "checking") {
      return <ScriptCheckProcessingStatus />;
    }
    if (status.phase === "matching") {
      return <CadenceProcessingStatus complete={false} />;
    }
    if (cadenceCompleted) {
      return <CadenceProcessingStatus complete />;
    }
    const complete = status.phase === "done";
    return model === CLOUD_MODEL_ID ? (
      <CloudTranscriptionStatus duration={duration} complete={complete} />
    ) : (
      <OnDeviceTranscriptionStatus duration={duration} complete={complete} />
    );
  })();

  return (
    <div className="pb-safe flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-3 sm:px-8">
      {noSpeech ? (
        <>
          <Captions className="h-10 w-10 text-zinc-500" />
          <div className="text-center">
            <p className="text-base font-medium text-zinc-100">
              No speech found
            </p>
            <p className="mt-1.5 max-w-xs text-sm leading-6 text-zinc-500">
              The transcription came back empty — this video doesn&apos;t seem
              to have spoken words.
            </p>
          </div>
          <button
            onClick={onRestart}
            className="rounded-xl bg-violet-600 px-8 py-3 text-base font-semibold text-white active:bg-violet-500"
          >
            Choose another video
          </button>
        </>
      ) : status.phase !== "error" ? (
        <div
          role="status"
          aria-live="polite"
          className="flex w-full max-w-[30rem] items-center rounded-xl border border-zinc-700/80 bg-zinc-900/95 px-3 py-3 shadow-xl"
        >
          {processingStatus}
        </div>
      ) : (
        <>
          <TriangleAlert className="h-10 w-10 text-red-400" />
          <div className="text-center">
            <p className="text-base font-medium text-zinc-100">
              Transcription failed
            </p>
            <p className="mt-1.5 max-w-xs text-sm leading-6 text-zinc-500">
              {status.message}
            </p>
          </div>
          <button
            onClick={retry}
            className="rounded-xl bg-violet-600 px-8 py-3 text-base font-semibold text-white active:bg-violet-500"
          >
            Retry
          </button>
        </>
      )}
    </div>
  );
}
