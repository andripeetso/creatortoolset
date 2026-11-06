import { ExternalLink, X } from "lucide-react";
import { SESSION_STATUSES, sessionStatusOf, type SessionMeta, type SessionStatus } from "@/lib/workshop";

const STATUS_CLASS: Record<SessionStatus, string> = {
  draft: "border-zinc-700 text-zinc-400",
  writing: "border-sky-500/50 text-sky-300",
  production: "border-amber-500/50 text-amber-300",
  ready: "border-emerald-500/40 text-emerald-300",
  editing: "border-orange-500/50 text-orange-300",
  toPost: "border-teal-400/50 text-teal-200",
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

/** The post this session became, with "not this post"; once it's ready and nothing matched, a way to paste the link. */
export function SessionPosted({
  posted,
  status,
  onChange,
  disabled,
}: {
  posted: SessionMeta["posted"];
  status: SessionStatus | undefined;
  onChange: (url: string | null) => void;
  disabled?: boolean;
}) {
  if (posted) {
    return (
      <span className="flex h-7 shrink-0 items-center rounded-md border border-violet-500/40 text-[11px] text-violet-200" onClick={(e) => e.stopPropagation()}>
        <a
          href={posted.url}
          target="_blank"
          rel="noreferrer"
          title={posted.by === "auto" ? "Matched to this post by its words" : "The link you pasted"}
          className="flex items-center gap-1 px-1.5 py-1 hover:text-white"
        >
          <ExternalLink className="h-3 w-3" />
          Post
        </a>
        <button
          type="button"
          disabled={disabled}
          title="Not this post"
          aria-label="Not this post"
          onClick={() => onChange(null)}
          className="border-l border-violet-500/30 px-1 py-1 text-violet-300/70 hover:text-white disabled:opacity-50"
        >
          <X className="h-3 w-3" />
        </button>
      </span>
    );
  }
  // a post exists only once it has been made
  if (status !== "production" && status !== "editing" && status !== "toPost" && status !== "published") return null;
  return (
    <button
      type="button"
      disabled={disabled}
      title="Paste the Instagram link of the post this became"
      onClick={(e) => {
        e.stopPropagation();
        const url = window.prompt("Paste the post's Instagram link");
        if (url?.trim()) onChange(url.trim());
      }}
      className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
    >
      Link post
    </button>
  );
}
