import { useEffect, useState } from "react";
import { useStudio } from "@/lib/store";
import { canUseCloud, isGuest, useViewedMe } from "@/lib/auth";
import {
  CLOUD_MODEL,
  CLOUD_MODEL_ID,
  MODELS,
  cloudStatus,
} from "@/lib/transcribe";

/**
 * Transcription engine <select> bound to the store. Offers the cloud
 * engine when the server has a key, greyed out for accounts that may
 * not use it. Shared by the player CTA, project setup and settings.
 */
export function EnginePicker({ className }: { className?: string }) {
  const model = useStudio((s) => s.model);
  const setModel = useStudio((s) => s.setModel);
  const me = useViewedMe();
  const allowedByView = canUseCloud(me);
  const [cloud, setCloud] = useState({ available: false, allowed: false });

  useEffect(() => {
    cloudStatus().then((c) => {
      const visibleCloud = { ...c, allowed: c.allowed && allowedByView };
      setCloud(visibleCloud);
      // a restored cloud choice may no longer be usable (key removed,
      // account locked) — fall back so the picker and the engine agree.
      // Session-only on purpose: the stored preference stays, so cloud
      // comes back by itself once access returns.
      if (
        useStudio.getState().model === CLOUD_MODEL_ID &&
        !(visibleCloud.available && visibleCloud.allowed)
      ) {
        useStudio.setState({ model: MODELS[0].id });
      }
    });
  }, [allowedByView]);

  const lockedNote = isGuest(me) ? "sign in to use" : "locked, ask the admin";

  return (
    <select
      value={model}
      onChange={(e) => setModel(e.target.value)}
      className={className}
    >
      {(cloud.available ? [CLOUD_MODEL, ...MODELS] : MODELS).map((m) => {
        const locked = m.id === CLOUD_MODEL_ID && !cloud.allowed;
        return (
          <option key={m.id} value={m.id} disabled={locked}>
            {locked ? `🔒 ${m.label} — ${lockedNote}` : m.label}
          </option>
        );
      })}
    </select>
  );
}
