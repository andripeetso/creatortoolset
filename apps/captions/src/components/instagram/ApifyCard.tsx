import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  INSTAGRAM_CONNECTION_EVENT,
  checkApify,
  removeApify,
  saveApify,
  setApifySlow,
  type InstagramAvailability,
} from "@/lib/instagram";
import { ConfirmButton } from "./ConfirmButton";
import { timeAgo } from "@/lib/exports";

/**
 * The user's own Apify key (Settings → Connectors): the one way the Analyzer reads other creators' posts, profiles
 * and comment threads. Apify bills its owner for each read. The key never comes back from the server, only its status.
 */
export function ApifyCard({
  availability,
  onChange,
}: {
  availability: InstagramAvailability | null;
  onChange: () => void;
}) {
  const apify = availability?.apify ?? null;
  const [tokenDraft, setTokenDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    onChange();
    window.dispatchEvent(new Event(INSTAGRAM_CONNECTION_EVENT));
  };

  const runApify = async (kind: "save" | "check" | "remove" | "slow", slow?: boolean) => {
    setBusy(`apify-${kind}`);
    setError(null);
    try {
      if (kind === "save") await saveApify(tokenDraft);
      else if (kind === "check") await checkApify();
      else if (kind === "remove") await removeApify();
      else await setApifySlow(slow === true);
      if (kind === "save") setTokenDraft("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const dot = !apify?.configured
    ? "bg-zinc-600"
    : apify.valid === false
      ? "bg-red-500"
      : apify.valid
        ? "bg-emerald-500"
        : "bg-amber-400";
  const summary = !apify?.configured
    ? "No Apify key yet"
    : apify.valid === false
      ? `Apify key invalid${apify.invalidReason ? ` — ${apify.invalidReason}` : ""}`
      : apify.valid
        ? `Apify connected${apify.account?.username ? ` · ${apify.account.username}` : ""}`
        : "Apify key saved, not checked yet";

  const locked = busy !== null;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-4">
      <div className="mb-3 flex items-center gap-3">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{summary}</span>
        {apify?.configured && apify.checkedAt ? (
          <span className="shrink-0 text-[11px] text-zinc-500">checked {timeAgo(apify.checkedAt)}</span>
        ) : null}
      </div>
      <p className="mb-2 text-xs text-zinc-400">
        Your token from{" "}
        <a
          href="https://console.apify.com/settings/integrations"
          target="_blank"
          rel="noreferrer"
          className="text-violet-300 hover:text-violet-200"
        >
          console.apify.com → Settings → Integrations
        </a>
        . Only your account uses it, and Apify bills you per run (comments are a separate run).
      </p>
      <input
        type="password"
        autoComplete="off"
        value={tokenDraft}
        onChange={(e) => setTokenDraft(e.target.value)}
        placeholder="apify_api_…"
        className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-violet-500"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={locked || tokenDraft.trim().length < 8}
          onClick={() => void runApify("save")}
          className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {busy === "apify-save" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save &amp; check
        </button>
        {apify?.configured && (
          <>
            <button
              type="button"
              disabled={locked}
              onClick={() => void runApify("check")}
              className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy === "apify-check" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Check now
            </button>
            <ConfirmButton
              label="Remove"
              confirmLabel="Click again to remove"
              disabled={locked}
              onConfirm={() => runApify("remove")}
              className="rounded-md border border-transparent px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50"
              armedClassName="!border-red-500/50 !bg-red-500/10 !text-red-200"
            />
          </>
        )}
        {apify?.configured && apify.savedBy && (
          <span className="ml-auto text-[11px] text-zinc-500">
            saved by {apify.savedBy}
            {apify.savedAt ? ` · ${timeAgo(apify.savedAt)}` : ""}
            {apify.source === "env" ? " · from .env" : ""}
          </span>
        )}
      </div>
      {apify?.configured && (
        <label className="mt-2 flex items-start gap-2 text-[11px] text-zinc-400">
          <input
            type="checkbox"
            checked={apify.slow === true}
            disabled={locked || busy !== null}
            onChange={(e) => void runApify("slow", e.target.checked)}
            className="mt-0.5 accent-violet-500"
          />
          <span>
            Slow mode — one actor run at a time. Turn it on if Apify says you exceed your concurrent-runs limit. Runs
            that still hit the limit wait and retry on their own.
          </span>
        </label>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
