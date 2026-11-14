import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  MessageCircleQuestion,
  RefreshCw,
  Send,
} from "lucide-react";
import { CtMark } from "@/components/CtMark";
import { askUsageText, type AskUsage } from "@/lib/workshop";

/**
 * Answering the post's comments, on a Workshop share link. The questions on the linked post, Reply on each (a reply to
 * copy into Instagram; read only when the author clicks), and Ask AI, its own panel, for anything else. Its own thread; the AI
 * reads the session's chat and edits nothing.
 * Server: api/workshop.ts `/:token/answers`, api/lib/workshop/answers.ts. Anyone else gets a 401/404 and sees nothing.
 */

interface Listed {
  id: string;
  user: string;
  text: string;
  at: number;
  likes: number;
  question: boolean;
  answered: boolean;
  parentId?: string;
}
interface Msg {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  commentId?: string;
  usage?: AskUsage;
}
interface Answers {
  sessionId: string;
  post: { shortcode: string; url: string } | null;
  fetchedAt: number | null;
  comments: Listed[];
  thread: Msg[];
}

/** A sidebar box: a clear edge and a header strip, so one box doesn't run into the next. */
export const PANEL =
  "overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-950";
export const PANEL_HEAD =
  "flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-zinc-800 bg-zinc-900 px-3 py-2 text-[11px] text-zinc-300";
export const PANEL_TITLE = "font-medium uppercase tracking-wide";

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!r.ok)
    throw new Error(
      ((await r.json().catch(() => ({}))) as { error?: string }).error ??
        `HTTP ${r.status}`,
    );
  return (await r.json()) as T;
}

