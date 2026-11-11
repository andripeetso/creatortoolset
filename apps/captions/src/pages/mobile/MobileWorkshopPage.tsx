import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, ArrowUp, Copy, Loader2, NotebookPen, Square } from "lucide-react";
import { ModelChip } from "@/components/workshop/ModelChip";
import type { Selection } from "@contracts/providers";
import { UserMenu } from "@/components/UserMenu";
import { ProjectList } from "@/components/workspace/ProjectList";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { DesktopHint } from "@/components/mobile/DesktopHint";
import { MarkdownBody } from "@/components/MarkdownBody";
import { canUse, useAuth, useMe } from "@/lib/auth";
import { timeAgo } from "@/lib/exports";
import { toolsetHomePath } from "@/lib/mobile";
import { cornerTaken } from "@/lib/dock-place";
import { useWorkspace } from "@/lib/workspace";
import { keepSession, sessionKeys } from "@/lib/workshop";
import { useCachedLoad } from "@/lib/local-cache";
import {
  documentMarkdown,
  docTabLabel,
  getSession,
  listChat,
  listDocuments,
  patchSession,
  sendTurn,
  stopTurn,
  STAGE_LABELS,
  type ChatMessage,
  listSessions,
  sessionPath,
  sessionStatusLabel,
  type SessionRow,
  type WorkshopDocument,
} from "@/lib/workshop";

const shell =
  "ends-clear relative flex min-h-dvh flex-col bg-zinc-950 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(3.5rem,calc(env(safe-area-inset-top)+2.75rem))] text-zinc-200";
const back =
  "absolute left-3 top-[max(0.75rem,env(safe-area-inset-top))] flex items-center gap-1 rounded-md px-2 py-2 text-sm text-zinc-500 active:bg-zinc-900 active:text-zinc-200";

function MobileChrome({
  home,
  backTo,
  backLabel,
}: {
  home: string;
  backTo: string;
  backLabel: string;
}) {
  const me = useMe();
  const required = useAuth((s) => s.required);
  return (
    <>
      <Link to={backTo} className={back}>
        <ArrowLeft className="h-4 w-4" /> {backLabel}
      </Link>
      <div className="absolute right-2 top-[max(0.5rem,env(safe-area-inset-top))] flex items-center gap-1">
        {me ? (
          <>
            <ProjectSwitcher />
            <UserMenu />
          </>
        ) : required ? (
          <Link to={home} className="rounded-md px-2 py-2 text-sm text-zinc-500">
            Sign in
          </Link>
        ) : null}
      </div>
    </>
  );
}

