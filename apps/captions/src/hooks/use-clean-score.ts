import { useEffect, useRef, useState } from "react";
import type { QuickScore } from "@contracts/clean-fingerprints";
import type { EditOptions } from "@contracts/clean-edit";
import { draftFetch } from "@/lib/clean-edit";

export function useCleanScore(
  sourceId: string | undefined,
  key: string,
  busy: boolean,
  action: "score" | "sscd",
) {
  const cache = useRef(new Map<string, QuickScore>());
  const [result, setResult] = useState<{
    key: string;
    score?: QuickScore;
    error?: string;
  }>();
  useEffect(() => {
    if (!sourceId || busy) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        const cached = cache.current.get(key);
        if (cached) {
          setResult({ key, score: cached });
          return;
        }
        const [, options] = JSON.parse(key) as [string, EditOptions];
        void draftFetch<QuickScore>(
          sourceId,
          action,
          options,
          controller.signal,
          (r) => r.json(),
        )
          .then((score) => {
            if (controller.signal.aborted) return;
            const measured = action === "sscd" ? score.sscd : score.pdq;
            // Errors stay retryable; only actual measurements enter the result cache.
            if (measured?.status === "ok") {
              cache.current.set(key, score);
              if (cache.current.size > 24)
                cache.current.delete(cache.current.keys().next().value!);
            }
            setResult({ key, score });
          })
          .catch((error: Error) => {
            if (!controller.signal.aborted)
              setResult({ key, error: error.message });
          });
      },
      action === "score" ? 160 : 500,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [sourceId, key, busy, action]);
  return result;
}
