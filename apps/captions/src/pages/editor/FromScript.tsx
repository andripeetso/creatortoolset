import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { VoicesView } from "@contracts/editor";
import type { Collection } from "@contracts/library";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { listVoices } from "@/lib/editor";

const SELECT = "h-9 w-fit max-w-full rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm";

/**
 * New edit with nothing filmed: the script, the voice that says it (one of the person's ElevenLabs voices, their own
 * first, opening on the one used last) and where the picture comes from (a Media Library folder; with none chosen, the
 * picked style's B-roll folder, or all their B-roll).
 */
export function FromScript({
  script,
  onScript,
  voice,
  onVoice,
  folders,
  broll,
  onBroll,
  styleFolder,
}: {
  script: string;
  onScript: (text: string) => void;
  voice: string;
  onVoice: (id: string) => void;
  folders: Collection[];
  broll: string;
  onBroll: (id: string) => void;
  /** the B-roll folder of the editing style picked, if it names one: what the edit uses when no folder is chosen here */
  styleFolder: string | null;
}) {
  const [view, setView] = useState<VoicesView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listVoices().then(
      (v) => {
        setView(v);
        // the voice used last, else the first of their own (one they made), else none: they choose
        if (!voice) onVoice(v.last ?? v.voices.find((x) => x.own)?.id ?? "");
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preview = view?.voices.find((v) => v.id === voice)?.preview;
  const own = view?.voices.filter((v) => v.own) ?? [];
  const others = view?.voices.filter((v) => !v.own) ?? [];
  return (
    <section aria-label="Script and voice" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="edit-spoken">Script</Label>
        <Textarea id="edit-spoken" value={script} onChange={(e) => onScript(e.target.value)} rows={8} maxLength={5000} placeholder="What the voice says" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="edit-voice">Voice</Label>
        {error ? (
          <p className="text-sm text-zinc-500">
            {error}
            {/Settings → API keys/.test(error) && (
              <>
                {" "}
                <Link to="/settings/keys#api-key-ELEVENLABS_API_KEY" className="underline">
                  Add key
                </Link>
              </>
            )}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select id="edit-voice" value={voice} disabled={!view} onChange={(e) => onVoice(e.target.value)} className={SELECT}>
              {!voice && <option value="">{view ? "Choose a voice" : "Loading…"}</option>}
              {own.length > 0 && others.length > 0 ? (
                <>
                  <optgroup label="Your voices">
                    {own.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="ElevenLabs voices">
                    {others.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </optgroup>
                </>
              ) : (
                [...own, ...others].map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))
              )}
            </select>
            {preview && <audio key={preview} controls preload="none" src={preview} aria-label="Listen to this voice" className="h-9" />}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="edit-broll">Picture from</Label>
        <select id="edit-broll" value={broll} onChange={(e) => onBroll(e.target.value)} className={SELECT}>
          <option value="">{styleFolder ? (folders.find((c) => c.id === styleFolder)?.name ?? "The style's folder") : "All my B-roll"}</option>
          {folders.filter((c) => c.id !== styleFolder).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