export default function MobileWorkshopPage() {
  const home = toolsetHomePath();
  const me = useMe();
  const allowed = canUse(me, "workshop");
  const currentProjectId = useWorkspace((s) => s.currentProjectId);
  // the desktop list's saved copy (lib/local-cache): paints at once, live
  const list = useCachedLoad<SessionRow[]>(allowed ? `workshop/sessions?p=${currentProjectId ?? ""}` : null, listSessions);
  const sessions = list.data ?? [];

  return (
    <div className={shell}>
      <MobileChrome home={home} backTo={home} backLabel="Tools" />
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-600">
            <NotebookPen className="h-6 w-6 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Content Workshop</h1>
            <p className="text-sm text-zinc-500">Read, or jot a project</p>
          </div>
        </div>

        <DesktopHint>
          Search, sources and drafts are on your desktop. On your phone you can read a session and ask the AI to change it.
        </DesktopHint>

        <section>
          <p className="mb-2 text-xs text-zinc-500">Sessions</p>
          {list.data === null ? (
            <div aria-hidden className="flex flex-col gap-1.5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[62px] rounded-xl border border-zinc-800 bg-zinc-900/30" />
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <p className="py-6 text-center text-sm text-zinc-600">
              No sessions yet. Start one on your desktop, then read it here.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {sessions.map((s) => (
                <li key={s.id}>
                  <Link
                    to={sessionPath(s.id)}
                    className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/50 px-3.5 py-3 active:bg-zinc-900"
                  >
                    <span className="flex items-center gap-2 text-sm text-zinc-100">
                      <span className="min-w-0 truncate">{s.title}</span>
                      {s.generating ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-400" />
                      ) : null}
                    </span>
                    <span className="mt-0.5 text-[11px] text-zinc-500">
                      {sessionStatusLabel(s.status)}
                      {" · "}
                      {s.draftCount} draft{s.draftCount === 1 ? "" : "s"}
                      {s.projectName ? ` · ${s.projectName}` : ""}
                      {" · "}
                      {timeAgo(s.updatedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <ProjectList />
      </div>
    </div>
  );
}

export function MobileWorkshopSessionPage() {
  const { sessionId = "" } = useParams();
  const navigate = useNavigate();
  const home = toolsetHomePath();
  const me = useMe();
  const allowed = canUse(me, "workshop");
  const currentProjectId = useWorkspace((s) => s.currentProjectId);
  const selectProject = useWorkspace((s) => s.select);
  const aligned = useRef(false);
  const boundProjectId = useRef<string | null>(null);
  // the same saved copies as the desktop page (lib/local-cache): they paint at once and stay live
  const keys = sessionKeys(sessionId);
  const on = allowed && !!sessionId;
  const sessionLoad = useCachedLoad(on ? keys.session : null, () => getSession(sessionId), keys.live);
  const docsLoad = useCachedLoad<WorkshopDocument[]>(on ? keys.docs : null, () => listDocuments(sessionId), keys.live);
  const chatLoad = useCachedLoad<ChatMessage[]>(on ? keys.chat : null, () => listChat(sessionId), keys.live);
  const title = sessionLoad.data?.title ?? "Session";
  const docs = docsLoad.data ?? [];
  const messages = chatLoad.data ?? [];
  const setMessages = chatLoad.set;
  const [picked, setActiveId] = useState<string | null>(null);
  const activeId = picked && docs.some((d) => d.id === picked) ? picked : ((docs.find((x) => x.kind !== "notes") ?? docs[0])?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const shownError = error ?? (!sessionLoad.data && sessionLoad.error ? sessionLoad.error : null);
  const [copied, setCopied] = useState(false);
  const [ai, setAi] = useState<Selection | undefined>();
  const savedAi = sessionLoad.data?.ai;
  useEffect(() => setAi(savedAi), [savedAi]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const thinking = messages.find((m) => m.status === "thinking");

  useEffect(() => keepSession(me?.username, sessionId), [me?.username, sessionId]);
  // the session's own project, once it is known
  const sessionProject = sessionLoad.data ? (sessionLoad.data.projectId ?? null) : undefined;
  useEffect(() => {
    if (sessionProject === undefined) return;
    aligned.current = false;
    boundProjectId.current = sessionProject;
    if (sessionProject && useWorkspace.getState().currentProjectId !== sessionProject) {
      void selectProject(sessionProject)
        .catch(() => {})
        .then(() => {
          aligned.current = true;
        });
    } else {
      aligned.current = true;
    }
  }, [sessionId, sessionProject, selectProject]);

  useEffect(() => {
    if (!aligned.current) return;
    const bound = boundProjectId.current;
    if (bound && currentProjectId && currentProjectId !== bound) navigate("/workshop");
  }, [currentProjectId, navigate]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !activeId || thinking) return;
    setSending(true);
    setError(null);
    try {
      const { ask, reply } = await sendTurn(sessionId, { docId: activeId, text });
      setMessages((m) => [...(m ?? []), ask, reply]);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const active = docs.find((d) => d.id === activeId) ?? null;
  const markdown = active ? documentMarkdown(active) : "";
  const reading = active ? documentMarkdown(active, { frontmatter: false }) : "";

  const copy = async () => {
    if (!markdown.trim()) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy");
    }
  };

  return (
    <div className={shell}>
      <MobileChrome home={home} backTo="/workshop" backLabel="Workshop" />
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-zinc-500">Ask the AI to change the open piece</p>
        </div>

        {shownError && <p className="text-xs text-red-400">{shownError}</p>}

        {docsLoad.data === null ? (
          <div aria-hidden className="flex flex-col gap-4">
            <div className="h-7 w-40 rounded-full bg-zinc-900" />
            <div className="h-48 rounded-xl border border-zinc-800 bg-zinc-900/40" />
          </div>
        ) : docs.length === 0 && !shownError ? (
          <p className="py-10 text-center text-sm text-zinc-600">
            Nothing written yet. Open this session on your desktop to draft.
          </p>
        ) : (
          <>
            <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
              {docs.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setActiveId(d.id)}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${
                    d.id === activeId
                      ? "bg-violet-600 text-white"
                      : "bg-zinc-900 text-zinc-400"
                  }`}
                >
                  {docTabLabel(d)}
                </button>
              ))}
            </div>
            {active && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">
                <div className="mb-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void copy()}
                    disabled={!markdown.trim()}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 active:bg-zinc-800 disabled:opacity-40"
                  >
                    <Copy className="h-3 w-3" />
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                {reading.trim() ? (
                  <MarkdownBody source={reading} media={false} />
                ) : (
                  <p className="py-6 text-center text-sm text-zinc-600">Empty</p>
                )}
              </div>
            )}
          </>
        )}

        {messages.length > 0 && (
          <ul className="flex flex-col gap-2">
            {messages.slice(-30).map((m) => (
              <li
                key={m.id}
                className={`rounded-xl px-3.5 py-2.5 text-sm ${m.role === "user" ? "ml-8 bg-violet-600/20 text-zinc-100" : "mr-4 border border-zinc-800 bg-zinc-900/40"}`}
              >
                {m.status === "thinking" ? (
                  <span className="flex items-center gap-2 text-zinc-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {m.stage ? STAGE_LABELS[m.stage] : "Thinking"}
                    {m.provider ? ` · ${m.provider}` : ""}
                  </span>
                ) : m.role === "assistant" ? (
                  <MarkdownBody source={m.text || (m.error ? "" : "Done.")} media={false} />
                ) : (
                  <p className="whitespace-pre-wrap">{m.text}</p>
                )}
                {m.error && <p className="mt-1 text-xs text-red-400">{m.error}</p>}
                {m.role === "assistant" && m.status !== "thinking" && (m.provider || m.edits) && (
                  <p className="mt-1 text-[11px] text-zinc-500">
                    {m.edits ? "Edited the piece" : ""}
                    {m.edits && m.provider ? " · " : ""}
                    {m.provider ?? ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {active && (
          <div
            // it stays in the window's bottom right corner: the assistant's bubble sits above it, not over Send (dock-place.ts)
            ref={cornerTaken}
            className="sticky bottom-[max(0.5rem,env(safe-area-inset-bottom))] rounded-2xl border border-zinc-800 bg-zinc-950/95 p-2 backdrop-blur"
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              placeholder={`Ask about ${docTabLabel(active)}…`}
              className="w-full resize-none bg-transparent px-1.5 py-1 text-[16px] text-zinc-100 outline-none placeholder:text-zinc-600"
            />
            {/* Send stays on the right when the model chip has nothing to show (no AI connected yet) */}
            <div className="flex items-center justify-between gap-2">
              {me?.role === "admin" ? (
                <ModelChip
                  ai={ai}
                  onChange={(next) => {
                    setAi(next ?? undefined);
                    patchSession(sessionId, { ai: next }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
                  }}
                />
              ) : (
                <span />
              )}
              {thinking ? (
                <button
                  type="button"
                  aria-label="Stop"
                  onClick={() => void stopTurn(sessionId, thinking.id).catch(() => {})}
                  className="ml-auto flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800 text-zinc-200"
                >
                  <Square className="h-3.5 w-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="Send"
                  disabled={!draft.trim() || sending}
                  onClick={() => void send()}
                  className="ml-auto flex h-9 w-9 items-center justify-center rounded-full bg-violet-600 text-white disabled:opacity-40"
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
