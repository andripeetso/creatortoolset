import { useEffect, useRef, useState } from "react";
import { Cloud, KeyRound, Loader2, ShieldAlert } from "lucide-react";
import {
  checkApify,
  checkSession,
  removeApify,
  removeSession,
  saveApify,
  setApifySlow,
  saveSession,
  setInstagramSource,
  type InstagramAvailability,
  type IngestMode,
} from "@/lib/instagram";
import { ConfirmButton } from "./ConfirmButton";
import { timeAgo } from "@/lib/exports";

/**
 * Per-user source: paste your own burner cookies or Apify token.
 * Secrets never come back from the server — only status. The burner
 * warning is only on that tab. Tokens are not shared across accounts.
 */
export function SessionCard({
  availability,
  onChange,
  inDialog,
}: {
  availability: InstagramAvailability | null;
  onChange: () => void;
  /** In the Instagram connection dialog: open from the start. */
  inDialog?: boolean;
}) {
  const session = availability?.session ?? null;
  const apify = availability?.apify ?? null;
  const active = availability?.source ?? "session";
  const [pending, setPending] = useState<IngestMode | null>(null);
  const tab = pending ?? active;
  const [open, setOpen] = useState(!!inDialog);
  const userToggled = useRef(!!inDialog);

  useEffect(() => {
    if (!availability || userToggled.current) return;
    const src = availability.source === "apify" ? availability.apify : availability.session;
    setOpen(!src?.configured || src.valid === false);
  }, [availability]);
  const [cookieDraft, setCookieDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    onChange();
  };

  const switchTab = async (mode: IngestMode) => {
    if (mode === tab && mode === active) return;
    setPending(mode);
    setError(null);
    if (mode === active) return;
    setBusy("source");
    try {
      await setInstagramSource(mode);
      refresh();
    } catch (e) {
      setPending(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const runSession = async (kind: "save" | "check" | "remove") => {
    setBusy(`session-${kind}`);
    setError(null);
    try {
      if (kind === "save") await saveSession(cookieDraft);
      else if (kind === "check") await checkSession();
      else await removeSession();
      if (kind === "save") {
        setCookieDraft("");
        setPending("session");
      }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const runApify = async (kind: "save" | "check" | "remove" | "slow", slow?: boolean) => {
    setBusy(`apify-${kind}`);
    setError(null);
    try {
      if (kind === "save") await saveApify(tokenDraft);
      else if (kind === "check") await checkApify();
      else if (kind === "remove") await removeApify();
      else await setApifySlow(slow === true);
      if (kind === "save") {
        setTokenDraft("");
        setPending("apify");
      }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const using = tab === "apify" ? apify : session;
  const dot = !using?.configured
    ? "bg-zinc-600"
    : using.valid === false
      ? "bg-red-500"
      : using.valid
        ? "bg-emerald-500"
        : "bg-amber-400";
  const summary =
    tab === "apify"
      ? !apify?.configured
        ? "Apify — paste an API token to enable the tool"
        : apify.valid === false
          ? `Apify token invalid${apify.invalidReason ? ` — ${apify.invalidReason}` : ""}`
          : apify.valid
            ? `Apify connected${apify.account?.username ? ` · ${apify.account.username}` : ""}`
            : "Apify token saved, not checked yet"
      : !session?.configured
        ? "Burner cookies — paste a session to enable the tool"
        : session.valid === false
          ? `Session invalid${session.invalidReason ? ` — ${session.invalidReason}` : ""}`
          : session.valid
            ? `Session valid${session.account?.username ? ` · @${session.account.username}` : ""}`
            : "Session saved, not checked yet";

  const locked = busy !== null;

  return (
    <div className={`${inDialog ? "" : "mb-6 "}rounded-xl border border-zinc-800 bg-zinc-900/50`}>
      <button
        type="button"
        onClick={() => {
          userToggled.current = true;
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
        {tab === "apify" ? (
          <Cloud className="h-4 w-4 shrink-0 text-zinc-500" />
        ) : (
          <KeyRound className="h-4 w-4 shrink-0 text-zinc-500" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{summary}</span>
        {using?.configured && using.checkedAt ? (
          <span className="shrink-0 text-[11px] text-zinc-500">
            checked {timeAgo(using.checkedAt)}
          </span>
        ) : null}
        <span className="shrink-0 text-[11px] text-zinc-500">{open ? "Hide" : "Manage"}</span>
      </button>

      {open && (
        <div className="border-t border-zinc-800 px-4 py-4">
          <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-zinc-950 p-1">
            <button
              type="button"
              disabled={locked}
              onClick={() => void switchTab("session")}
              className={`rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                tab === "session"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              Burner cookies
              {active === "session" ? (
                <span className="ml-1.5 text-[10px] text-violet-300">using</span>
              ) : null}
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => void switchTab("apify")}
              className={`rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                tab === "apify"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              Apify
              {active === "apify" ? (
                <span className="ml-1.5 text-[10px] text-violet-300">using</span>
              ) : null}
            </button>
          </div>

          {tab === "session" ? (
            <>
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong>Burner account only.</strong> Never paste cookies from a real
                  or business account. This session is used from the server to read
                  posts and comments, which can get an account checkpointed or
                  suspended.
                </span>
              </div>
              <p className="mb-2 text-xs text-zinc-400">
                Log in to Instagram as the burner account in your browser, open
                DevTools → Network, click any request to instagram.com and copy the
                whole <code className="text-zinc-300">Cookie</code> request header.
                A cookies.txt export works too.
              </p>
              <textarea
                value={cookieDraft}
                onChange={(e) => setCookieDraft(e.target.value)}
                placeholder="sessionid=…; csrftoken=…; ds_user_id=…; mid=…; ig_did=…"
                rows={3}
                spellCheck={false}
                className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-violet-500"
              />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={locked || !cookieDraft.trim()}
                  onClick={() => void runSession("save")}
                  className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                >
                  {busy === "session-save" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Save &amp; check
                </button>
                {session?.configured && (
                  <>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => void runSession("check")}
                      className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {busy === "session-check" && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      Check now
                    </button>
                    <ConfirmButton
                      label="Remove"
                      confirmLabel="Click again to remove"
                      disabled={locked}
                      onConfirm={() => runSession("remove")}
                      className="rounded-md border border-transparent px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50"
                      armedClassName="!border-red-500/50 !bg-red-500/10 !text-red-200"
                    />
                  </>
                )}
                {session?.configured && session.savedBy && (
                  <span className="ml-auto text-[11px] text-zinc-500">
                    saved by {session.savedBy}
                    {session.savedAt ? ` · ${timeAgo(session.savedAt)}` : ""}
                    {session.source === "env" ? " · from .env" : ""}
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
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
                . Only your login can use it. Charged per run; comments are a
                separate actor.
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
                      {busy === "apify-check" && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
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
                    Slow mode — one actor run at a time. Turn it on if Apify says you exceed your
                    concurrent-runs limit. Runs that still hit the limit wait and retry on their own.
                  </span>
                </label>
              )}
            </>
          )}
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
