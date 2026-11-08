import { useEffect, useRef, useState } from "react";
import { Link2, Loader2, TriangleAlert } from "lucide-react";
import {
  DEFAULT_RECIPE,
  KNOWHOW,
  SAVED_FOR,
  instagramProfilesFromText,
  instagramUrlsFromText,
  toggleSavedFor,
  effectiveSavedFor,
  type Recipe,
  type RunWhen,
  type SavedFor,
} from "@/lib/instagram";
import { KNOWHOW_CHIP } from "./IdeaMark";
import { RecipePicker } from "./RecipePicker";

export type IngestPayload = {
  urls: string[];
  profiles: string[];
  recipe: Recipe;
  run: RunWhen;
  savedFor?: SavedFor[];
  /** Know-how: saved, never indexed, its own list. Replaces savedFor. */
  knowhow?: boolean;
};

export function IngestBox({
  nowDisabledReason,
  onIngest,
  onConnect,
  defaultValue = "",
}: {
  /** Blocks Run now only. Save for later still works. */
  nowDisabledReason?: string | null;
  /** Opens the Instagram connection settings, offered beside nowDisabledReason. */
  onConnect?: () => void;
  onIngest: (payload: IngestPayload) => Promise<string | void>;
  defaultValue?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [busy, setBusy] = useState<RunWhen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recipe, setRecipe] = useState<Recipe>(DEFAULT_RECIPE);
  const [savedFor, setSavedFor] = useState<SavedFor[]>(["content"]);
  const [knowhow, setKnowhow] = useState(false);
  const [opened, setOpened] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  // Closes on a click outside, once there is nothing typed to keep it open.
  useEffect(() => {
    if (!opened) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpened(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [opened]);
  const urls = instagramUrlsFromText(value);
  const profiles = instagramProfilesFromText(value);
  const found = urls.length + profiles.length;

  const submit = async (run: RunWhen, raw?: string) => {
    const text = (raw ?? value).trim();
    if (!text || busy) return;
    if (run === "now" && nowDisabledReason) return;
    const list = instagramUrlsFromText(text);
    const handles = instagramProfilesFromText(text);
    if (!list.length && !handles.length) {
      setError("Paste post/reel links, a profile URL, or @username");
      return;
    }
    setBusy(run);
    setError(null);
    try {
      const warning = await onIngest({
        urls: list,
        profiles: handles,
        recipe,
        run,
        ...(knowhow ? { knowhow: true } : { savedFor }),
      });
      setValue("");
      if (warning) setError(warning);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const open = opened || !!value.trim() || !!busy;
  const keptFor = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-xs text-zinc-500">Kept for</span>
      {SAVED_FOR.map((s) => {
        const on = !knowhow && effectiveSavedFor(savedFor).includes(s.id);
        return (
          <button
            key={s.id}
            type="button"
            title={s.hint}
            aria-pressed={on}
            onClick={() => {
              if (knowhow) setSavedFor([s.id]);
              else setSavedFor((cur) => toggleSavedFor(cur, s.id));
              setKnowhow(false);
            }}
            className={`rounded-lg border px-3.5 py-1.5 text-sm ${
              on
                ? s.id === "format"
                  ? "border-violet-500/50 bg-violet-500/15 text-violet-200"
                  : "border-violet-500/50 bg-violet-500/15 text-violet-200"
                : "border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
            }`}
          >
            {s.label}
          </button>
        );
      })}
      <button
        type="button"
        title={KNOWHOW.hint}
        aria-pressed={knowhow}
        onClick={() => setKnowhow((on) => !on)}
        className={`rounded-lg border px-3.5 py-1.5 text-sm ${KNOWHOW_CHIP(knowhow)}`}
      >
        {KNOWHOW.label}
      </button>
    </div>
  );

  return (
    <div ref={boxRef}>
      <div
        className={`rounded-xl border bg-zinc-900/50 px-3 py-2 transition-colors ${
          open ? "border-zinc-700 focus-within:border-violet-500" : "border-zinc-800 hover:border-zinc-700"
        }`}
      >
        <div className="flex items-start gap-2">
          <Link2 className="mt-2 h-4 w-4 shrink-0 text-zinc-500" />
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => setOpened(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit(nowDisabledReason ? "later" : "now");
              }
            }}
            disabled={!!busy}
            placeholder="Paste post links, a profile URL, or @username"
            rows={1}
            spellCheck={false}
            className={`min-w-0 flex-1 bg-transparent py-1.5 text-sm text-zinc-100 outline-none transition-[min-height] duration-300 placeholder:text-zinc-600 disabled:opacity-60 ${
              open ? "min-h-[4.5rem] resize-y" : "min-h-[2rem] resize-none"
            }`}
          />
        </div>
        {/* The drawer: grid rows 0fr -> 1fr animates to the content's own height. */}
        <div
          className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
            open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="min-h-0 overflow-hidden" inert={!open}>
            <div className="mt-2 border-t border-zinc-800/80 pt-3">{keptFor}</div>
            <div className="mt-3 border-t border-zinc-800/80 pt-3">
              <RecipePicker large compact recipe={recipe} onChange={setRecipe} />
            </div>
        <div className="mt-3 flex items-center justify-end gap-2 pb-1">
          {found > 1 && (
            <span className="mr-auto text-[11px] text-zinc-500">
              {urls.length ? `${urls.length} post${urls.length === 1 ? "" : "s"}` : ""}
              {urls.length && profiles.length ? " · " : ""}
              {profiles.length ? `${profiles.length} account${profiles.length === 1 ? "" : "s"}` : ""}
            </span>
          )}
          <button
            type="button"
            disabled={!!busy || !value.trim()}
            onClick={() => void submit("later")}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
          >
            {busy === "later" && <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />}
            Save for later
          </button>
          <button
            type="button"
            disabled={!!nowDisabledReason || !!busy || !value.trim()}
            onClick={() => void submit("now")}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
          >
            {busy === "now" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Run now
          </button>
        </div>
          </div>
        </div>
      </div>
      {nowDisabledReason ? (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-amber-400/80">
          <TriangleAlert className="h-3 w-3 shrink-0" /> {nowDisabledReason} — or save for later
          {onConnect ? (
            <button
              type="button"
              onClick={onConnect}
              className="ml-1 rounded-md border border-amber-400/30 px-2 py-0.5 text-amber-200 hover:bg-amber-400/10"
            >
              Connect Instagram
            </button>
          ) : null}
        </p>
      ) : error ? (
        <p className="mt-2 text-xs text-red-400">{error}</p>
      ) : null}
    </div>
  );
}