function CopyPlain({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard
          .writeText(text)
          .then(
            () => (
              setDone(true),
              window.setTimeout(() => setDone(false), 1500)
            ),
          )
      }
      className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500 hover:text-zinc-50"
    >
      {done ? (
        <Check className="h-3 w-3 text-emerald-400" />
      ) : (
        <Copy className="h-3 w-3" />
      )}{" "}
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function Answer({ m }: { m: Msg }) {
  return (
    <div className="rounded-md border border-violet-500/30 bg-violet-500/[0.06] px-2.5 py-2">
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-100">
        {m.text}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        <CopyPlain text={m.text} />
        {m.usage ? (
          <span className="text-[10px] text-zinc-500">
            {askUsageText(m.usage)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function CommentRow({
  c,
  reply,
  busy,
  onReply,
}: {
  c: Listed;
  reply?: Msg;
  busy: boolean;
  onReply: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <li
      className={`flex flex-col gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 ${c.parentId ? "ml-4" : ""}`}
    >
      <div className="flex items-baseline gap-2 text-[11px] text-zinc-500">
        <span className="font-medium text-zinc-300">@{c.user}</span>
        <span>{when(c.at)}</span>
        {c.likes ? <span>· {c.likes} likes</span> : null}
        {c.answered ? (
          <span className="ml-auto text-emerald-400">you replied</span>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap text-[13px] text-zinc-100">{c.text}</p>
      {reply ? <Answer m={reply} /> : null}
      <div className="flex items-center gap-1.5">
        {reply ? (
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && !busy && (onReply(note), setNote(""))
            }
            placeholder="Change it… (optional)"
            className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          />
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => (onReply(note), setNote(""))}
          className="flex shrink-0 items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}{" "}
          {reply ? "Redo" : "Reply"}
        </button>
      </div>
    </li>
  );
}

/** `embedded`: in the session's Share window, which closes back to the session, so no Session link. */
export function ShareAnswers({
  token,
  embedded = false,
}: {
  token: string;
  embedded?: boolean;
}) {
  const [data, setData] = useState<Answers | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(
    null,
  );
  const [question, setQuestion] = useState("");
  const base = `/api/workshop-share/${token}/answers`;
  useEffect(() => {
    // not signed in, or no access: the endpoint refuses and the panels stay away
    call<Answers>(base).then(setData, () => setData(null));
  }, [base]);
  const run = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError({ key, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }, []);
  const ask = (body: { question?: string; commentId?: string }) =>
    run(body.commentId ?? "ask", async () => {
      const { ask: a, reply } = await call<{ ask: Msg; reply: Msg }>(
        `${base}/ask`,
        body,
      );
      setData((d) => (d ? { ...d, thread: [...d.thread, a, reply] } : d));
      if (!body.commentId) setQuestion("");
    });
  if (!data) return null;

  const replyFor = (id: string) =>
    [...data.thread]
      .reverse()
      .find((m) => m.role === "assistant" && m.commentId === id);
  const open = data.comments.filter((c) => c.question && !c.answered);
  const rest = data.comments.filter((c) => !open.includes(c));
  const chat = data.thread.filter((m) => !m.commentId);
  const row = (c: Listed) => (
    <CommentRow
      key={c.id}
      c={c}
      reply={replyFor(c.id)}
      busy={busy === c.id}
      onReply={(note) =>
        void ask({
          commentId: c.id,
          ...(note.trim() ? { question: note.trim() } : {}),
        })
      }
    />
  );
  const read = !!data.fetchedAt;
  const commentsError = error && error.key !== "ask" ? error.text : null;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-violet-500/40 bg-violet-500/[0.06] p-2.5">
      <p
        className="px-1 text-[11px] text-violet-300"
        title="Only people signed in with access to the session see these"
      >
        Only you see these · not the freelancer
      </p>
      <section className={PANEL}>
        <div className={PANEL_HEAD}>
          <MessageCircleQuestion className="h-4 w-4 text-violet-300" />
          <p className={`${PANEL_TITLE} text-violet-200`}>Comments</p>
          {embedded ? null : (
            <Link
              to={`/workshop/sessions/${data.sessionId}`}
              className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-50"
            >
              <ArrowLeft className="h-3 w-3" /> Session
            </Link>
          )}
          {data.post ? (
            <>
              <a
                href={data.post.url}
                target="_blank"
                rel="noreferrer"
                className="ml-auto flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-50"
              >
                Open post <ExternalLink className="h-3 w-3" />
              </a>
              <button
                type="button"
                disabled={!!busy}
                onClick={() =>
                  void run("refresh", async () =>
                    setData(await call<Answers>(`${base}/refresh`, {})),
                  )
                }
                className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500 hover:text-zinc-50 disabled:opacity-50"
                title={
                  read
                    ? `Read ${when(data.fetchedAt!)}`
                    : "Reads the post's comments now"
                }
              >
                <RefreshCw
                  className={`h-3 w-3 ${busy === "refresh" ? "animate-spin" : ""}`}
                />{" "}
                {read ? "Refresh" : "Read comments"}
              </button>
            </>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 p-3">
          {!data.post ? (
            <p className="text-[12px] text-zinc-500">
              This session isn't linked to its Instagram post yet. Once it is,
              its comments can be read here.
            </p>
          ) : !read ? (
            <p className="text-[12px] text-zinc-500">
              Nothing read yet. Read comments fetches them from the post.
            </p>
          ) : open.length ? (
            <ul className="flex flex-col gap-2">{open.map(row)}</ul>
          ) : (
            <p className="text-[12px] text-zinc-500">
              {data.comments.length
                ? "No open questions on the post."
                : "No comments on the post."}
            </p>
          )}
          {rest.length ? (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-zinc-400 hover:text-zinc-200">
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />{" "}
                Other comments ({rest.length})
              </summary>
              <ul className="mt-2 flex flex-col gap-2">{rest.map(row)}</ul>
            </details>
          ) : null}
          {busy && busy !== "ask" && busy !== "refresh" ? (
            <p className="text-[11px] text-zinc-500">
              Writing a reply from the post, its chat and the comments… this can
              take a minute.
            </p>
          ) : null}
          {commentsError ? (
            <p className="text-[11px] text-red-300">{commentsError}</p>
          ) : null}
        </div>
      </section>

      <section className={PANEL}>
        <div className={PANEL_HEAD}>
          <CtMark className="h-4 w-4 text-violet-300" />
          <p className={`${PANEL_TITLE} text-violet-200`}>Ask AI</p>
          <span className="text-zinc-500">
            knows the post and how it was made
          </span>
        </div>
        <div className="flex flex-col gap-2 p-3">
          {chat.map((m) =>
            m.role === "user" ? (
              <p
                key={m.id}
                className="self-end whitespace-pre-wrap rounded-md bg-zinc-800 px-2.5 py-1.5 text-[13px] text-zinc-100"
              >
                {m.text}
              </p>
            ) : (
              <Answer key={m.id} m={m} />
            ),
          )}
          <div className="flex items-end gap-1.5">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  question.trim() &&
                  !busy
                ) {
                  e.preventDefault();
                  void ask({ question: question.trim() });
                }
              }}
              rows={2}
              placeholder="Ask about the post, or paste a comment to answer"
              className="min-w-0 flex-1 resize-y rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
            />
            <button
              type="button"
              disabled={!question.trim() || !!busy}
              onClick={() => void ask({ question: question.trim() })}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50"
              title="Send"
            >
              {busy === "ask" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
          {busy === "ask" ? (
            <p className="text-[11px] text-zinc-500">
              Reading the post, its chat and the comments… this can take a
              minute.
            </p>
          ) : null}
          {error?.key === "ask" ? (
            <p className="text-[11px] text-red-300">{error.text}</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
