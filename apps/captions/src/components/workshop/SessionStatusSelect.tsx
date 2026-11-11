import { ExternalLink, X } from "lucide-react";
import { SESSION_STATUSES, sessionStatusOf, type SessionPosting, type SessionPatch, type SessionStatus } from "@/lib/workshop";
import { promptDialog } from "@/lib/dialogs";

const STATUS_CLASS: Record<SessionStatus, string> = {
  draft: "border-zinc-700 text-zinc-400",
  writing: "border-violet-500/50 text-violet-300",
  production: "border-amber-500/50 text-amber-300",
  ready: "border-emerald-500/40 text-emerald-300",
  editing: "border-amber-500/50 text-amber-300",
  toPost: "border-emerald-400/50 text-emerald-200",
  published: "border-violet-500/50 text-violet-200",
  shelved: "border-zinc-800 text-zinc-600",
};

/** Pipeline mark: idea → writing → ready (script done) → in production → editing → ready to post → published. */
export function SessionStatusSelect({
  value,
  onChange,
  disabled,
}: {
  value: SessionStatus | undefined;
  onChange: (status: SessionStatus) => void;
  disabled?: boolean;
}) {
  const current = sessionStatusOf(value);
  return (
    <select
      value={current}
      disabled={disabled}
      aria-label="Session status"
      title="Where this piece sits"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value as SessionStatus)}
      className={`h-7 shrink-0 rounded-md border bg-zinc-950 px-1.5 text-[11px] ${STATUS_CLASS[current]} disabled:opacity-50`}
    >
      {SESSION_STATUSES.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

/**
 * The posts this session became, one chip each: its link, the version it is (a pick from `versions`, when there are any) and
 * "not this post". Once it's ready, a way to paste another link.
 */
export function SessionPosted({
  postings,
  status,
  versions = [],
  onChange,
  disabled,
}: {
  postings: SessionPosting[];
  status: SessionStatus | undefined;
  versions?: Array<{ key: string; label: string }>;
  onChange: (patch: SessionPatch["posted"]) => void;
  disabled?: boolean;
}) {
  const canPaste = status === "production" || status === "editing" || status === "toPost" || status === "published";
  if (!postings.length && !canPaste) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {postings.map((p) => (
        <span key={p.shortcode} className="flex h-7 shrink-0 items-center rounded-md border border-violet-500/40 text-[11px] text-violet-200">
          <a
            href={p.url}
            target="_blank"
            rel="noreferrer"
            title={p.by === "auto" ? "Matched to this post by its words" : "The link you pasted"}
            className="flex items-center gap-1 px-1.5 py-1 hover:text-zinc-50"
          >
            <ExternalLink className="h-3 w-3" />
            Post
          </a>
          {versions.length > 0 && (
            <select
              disabled={disabled}
              aria-label="Which version this post is"
              value={p.version ?? ""}
              onChange={(e) => e.target.value && onChange({ url: p.url, version: e.target.value })}
              className="h-full border-l border-violet-500/30 bg-transparent px-1 text-[11px] text-violet-100 disabled:opacity-50"
            >
              <option value="" className="bg-zinc-900">{p.version ? "" : "Which version?"}</option>
              {versions.map((v) => (
                <option key={v.key} value={v.key} className="bg-zinc-900">
                  {v.label}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            disabled={disabled}
            title="Not this post"
            aria-label="Not this post"
            onClick={() => onChange({ remove: p.shortcode })}
            className="border-l border-violet-500/30 px-1 py-1 text-violet-300/70 hover:text-zinc-50 disabled:opacity-50"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {canPaste && (
        <button
          type="button"
          disabled={disabled}
          title="Paste the Instagram link of a post this became"
          onClick={async (e) => {
            e.stopPropagation();
            const url = await promptDialog({ title: "Paste the post's Instagram link", ok: "Link post" });
            if (url?.trim()) onChange(url.trim());
          }}
          className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 disabled:opacity-50"
        >
          {postings.length ? "Link another post" : "Link post"}
        </button>
      )}
    </span>
  );
}
