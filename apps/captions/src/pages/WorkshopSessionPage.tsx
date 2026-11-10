import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Eye, Loader2, Sparkles, X } from "lucide-react";
import { AppBar } from "@/components/AppBar";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { AuditButton } from "@/components/workshop/AuditButton";
import { AuditModal } from "@/components/workshop/AuditModal";
import { ChatPane } from "@/components/workshop/ChatPane";
import { DocShapeRules, DocView, type DocSettingsPatch } from "@/components/workshop/ComposerBar";
import { DocumentEditor } from "@/components/workshop/DocumentEditor";
import { DocumentTabs } from "@/components/workshop/DocumentTabs";
import { ExportMarkdown } from "@/components/workshop/ExportMarkdown";
import { SessionPosted, SessionStatusSelect } from "@/components/workshop/SessionStatusSelect";
import { DeskControls, WorkshopDesk } from "@/components/workshop/WorkshopDesk";
import { SelectedSourcesStrip } from "@/components/workshop/SelectedSourcesStrip";
import { SelectionToContext } from "@/components/workshop/SelectionToContext";
import { SourceReader } from "@/components/workshop/SourceReader";
import { SourceResultCard } from "@/components/workshop/SourceResultCard";
import { SourceSearch, type BrowseOrder } from "@/components/workshop/SourceSearch";
import { workshopUsesByPost } from "@/components/instagram/PostCard";
import { canUse, useMe } from "@/lib/auth";
import { itemActionsFor } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";
import { accountPathFor, addAccount, analyzerHome, findPosts, getPost, ingestPosts, recipeFromPreset, isOwnPost, listAccounts, listPosts, mediaUrl, mineAccount, patchPostResearch, type FindHit, type FindResult, type InstagramAccount, type InstagramPost, type PostKind, type SavedFor } from "@/lib/instagram";
import {
  MAX_SESSION_SOURCES,
  WORKSHOP_HOME,
  ANOTHER_POST_DESCRIPTION,
  WRITE_POST_DESCRIPTION,
  applyAuditFixes,
  createDocument,
  deleteChatMessage,
  deleteDocument,
  restoreDocument,
  getDocument,
  getVersion,
  getSession,
  getWorkshopAvailability,
  isStockDocTitle,
  KIND_STOCK_TITLE,
  docTabLabel,
  listChat,
  listDocuments,
  listFrameworks,
  listProjects,
  docKindLabel,
  listRules,
  listFinalsForDoc,
  listSessions,
  moveId,
  patchDocument,
  generateCarouselLayouts,
  patchSession,
  respondProposal,
  revertDocument,
  keepDocument,
  readComposerContext,
  saveComposerContext,
  sendTurn,
  stopTurn,
  startAudit,
  startReview,
  lineOptions,
  askAbout,
  type ChatMessage,
  type TurnInput,
  type AuditDepth,
  type ContextSnippet,
  type PieceQuote,
  usageTally,
  tokensLabel,
  type DocKind,
  type SessionPatch,
  postingsOfSession,
  type SessionRecord,
  type SessionRow,
  type SessionStatus,
  type WorkshopDocument,
  type WorkshopFramework,
  type WorkshopProject,
  type WorkshopRule,
  readScope,
  saveScope,
  type ChangeScope,
} from "@/lib/workshop";
import { exportFilename } from "@/lib/workshop-markdown";
import { useDeskLayout } from "@/lib/workshop-desk";
import { mineIndex } from "@/lib/mine";
import { SharePopover } from "@/components/workshop/SharePopover";
import { SessionFinals } from "@/components/workshop/SessionFinals";
import { Notice } from "@/components/workshop/Notice";
import { CitePopover } from "@/components/workshop/SelectionPill";
import { WorkshopSidebar } from "@/components/workshop/WorkshopSidebar";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import InstagramAccountPage from "@/pages/InstagramAccountPage";
import { markSeen, patchSummary, refreshSummaries } from "@/lib/workshop-summary";
import { listCache, sessionCache } from "@/lib/workshop-cache";
import { useWorkspace } from "@/lib/workspace";

type BlockEdit = { id?: string; text: string };
const MAX_PINNED = 12;
const rest0 = (docs: WorkshopDocument[], docId: string) => docs.filter((d) => d.id !== docId);

/** First working document to show: the newest non-notes one, else notes. */
const pickActive = (docs: WorkshopDocument[], cur: string | null) =>
  cur && docs.some((d) => d.id === cur) ? cur : (docs.find((d) => d.kind !== "notes") ?? docs[0])?.id ?? null;

export default function WorkshopSessionPage() {
  const { sessionId = "" } = useParams();
  const me = useMe();
  // buttons a plug-in puts on a session (itemActions.session in its web.tsx), gated per account
  const sessionActions = useMemo(() => itemActionsFor(me, webPlugins, "session"), [me]);
  const allowed = canUse(me, "workshop");
  const selectProject = useWorkspace((s) => s.select);

  // a session opened before paints at once from memory; the fetches below refresh it (`fresh` until they land)
  const cached = sessionId ? sessionCache.get(sessionId) : undefined;
  const [session, setSession] = useState<SessionRecord | null>(cached?.session ?? null);
  const [fresh, setFresh] = useState(!cached);
  const [pageError, setPageError] = useState<string | null>(null);
  const [title, setTitle] = useState(cached?.session.title ?? "");
  const [error, setError] = useState<string | null>(null);

  // ---- the desk: documents and the conversation
  const [docs, setDocs] = useState<WorkshopDocument[]>(cached?.docs ?? []);
  // ?doc= opens on that piece (a Convert to copy opens on the piece being written)
  const [searchParams] = useSearchParams();
  const [activeDocId, setActiveDocId] = useState<string | null>(searchParams.get("doc") ?? cached?.activeDocId ?? null);
  const [closed, setClosed] = useState<Array<{ doc: WorkshopDocument; index: number }>>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(cached?.messages ?? []);
  // The composer's context survives a reload (per session); send() clears it once the turn is accepted.
  const draftKey = `workshop-draft:${sessionId}`;
  const [savedContext] = useState(() => readComposerContext(`${draftKey}:ctx`));
  const [pinned, setPinned] = useState<ContextSnippet[]>(() => savedContext.pinned?.slice(0, MAX_PINNED) ?? []);
  /** Deep research runs before the next message is answered; off again after each send. */
  const [deep, setDeep] = useState(() => savedContext.deep === true);
  /** "My words only": the AI builds from what you said and the page marks anything else. Stays on until switched off. */
  const [wordsOnly, setWordsOnly] = useState(() => savedContext.mine === true);
  // the slider: how much a message may change the piece, kept where the author leaves it
  const [scope, setScopeState] = useState<ChangeScope | undefined>(readScope);
  const setScope = (v: ChangeScope | undefined) => {
    setScopeState(v);
    saveScope(v);
  };
  /** Words of the piece you selected and commented on; they go with your next message. */
  const [quotes, setQuotes] = useState<PieceQuote[]>(() => (savedContext.quotes?.slice(0, 20) ?? []).map((q, i) => (q.id ? q : { ...q, id: `q${Date.now()}-${i}` })));
  // Cite: the comment box opens where you clicked; Save adds the chip (or changes its comment)
  const [citing, setCiting] = useState<{ quote: PieceQuote; at: { x: number; y: number }; editing?: boolean } | null>(null);
  const withId = (q: PieceQuote) => (q.id ? q : { ...q, id: `q${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });
  const cite = (quote: PieceQuote, at?: { x: number; y: number }) => (at ? setCiting({ quote: withId(quote), at }) : setQuotes((qs) => (qs.some((x) => x.id === quote.id) ? qs : [...qs, withId(quote)])));
  const saveCite = (comment: string) => {
    if (!citing) return;
    const quote = { ...citing.quote, comment: comment || undefined };
    setQuotes((qs) => (citing.editing ? qs.map((q) => (q.id === quote.id ? quote : q)) : [...qs, quote]));
    setCiting(null);
  };
  useEffect(() => {
    saveComposerContext(`${draftKey}:ctx`, { pinned, quotes, deep, mine: wordsOnly });
  }, [draftKey, pinned, quotes, deep, wordsOnly]);
  const [docSaving, setDocSaving] = useState(false);
  const [docPreview, setDocPreview] = useState(false);
  const [visualize, setVisualize] = useState(false);
  // "Not mine": mark the AI's words you never said in this session (kept per browser)
  const [notMine, setNotMine] = useState(() => localStorage.getItem("workshop.notMine") === "1");
  const toggleNotMine = () =>
    setNotMine((v) => {
      localStorage.setItem("workshop.notMine", v ? "0" : "1");
      return !v;
    });
  // The running Claude tally instead of a line under every answer: this session live, plus the project's other sessions.
  const usageHint = useMemo(() => {
    const here = usageTally(messages);
    const elsewhere = session?.projectUsageElsewhere;
    if (!here.turns && !elsewhere?.turns) return "thinking, questions, research";
    const session$ = `Session $${here.costUsd.toFixed(2)} (${tokensLabel(here.tokens)} tokens)`;
    if (!elsewhere?.turns) return `${session$} API-equivalent`;
    return `${session$} · Project $${(here.costUsd + elsewhere.costUsd).toFixed(2)} (${tokensLabel(here.tokens + elsewhere.tokens)}, ${elsewhere.sessions + 1} sessions) API-equivalent`;
  }, [messages, session?.projectUsageElsewhere]);
  const mineSet = useMemo(
    () =>
      notMine
        ? mineIndex([...messages.filter((m) => m.role === "user").map((m) => m.text), ...docs.flatMap((d) => d.blocks.filter((b) => b.author === "user").map((b) => b.text))])
        : null,
    [notMine, messages, docs],
  );
  const blockTimer = useRef<number | null>(null);
  const pendingBlocks = useRef<{ docId: string; blocks: BlockEdit[]; caption: string; pinned: string; hooks?: BlockEdit[] } | null>(null);

  // ---- the library on the right
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<PostKind | "">("");
  const [results, setResults] = useState<FindResult | null>(null);
  const [searching, setSearching] = useState(false);
  /** The whole library, shown until a search narrows it. */
  const [library, setLibrary] = useState<InstagramPost[] | null>(null);
  // A post opens in a preview over the piece and the chat, from Browse or from the session's own strip; ←/→ step through the list it came from.
  const [peek, setPeek] = useState<InstagramPost | null>(null);
  const [peekInSession, setPeekInSession] = useState(false);
  const openPeek = (post: InstagramPost, inSession = false) => {
    setPeekInSession(inSession);
    setPeek(post);
  };
  const [readerSlide, setReaderSlide] = useState<{ postId: string; index: number } | null>(null);

  const [projects, setProjects] = useState<WorkshopProject[]>(listCache.projects ?? []);
  const [accounts, setAccounts] = useState<InstagramAccount[]>(listCache.accounts ?? []);
  const [mineOnly, setMineOnly] = useState(false);
  // Browse: your own posts only under My account, posts other sessions use hidden unless asked for,
  // and the library by date, newest or oldest first (both remembered)
  const [showElsewhere, setShowElsewhere] = useState(() => localStorage.getItem("workshop:browse-elsewhere") === "1");
  const [order, setOrder] = useState<BrowseOrder>(() => {
    const saved = localStorage.getItem("workshop:browse-order");
    return saved === "newest" || saved === "oldest" ? saved : "recent";
  });
  useEffect(() => {
    localStorage.setItem("workshop:browse-elsewhere", showElsewhere ? "1" : "0");
    localStorage.setItem("workshop:browse-order", order);
  }, [showElsewhere, order]);
  const [formatOnly, setFormatOnly] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>(listCache.sessions ?? []);
  const [frameworks, setFrameworks] = useState<WorkshopFramework[]>(listCache.frameworks ?? []);
  const [rules, setRules] = useState<WorkshopRule[]>(listCache.rules ?? []);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [researchAvailable, setResearchAvailable] = useState(false);
  const [macOff, setMacOff] = useState(false);
  const [desk, setDesk] = useDeskLayout();
  const [auditMessageId, setAuditMessageId] = useState<string | null>(null);
  const auditThinking = useRef(new Set<string>());

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  // ---- load
  const load = useCallback(() => {
    if (!sessionId) return;
    getSession(sessionId)
      .then((s) => {
        setSession(s);
        setTitle(s.title);
        setQuery((q) => q || s.query);
        if (s.projectId) void selectProject(s.projectId);
      })
      .catch((e) => setPageError(e instanceof Error ? e.message : "Could not open the session"));
    listDocuments(sessionId)
      .then((d) => {
        setDocs(d);
        setActiveDocId((cur) => pickActive(d, cur));
        setFresh(true);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    listChat(sessionId).then(setMessages).catch(() => {});
  }, [sessionId, selectProject]);

  useEffect(() => {
    if (!allowed) return;
    load();
    listProjects().then(setProjects).catch(() => {});
    listAccounts("", { projectId: null }).then(setAccounts).catch(() => {});
    listSessions().then(setSessions).catch(() => {});
    listFrameworks().then(setFrameworks).catch(() => {});
    listRules().then(setRules).catch(() => {});
    // asked again every 30 s and on focus: a Mac that was off a moment ago (a deploy's restart, a sleep) is back
    const check = () =>
      getWorkshopAvailability()
        .then((a) => {
          setAiAvailable(a.ai);
          setResearchAvailable(a.research);
          setMacOff(a.mac === false);
        })
        .catch(() => {});
    void check();
    const t = window.setInterval(check, 30_000);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", check);
    };
  }, [allowed, load]);

  useEffect(() => {
    setDocPreview(false);
    setVisualize(false);
  }, [activeDocId]);

  // ⌘A selects the whole page, and the browser keeps a selection when the click
  // lands on a button or inside the selected text (it reads as a drag): any plain
  // click lets go of it. Shift-click still extends; "Add to AI context" prevents it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.detail > 1 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  useEffect(() => {
    if (sessionId && session) sessionCache.set(sessionId, { session, docs, messages, activeDocId });
  }, [sessionId, session, docs, messages, activeDocId]);
  useEffect(() => {
    Object.assign(listCache, { projects, accounts, sessions, frameworks, rules });
  }, [projects, accounts, sessions, frameworks, rules]);

  // ---- the running reply's words, pushed as they arrive (the poll below brings everything else)
  const liveId = messages.find((m) => m.status === "thinking")?.id;
  const [streamed, setStreamed] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    if (!liveId || !sessionId) return;
    const es = new EventSource(`/api/workshop/sessions/${sessionId}/chat/${liveId}/live`);
    es.onmessage = (e) => {
      try {
        setStreamed({ id: liveId, text: (JSON.parse(e.data) as { text: string }).text });
      } catch {
        // a broken event: the poll still brings the text
      }
    };
    es.addEventListener("end", () => es.close());
    return () => es.close();
  }, [liveId, sessionId]);
  const shownMessages = useMemo(
    () => (streamed ? messages.map((m) => (m.id === streamed.id && m.status === "thinking" && streamed.text.length > m.text.length ? { ...m, text: streamed.text } : m)) : messages),
    [messages, streamed],
  );

  // ---- a turn is running: poll the chat every second (the reply streams in),
  // refresh the document while blocks are being written, then everything when it ends
  const thinking = messages.some((m) => m.status === "thinking");
  // A rename from the sidebar (double-click a session) lands in the title field too.
  useEffect(() => {
    const on = (e: Event) => {
      const { id, title: t } = (e as CustomEvent<{ id: string; title: string }>).detail;
      if (id !== sessionId) return;
      setTitle(t);
      setSession((s) => (s ? { ...s, title: t } : s));
    };
    window.addEventListener("workshop:renamed", on);
    return () => window.removeEventListener("workshop:renamed", on);
  }, [sessionId]);

  // The tab's title and the sidebar's dots come from the session summary (WorkshopSidebar). Looking at a finished
  // reply here marks it seen, so its dot goes everywhere.
  const latestReply = [...messages].reverse().find((m) => m.role === "assistant");
  useEffect(() => {
    if (!sessionId || !latestReply || latestReply.status === "thinking") return;
    const look = () => document.visibilityState === "visible" && markSeen(sessionId, latestReply.id);
    look();
    document.addEventListener("visibilitychange", look);
    window.addEventListener("focus", look);
    return () => {
      document.removeEventListener("visibilitychange", look);
      window.removeEventListener("focus", look);
    };
  }, [sessionId, latestReply?.id, latestReply?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!thinking || !sessionId) return;
    let seenBlocks = -1;
    let busy = false;
    const t = window.setInterval(() => {
      if (busy) return;
      busy = true;
      listChat(sessionId)
        .then(async (ms) => {
          setMessages(ms);
          const live = ms.find((m) => m.status === "thinking");
          if (live) {
            const written = live.edits?.blockIds?.length ?? 0;
            if (live.edits && written !== seenBlocks) {
              seenBlocks = written;
              const doc = await getDocument(sessionId, live.edits.docId).catch(() => null);
              if (doc) setDocs((ds) => (ds.some((d) => d.id === doc.id) ? ds.map((d) => (d.id === doc.id ? doc : d)) : [...ds, doc]));
            }
            return;
          }
          const d = await listDocuments(sessionId);
          setDocs(d);
          const last = [...ms].reverse().find((m) => m.role === "assistant" && m.status === "done");
          setActiveDocId((cur) => (last?.edits?.created ? last.edits.docId : pickActive(d, cur)));
          void refreshSummaries();
        })
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    }, 1000);
    return () => window.clearInterval(t);
  }, [thinking, sessionId, title]);

  useEffect(() => {
    for (const m of messages) {
      if (m.status === "thinking" && m.audit) auditThinking.current.add(m.id);
      if (m.status === "done" && m.audit?.result && auditThinking.current.has(m.id)) {
        auditThinking.current.delete(m.id);
        setAuditMessageId(m.id);
      }
    }
  }, [messages]);

  // ---- block edits: 700 ms debounce, flushed before a turn and when leaving
  // Resolves true once the server has the edits. A failed save puts the words back and retries a few times, quietly.
  const flushBlocks = useCallback((attempt = 0): Promise<boolean> => {
    const p = pendingBlocks.current;
    if (!p || !sessionId) return Promise.resolve(true);
    pendingBlocks.current = null;
    if (blockTimer.current) {
      window.clearTimeout(blockTimer.current);
      blockTimer.current = null;
    }
    setDocSaving(true);
    return patchDocument(sessionId, p.docId, { blocks: p.blocks, caption: p.caption, pinned: p.pinned, ...(p.hooks !== undefined ? { hooks: p.hooks } : {}) })
      .then((doc) => {
        // A newer edit to the same document is waiting; its own save will bring the final copy.
        if (pendingBlocks.current?.docId !== doc.id) setDocs((ds) => ds.map((d) => (d.id === doc.id ? doc : d)));
        return true;
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        if (!pendingBlocks.current) {
          pendingBlocks.current = p;
          if (attempt < 3) window.setTimeout(() => void flushBlocks(attempt + 1), 5000);
        }
        return false;
      })
      .finally(() => setDocSaving(false));
  }, [sessionId]);

  const onBlocks = (docId: string, blocks: BlockEdit[], companions: { caption: string; pinned: string; hooks?: BlockEdit[] }) => {
    pendingBlocks.current = { docId, blocks, ...companions };
    if (blockTimer.current) window.clearTimeout(blockTimer.current);
    blockTimer.current = window.setTimeout(() => void flushBlocks(), 700);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") void flushBlocks();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flushBlocks]);

  useEffect(() => {
    const onLeave = () => void flushBlocks();
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
      if (blockTimer.current) window.clearTimeout(blockTimer.current);
      void flushBlocks();
    };
  }, [flushBlocks]);

  // ---- documents
  const activeDoc = docs.find((d) => d.id === activeDocId) ?? null;
  const auditOpen = messages.find((m) => m.id === auditMessageId) ?? null;
  const replaceDoc = (doc: WorkshopDocument) => setDocs((ds) => (ds.some((d) => d.id === doc.id) ? ds.map((d) => (d.id === doc.id ? doc : d)) : [...ds, doc]));
  // the Finals versions linked to the active piece: one post-description tab each (Finals → Workshop session link)
  const [finalsTabs, setFinalsTabs] = useState<{ docId: string; versions: { key: string; label: string }[] } | null>(null);
  useEffect(() => {
    if (!session || !activeDoc) return;
    let live = true;
    listFinalsForDoc(session.id, activeDoc.id).then(
      (versions) => live && setFinalsTabs({ docId: activeDoc.id, versions }),
      () => live && setFinalsTabs(null),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the session and the piece id are the keys
  }, [session?.id, activeDoc?.id]);
  const saveVersionCaption = async (key: string, text: string) => {
    if (!session || !activeDoc) return;
    try {
      replaceDoc(await patchDocument(session.id, activeDoc.id, { captions: { [key]: text } }));
    } catch (e) {
      fail(e);
    }
  };

  const selectDoc = (id: string) => {
    void flushBlocks();
    setActiveDocId(id);
  };
  const createDoc = async (k: Exclude<DocKind, "notes">) => {
    if (!session) return;
    setError(null);
    try {
      const carry = activeDoc && activeDoc.kind !== "notes" ? { frameworkIds: activeDoc.frameworkIds, ruleIds: activeDoc.ruleIds } : {};
      const doc = await createDocument(session.id, { kind: k, ...carry });
      replaceDoc(doc);
      setActiveDocId(doc.id);
    } catch (e) {
      fail(e);
    }
  };
  const removeDoc = async (docId: string) => {
    if (!session) return;
    const gone = docs.find((d) => d.id === docId);
    const index = docs.findIndex((d) => d.id === docId);
    if (!gone || gone.kind === "notes" || index < 0) return;
    try {
      await flushBlocks();
      await deleteDocument(session.id, docId);
      setClosed((cs) => [...cs, { doc: gone, index }]);
      const rest = rest0(docs, docId);
      if (rest.some((d) => d.kind !== "notes")) {
        setDocs(rest);
        setActiveDocId((cur) => (cur === docId ? pickActive(rest, null) : cur));
      } else {
        // The last working document went; the server makes a fresh one.
        const fresh = await listDocuments(session.id);
        setDocs(fresh);
        setActiveDocId(pickActive(fresh, null));
      }
    } catch (e) {
      fail(e);
    }
  };
  const restoreClosed = async () => {
    if (!session || !closed.length) return;
    const last = closed[closed.length - 1]!;
    try {
      const doc = await restoreDocument(session.id, last.doc.id);
      setClosed((cs) => cs.slice(0, -1));
      setDocs((ds) => {
        if (ds.some((d) => d.id === doc.id)) return ds;
        const next = [...ds];
        next.splice(Math.min(last.index, next.length), 0, doc);
        return next;
      });
      setActiveDocId(doc.id);
    } catch (e) {
      fail(e);
    }
  };
  // ---- your words, mechanically: lock approved slides; mark what you never said
  const lockSlides = async (ids: string[]) => {
    if (!session || !activeDoc) return;
    await flushBlocks();
    try {
      replaceDoc(await patchDocument(session.id, activeDoc.id, { locked: ids }));
    } catch (e) {
      fail(e);
    }
  };
  const patchSettings = async (patch: DocSettingsPatch) => {
    if (!session || !activeDoc) return;
    try {
      const next =
        patch.kind && patch.kind !== "notes" && isStockDocTitle(activeDoc.title)
          ? { ...patch, title: KIND_STOCK_TITLE[patch.kind] }
          : patch;
      replaceDoc(await patchDocument(session.id, activeDoc.id, next));
    } catch (e) {
      fail(e);
    }
  };
  const keepVersion = async (docId: string, input: { name?: string; versionId?: string; kept?: boolean }) => {
    if (!session) return;
    await flushBlocks();
    try {
      replaceDoc(await keepDocument(session.id, docId, input));
    } catch (e) {
      fail(e);
    }
  };
  const revertTo = async (docId: string, versionId: string) => {
    if (!session) return;
    await flushBlocks();
    try {
      const doc = await revertDocument(session.id, docId, versionId);
      replaceDoc(doc);
      setActiveDocId(doc.id);
    } catch (e) {
      fail(e);
    }
  };
  const setStatus = (status: SessionStatus) => {
    if (!session) return;
    setSession({ ...session, status });
    patchSummary(session.id, { status });
    patchSession(session.id, { status }).catch(fail);
  };
  const setPosted = (posted: SessionPatch["posted"]) => {
    if (!session) return;
    patchSession(session.id, { posted })
      .then((m) => setSession((s) => (s ? { ...s, status: m.status, postings: m.postings, posted: m.posted } : s)))
      .catch(fail);
  };

  const setProject = (projectId: string | null) => {
    if (!session) return;
    setSession({ ...session, projectId: projectId ?? undefined });
    patchSession(session.id, { projectId }).catch(fail);
    if (projectId) void selectProject(projectId);
  };
  // ---- what the AI changed: the last turn's new words on the open piece light up while it
  // writes, fade out a few seconds after, and the Changes button shows them again
  const lastEdit = [...messages].reverse().find((m) => m.role === "assistant" && m.edits?.docId === activeDoc?.id && !!m.edits?.versionBefore)?.edits;
  const editKey = lastEdit ? `${lastEdit.versionBefore}:${lastEdit.blockIds.join(",")}` : "";
  const [changedFrom, setChangedFrom] = useState<{ key: string; before: Map<string, string> } | null>(null);
  useEffect(() => {
    if (!session || !lastEdit?.versionBefore) return;
    const ids = [...new Set(lastEdit.blockIds)];
    if (!ids.length) return;
    let stale = false;
    getVersion(session.id, lastEdit.docId, lastEdit.versionBefore, ids)
      .then((v) => {
        // a block the turn added was not there before: all of it is new
        if (!stale) setChangedFrom({ key: editKey, before: new Map(ids.map((id) => [id, v.blocks.find((b) => b.id === id)?.text ?? ""])) });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [editKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showChanges, setShowChanges] = useState(false);
  const [flash, setFlash] = useState(false);
  const wasThinking = useRef(false);
  useEffect(() => {
    const ended = wasThinking.current && !thinking;
    wasThinking.current = thinking;
    if (!ended) return;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 3000);
    return () => window.clearTimeout(t);
  }, [thinking]);
  // the flash belongs to the newest reply, and only when it wrote on this piece (an answer that edits nothing shows nothing)
  const newestReply = [...messages].reverse().find((m) => m.role === "assistant");
  const newestEdited = newestReply?.edits?.docId === activeDoc?.id && !!newestReply?.edits?.blockIds.length;
  const changes = changedFrom && changedFrom.key === editKey ? { before: changedFrom.before, on: showChanges || ((thinking || flash) && newestEdited) } : undefined;

  // ---- sources
  const posts = session?.posts ?? [];
  const selectedIds = posts.map((p) => p.id);
  // the session's own sources load in the background once it opens: one picture at a time so the page never waits; they're kept 30 days.
  // ponytail: pictures only, videos still load when played
  const sourceKey = selectedIds.join(",");
  useEffect(() => {
    const urls = posts.flatMap((p) => p.slides.filter((x) => x.kind !== "video" && x.bytes > 0).map((x) => mediaUrl(p.id, x.index)));
    let stop = false;
    void (async () => {
      for (const u of urls) {
        if (stop) return;
        await new Promise((done) => {
          const im = new Image();
          im.onload = im.onerror = done;
          im.src = u;
        });
      }
    })();
    return () => void (stop = true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the list of sources, not each re-read of them
  }, [sourceKey]);
  // the session's source open in the preview: the AI is told which one, and which slide
  const readerPost = peek && selectedIds.includes(peek.id) ? peek : null;

  // ---- the conversation
  // Resolves true once the server has taken the message. A refused send (4xx) changes nothing; after a
  // network error or a 5xx the chat is read back, and the words are only given up if the message is not there.
  const send = async (text: string, opts?: { deep?: false; keepContext?: boolean; pasted?: Array<{ name: string; text: string }>; images?: TurnInput["images"]; files?: TurnInput["files"]; quotes?: PieceQuote[] }): Promise<boolean> => {
    if (!session || !activeDoc) return false;
    setError(null);
    if (!(await flushBlocks())) {
      setError("Your last edits did not save, so nothing was sent");
      return false;
    }
    const reading = readerPost ? { postId: readerPost.id, slide: readerSlide?.postId === readerPost.id ? readerSlide.index : 0 } : undefined;
    const before = new Set(messages.map((m) => m.id));
    try {
      const { ask, reply } = await sendTurn(session.id, {
        docId: activeDoc.id,
        text,
        context: pinned.length ? pinned : undefined,
        reading,
        deep: opts?.deep === false ? undefined : deep || undefined,
        mine: opts?.deep === false ? undefined : wordsOnly || undefined,
        scope: opts?.deep === false ? undefined : scope,
        // the message box sends its own citations, in the order they stand (the box clears them once sent)
        quotes: opts?.quotes?.length ? opts.quotes : undefined,
        pasted: opts?.pasted,
        images: opts?.images,
        files: opts?.files,
      });
      setMessages((ms) => [...ms, ask, reply]);
      patchSummary(session.id, { working: true, ready: false });
      if (wordsOnly && opts?.deep !== false && !notMine) toggleNotMine();
      if (!opts?.keepContext) {
        setPinned([]);
        setDeep(false);
      }
      return true;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== undefined && status < 500) {
        fail(e);
        return false;
      }
      // ambiguous: the server may have taken it. Read the chat back before deciding.
      try {
        const ms = await listChat(session.id);
        // a message with no words of its own is sent as "Look at these." / "Read what I pasted." (the server's wording)
        if (!ms.some((m) => m.role === "user" && !before.has(m.id) && (text.trim() ? m.text.trim() === text.trim() : !!(m.images?.length || m.pasted?.length)))) {
          fail(e);
          return false;
        }
        setMessages(ms);
        if (!opts?.keepContext) {
          setPinned([]);
          setDeep(false);
        }
        return true;
      } catch {
        fail(e);
        return false;
      }
    }
  };
  const generateCaption = (another: boolean) => {
    void send(another ? ANOTHER_POST_DESCRIPTION : WRITE_POST_DESCRIPTION, { deep: false, keepContext: true });
  };
  // Retry sends the question once more and removes the failed pair in the same server write, so a failed retry loses nothing.
  const retry = async (m: ChatMessage) => {
    if (!session) return;
    const at = messages.findIndex((x) => x.id === m.id);
    const ask = at > 0 && messages[at - 1]!.role === "user" ? messages[at - 1]! : null;
    if (!ask) return;
    setError(null);
    try {
      if (m.audit) {
        const res = await startAudit(session.id, { docId: ask.docId, postId: m.audit.target.type === "post" ? m.audit.target.id : undefined, depth: m.audit.depth });
        await deleteChatMessage(session.id, m.id);
        await deleteChatMessage(session.id, ask.id);
        setMessages((ms) => [...ms.filter((x) => x.id !== m.id && x.id !== ask.id), res.ask, res.reply]);
        return;
      }
      const res = await sendTurn(session.id, { docId: ask.docId, text: ask.text, context: ask.context, reading: ask.reading, deep: ask.deep, comments: ask.comments, mine: ask.mine, scope: ask.scope, quotes: ask.quotes, pastedRefs: ask.pasted, imageRefs: ask.images, fileRefs: ask.files, library: ask.library, web: ask.web, retryOf: [m.id, ask.id] });
      setMessages((ms) => [...ms.filter((x) => x.id !== m.id && x.id !== ask.id), res.ask, res.reply]);
    } catch (e) {
      fail(e);
    }
  };
  // Stop ends the reply that is thinking; its partial edits are undone on the server. The draft in the box stays.
  const stop = (messageId: string) => {
    if (!session) return;
    stopTurn(session.id, messageId)
      .catch(fail)
      .finally(() => void listChat(session.id).then(setMessages).catch(() => {}));
  };
  const pin = (s: ContextSnippet) => setPinned((p) => (p.length >= MAX_PINNED ? p : [...p, s]));
  const isTagged = (postId: string) => pinned.some((s) => s.field === "source" && s.postId === postId);
  const tag = (post: InstagramPost) =>
    !isTagged(post.id) &&
    pin({ postId: post.id, handle: post.creator.username, field: "source", text: post.caption.split("\n").find((l) => l.trim())?.trim().slice(0, 200) || `@${post.creator.username}'s video` });
  // The creator's account page over the Workshop, adding the account first when it isn't tracked yet.
  const [creatorId, setCreatorId] = useState<string | null>(null);
  const openCreator = async (post: InstagramPost) => {
    const known = accountPathFor(analyzerHome(), post, accounts);
    if (known) return setCreatorId(known.split("/").pop()!);
    try {
      const handle = `@${post.creator.username}`;
      const acc = await addAccount(handle, { run: "now" }).catch(() => addAccount(handle, { run: "later" }));
      setCreatorId(acc.id);
    } catch (e) {
      fail(e);
    }
  };
  // a post opened in that page shows in the Workshop's reader
  const openCreatorPost = (id: string) => {
    setCreatorId(null);
    void getPost(id).then((p) => openPeek(p)).catch(fail);
  };

  // ---- a follower's read: Claude Fable reads the open piece with only the piece in front of it
  const review = async () => {
    if (!session || !activeDoc) return;
    setError(null);
    await flushBlocks();
    try {
      const { ask, reply } = await startReview(session.id, activeDoc.id);
      setMessages((ms) => [...ms, ask, reply]);
    } catch (e) {
      fail(e);
    }
  };

  // ---- accuracy audit: a chat message that fills in when the research lands
  const audit = async (depth: AuditDepth, postId?: string) => {
    if (!session || !activeDoc) return;
    setError(null);
    await flushBlocks();
    try {
      const { ask, reply } = await startAudit(session.id, { docId: activeDoc.id, postId, depth });
      setMessages((ms) => [...ms, ask, reply]);
    } catch (e) {
      fail(e);
    }
  };
  const respond = async (m: ChatMessage, action: "accept" | "decline", depth?: AuditDepth, question?: string) => {
    if (!session) return;
    setError(null);
    await flushBlocks();
    try {
      const res = await respondProposal(session.id, m.id, action, depth, question);
      setMessages((ms) => {
        const next = ms.map((x) => (x.id === res.message.id ? res.message : x));
        return res.ask && res.reply ? [...next, res.ask, res.reply] : next;
      });
    } catch (e) {
      fail(e);
    }
  };
  const processAudit = async (m: ChatMessage, claimIds: string[]) => {
    if (!session || !claimIds.length) return;
    setError(null);
    await flushBlocks();
    try {
      const res = await applyAuditFixes(session.id, m.id, claimIds);
      replaceDoc(res.doc);
      setMessages((ms) => ms.map((x) => (x.id === m.id && x.audit ? { ...x, audit: { ...x.audit, applied: res.applied } } : x)));
    } catch (e) {
      fail(e);
    }
  };
  const resetLoaded = () => {
    if (!session) return;
    setSession({ ...session, loaded: [] });
    patchSession(session.id, { loaded: [] }).catch(fail);
  };

  // ---- search (300 ms debounce, ≥ 2 chars); the query is remembered on the session
  const mine = mineAccount(accounts);
  // what this session's project switched off is not offered (one already picked stays, so it can be taken off)
  const sessionOff = projects.find((p) => p.id === session?.projectId)?.off ?? [];
  const contextAccount = accounts.find((a) => a.id === projects.find((p) => p.id === session?.projectId)?.accountId) ?? mine;
  useEffect(() => {
    if (!allowed) return;
    listPosts(
      mineOnly && mine
        ? { account: mine.id, projectId: null }
        : { projectId: session?.projectId },
    )
      .then(setLibrary)
      .catch(() => setLibrary([]));
  }, [allowed, mineOnly, mine?.id, session?.projectId]);
  // A post link pasted into Browse's box is a post to add, not a search
  const pastedLinks = [...new Set(query.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(?:p|reels?|tv)\/[\w-]+|https?:\/\/(?:(?:www|m)\.)?youtube\.com\/(?:watch\?[^\s]*v=[\w-]+|shorts\/[\w-]+|live\/[\w-]+)|https?:\/\/youtu\.be\/[\w-]+/gi) ?? [])];
  const [adding, setAdding] = useState<{ busy: boolean; error?: string } | null>(null);
  const addFromLinks = async () => {
    if (!session || !pastedLinks.length) return;
    setAdding({ busy: true });
    try {
      // "watch": the video and its words too (the default reads only the numbers)
      const { posts: got, errors } = await ingestPosts(pastedLinks, { recipe: recipeFromPreset("watch"), run: "now", projectId: session.projectId ?? null });
      const fresh = got.filter((p) => !selectedIds.includes(p.id)).slice(0, MAX_SESSION_SOURCES - posts.length);
      if (fresh.length) await saveSources([...posts, ...fresh]);
      setLibrary((lib) => (lib ? [...got.filter((p) => !lib.some((x) => x.id === p.id)), ...lib] : lib));
      setAdding(errors.length ? { busy: false, error: errors.map((e) => `${e.input}: ${e.error}`).join(" · ") } : null);
      if (!errors.length) setQuery("");
      if (got[0]) openPeek(got[0]);
    } catch (e) {
      setAdding({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || /instagram\.com\//i.test(q)) return;
    let stopped = false;
    const t = window.setTimeout(() => {
      setSearching(true);
      findPosts(q, {
        limit: 120,
        account: mineOnly && mine ? mine.id : undefined,
        projectId: mineOnly ? null : session?.projectId,
      })
        .then((r) => {
          if (!stopped) setResults(r);
        })
        .catch((e) => {
          if (!stopped) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!stopped) setSearching(false);
        });
      if (sessionId) patchSession(sessionId, { query: q.slice(0, 200) }).catch(() => {});
    }, 300);
    return () => {
      stopped = true;
      window.clearTimeout(t);
    };
  }, [query, sessionId, mineOnly, mine?.id, session?.projectId]);

  const saveSources = async (nextPosts: InstagramPost[]) => {
    if (!session) return;
    const prev = session;
    const byId = new Map(prev.sources.map((s) => [s.postId, s]));
    const sources = nextPosts.map((p) => byId.get(p.id) ?? { postId: p.id, addedAt: Date.now() });
    setSession({ ...prev, sources, posts: nextPosts });
    try {
      await patchSession(prev.id, { sources });
    } catch (e) {
      fail(e);
      setSession(prev);
    }
  };

  const markSavedFor = async (id: string, savedFor: SavedFor[]) => {
    try {
      const next = await patchPostResearch(id, { savedFor });
      setSession((s) => (s ? { ...s, posts: s.posts.map((p) => (p.id === next.id ? next : p)) } : s));
      setLibrary((list) => list?.map((p) => (p.id === next.id ? next : p)) ?? list);
      setResults((r) =>
        r ? { ...r, hits: r.hits.map((h) => (h.post.id === next.id ? { ...h, post: next } : h)) } : r,
      );
      setPeek((p) => (p?.id === next.id ? next : p));
    } catch (e) {
      fail(e);
    }
  };

  const toggle = (post: InstagramPost) => {
    if (selectedIds.includes(post.id)) {
      void saveSources(posts.filter((p) => p.id !== post.id));
    } else if (posts.length < MAX_SESSION_SOURCES) {
      void saveSources([...posts, post]);
    }
  };
  const move = (id: string, dir: -1 | 1) => {
    const order = moveId(selectedIds, id, dir);
    void saveSources(order.map((pid) => posts.find((p) => p.id === pid)!));
  };
  // A Browse card opens a preview over the piece and the chat: the list stays in view, ←/→ step through it, a click on another card swaps it.
  const stepRef = useRef<(d: -1 | 1) => void>(() => {});
  useEffect(() => {
    if (!peek) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return setPeek(null);
      const typing = e.target instanceof HTMLElement && !!e.target.closest("input, textarea, select, [contenteditable]");
      if (typing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return; // Shift+←/→ is the reader's own
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        stepRef.current(e.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peek]);
  const read = (post: InstagramPost) => openPeek(post, selectedIds.includes(post.id));

  const keptForFormat = (p: InstagramPost) => !formatOnly || !!p.savedFor?.includes("format");
  const usedElsewhere = workshopUsesByPost(sessions);
  const usesOf = (postId: string) => (usedElsewhere.get(postId) ?? []).filter((u) => u.id !== sessionId);
  // My account on: only yours. Off: never yours, and nothing another session uses unless that chip is on.
  const elsewhereCount = (library ?? []).filter((p) => !isOwnPost(p, mine) && usesOf(p.id).length > 0).length;
  const browsable = (p: InstagramPost) =>
    keptForFormat(p) && (mineOnly ? isOwnPost(p, mine) : !isOwnPost(p, mine) && (showElsewhere || !usesOf(p.id).length));
  const postedAt = (p: InstagramPost) => p.takenAt || 0;
  // same fallback as the server's own sort: pulledAt is when it entered the library
  const addedAt = (p: InstagramPost) => p.pulledAt || p.takenAt || 0;
  const sortKey = order === "recent" ? addedAt : postedAt;
  const scopedLibrary = (library ?? []).filter(browsable).sort((a, b) => (order === "oldest" ? sortKey(a) - sortKey(b) : sortKey(b) - sortKey(a)));
  const activeResults = query.trim().length >= 2 ? results : null;
  const allHits = activeResults ? activeResults.hits.filter((h) => browsable(h.post)) : [];
  const hits = allHits.filter((h) => !kind || h.post.kind === kind);
  const hitCounts = activeResults ? allHits.reduce<Record<PostKind, number>>((acc, h) => ({ ...acc, [h.post.kind]: acc[h.post.kind] + 1 }), { reel: 0, carousel: 0, post: 0 }) : null;
  // No search: the library itself, as cards, with the kind chips counting it.
  const shelf: FindHit[] = activeResults ? [] : scopedLibrary.filter((p) => !kind || p.kind === kind).map((post) => ({ post, score: 0, matches: [], commentsOnly: false }));
  const browseList = activeResults ? hits.map((h) => h.post) : shelf.map((h) => h.post);
  const peekList = peekInSession ? posts : browseList;
  const peekAt = peek ? peekList.findIndex((p) => p.id === peek.id) : -1;
  const peekStep = (d: -1 | 1) => {
    const next = peekList[peekAt + d];
    if (peekAt >= 0 && next) setPeek(next);
  };
  stepRef.current = peekStep;
  const libraryCounts = library
    ? scopedLibrary.reduce<Record<PostKind, number>>((acc, p) => ({ ...acc, [p.kind]: acc[p.kind] + 1 }), { reel: 0, carousel: 0, post: 0 })
    : null;

  if (!allowed) return null;

  return (
    <div className="flex h-dvh flex-col bg-[var(--desk-page)] text-foreground">
      <AppBar
        tool="Content Workshop"
        to={WORKSHOP_HOME}
        className="bg-[var(--desk-page)]"
        trail={
        // as wide as the title (an invisible copy sizes it), so the rest of the bar stays free to drag the Mac window
        <span className="inline-grid min-w-0">
        <span aria-hidden className="invisible col-start-1 row-start-1 truncate whitespace-pre border border-transparent px-2 py-1 text-sm font-medium">{title || "Session title"}</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (session && title.trim() !== session.title) {
              patchSummary(session.id, { title: title.trim() || "Untitled session" });
              patchSession(session.id, { title }).then((m) => setSession((s) => (s ? { ...s, title: m.title } : s))).catch(() => {});
            }
          }}
          onKeyDown={(e) => {
            // Enter saves and leaves the field, Esc puts the saved name back
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setTitle(session?.title ?? "");
              requestAnimationFrame(() => (document.activeElement as HTMLElement | null)?.blur());
            }
          }}
          placeholder="Session title"
          className="col-start-1 row-start-1 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium text-foreground outline-none hover:border-border focus:border-violet-500"
        />
        </span>
        }
      >
        {session ? <SessionPosted postings={postingsOfSession(session)} status={session.status} onChange={setPosted} /> : null}
        {session ? <SessionStatusSelect value={session.status} onChange={setStatus} /> : null}
        {/* no project picker here: the session works in the project chosen up top, whose
            instructions and context live in Projects */}
        <DeskControls layout={desk} onChange={setDesk} />
        {session ? (
          <ExportMarkdown
            sessionId={session.id}
            filename={exportFilename(
              projects.find((p) => p.id === session.projectId)?.name,
              (docs.find((d) => d.id === activeDocId && d.kind !== "notes") ?? docs.find((d) => d.kind !== "notes" && d.blocks.length))?.kind ?? "notes",
              session.title,
            )}
            onError={fail}
            onExported={() => {
              // an export moved it to In Production (the server's rule, like a share): show it here and in the sidebar
              window.setTimeout(() => {
                void getSession(session.id).then((fresh) => setSession((cur) => (cur ? { ...cur, status: fresh.status } : cur)));
                void refreshSummaries();
              }, 300);
            }}
          />
        ) : null}
        {session ? (
          <SharePopover
            sessionId={session.id}
            title={session.title}
            onStatus={(status) => setSession((s) => (s ? { ...s, status } : s))}
            className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          />
        ) : null}
        {session
          ? sessionActions.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={() => void a.onRun(session.id)}
                className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {a.icon ? <a.icon className="h-3.5 w-3.5" /> : null} {a.label}
              </button>
            ))
          : null}
        <ProjectSwitcher onSelect={setProject} />
      </AppBar>

      <div className="flex min-h-0 flex-1">
      <WorkshopSidebar activeId={sessionId} title={title || "Content Workshop"} />
      {pageError ? (
        <p className="p-6 text-sm text-red-300">{pageError}</p>
      ) : !session ? (
        <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Opening session…
        </p>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {citing ? <CitePopover at={citing.at} comment={citing.quote.comment} onSave={saveCite} onCancel={() => setCiting(null)} /> : null}
          {error && (
            <Notice onDismiss={() => setError(null)} className="mx-2 mt-2">
              {error}
            </Notice>
          )}
          <div className="min-h-0 flex-1">
          <WorkshopDesk
            layout={desk}
            onChange={setDesk}
            overlay={
              peek ? (
                // a modal over the piece and the chat: dimmed behind, a card in the
                // middle; a click on the dim closes it. Browse stays clickable beside it to switch posts.
                <div
                  className="flex h-full items-center justify-center bg-black/60 p-6 backdrop-blur-[2px] animate-in fade-in-0"
                  onMouseDown={(e) => e.target === e.currentTarget && setPeek(null)}
                >
                <div className="flex h-[min(100%,820px)] w-[min(100%,1120px)] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-[var(--desk-page)] shadow-2xl animate-in zoom-in-95 fade-in-0">
                  <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-[12px] text-muted-foreground">
                    <span className="font-medium text-foreground">{peekInSession ? "This session’s sources" : "From Browse"}</span>
                    {peekAt >= 0 ? <span className="tabular-nums">{peekAt + 1} / {peekList.length}</span> : null}
                    <span className="text-[11px]">← → to step through · Esc to close</span>
                    {selectedIds.includes(peek.id) ? (
                      <span className="ml-auto rounded-md border border-emerald-500/40 px-2 py-0.5 text-emerald-300">In this session</span>
                    ) : (
                      <button type="button" disabled={posts.length >= MAX_SESSION_SOURCES} onClick={() => toggle(peek)} className="ml-auto rounded-md bg-violet-600 px-2.5 py-1 font-medium text-white hover:bg-violet-500 disabled:opacity-50">
                        + Add to session
                      </button>
                    )}
                    <button type="button" onClick={() => setPeek(null)} className="rounded-md p-1 hover:bg-muted hover:text-foreground" aria-label="Close the preview" title="Close (Esc)">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    <SelectionToContext onPin={pin}>
                      <SourceReader
                        key={peek.id}
                        post={peek}
                        at={peekAt}
                        total={peekList.length}
                        onPrev={() => peekStep(-1)}
                        onNext={() => peekStep(1)}
                        onSlide={(index) => setReaderSlide({ postId: peek.id, index })}
                        onTag={selectedIds.includes(peek.id) ? () => tag(peek) : undefined}
                        tagged={isTagged(peek.id)}
                        onAudit={(depth) => void audit(depth, peek.id)}
                        onSavedFor={(savedFor) => void markSavedFor(peek.id, savedFor)}
                        onOpenCreator={() => void openCreator(peek)}
                        analyzerHref={`${analyzerHome()}/${peek.id}`}
                        researchAvailable={researchAvailable}
                        auditBusy={thinking}
                      />
                    </SelectionToContext>
                  </div>
                </div>
                </div>
              ) : null
            }
            islands={{
              writing: {
                header: (
                  <DocumentTabs
                    docs={docs}
                    activeId={activeDocId}
                    busy={thinking}
                    undo={closed.length ? { label: docTabLabel(closed[closed.length - 1]!.doc), onUndo: () => void restoreClosed() } : undefined}
                    onSelect={selectDoc}
                    onCreate={(k) => void createDoc(k)}
                    onKind={(k) => void patchSettings({ kind: k })}
                    onRevert={(d, v) => void revertTo(d, v)}
                    onKeep={(d, input) => void keepVersion(d, input)}
                    onDelete={(d) => void removeDoc(d)}
                    tools={
                      activeDoc ? (
                        <>
                          <DocShapeRules
                            doc={activeDoc}
                            frameworks={frameworks.filter((f) => !sessionOff.includes(f.id) || activeDoc.frameworkIds.includes(f.id))}
                            rules={rules.filter((r) => !sessionOff.includes(r.id) || activeDoc.ruleIds?.includes(r.id))}
                            busy={thinking}
                            onPatch={(patch) => void patchSettings(patch)}
                          />
                          <DocView
                            kind={activeDoc.kind}
                            preview={docPreview}
                            onPreview={() => setDocPreview((p) => !p)}
                            onVisualize={() => setVisualize(true)}
                            notMine={notMine}
                            onNotMine={toggleNotMine}
                            changes={showChanges}
                            onChanges={lastEdit ? () => setShowChanges((v) => !v) : undefined}
                          />
                        </>
                      ) : null
                    }
                  />
                ),
                body: activeDoc ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <SessionFinals sessionId={session.id} />
                    {/* an empty piece: write it from what the session has */}
                    {activeDoc.kind !== "notes" && !activeDoc.blocks.some((b) => b.text.trim()) && aiAvailable && !thinking ? (
                      <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-[12px] text-muted-foreground">
                        <span>This {docKindLabel(activeDoc.kind)} is empty.</span>
                        <button
                          type="button"
                          onClick={() => {
                            const from = docs.find((d) => d.id !== activeDoc.id && d.kind !== "notes" && d.blocks.some((b) => b.text.trim()));
                            void send(`Write this ${docKindLabel(activeDoc.kind)} from ${from ? `the ${docKindLabel(from.kind)}` : "what's"} in this session.`);
                          }}
                          className="flex h-7 items-center gap-1 rounded-md bg-violet-600 px-2.5 font-medium text-white hover:bg-violet-500"
                        >
                          <Sparkles className="h-3.5 w-3.5" /> Write it from this session
                        </button>
                      </div>
                    ) : null}
                    <DocumentEditor
                      key={activeDoc.id}
                      doc={activeDoc}
                      locked={thinking || !fresh}
                      quiet={!thinking}
                      saving={docSaving}
                      aiAvailable={aiAvailable}
                      onChange={(b, c) => onBlocks(activeDoc.id, b, c)}
                      onGenerateCaption={generateCaption}
                      finalsVersions={finalsTabs?.docId === activeDoc.id && finalsTabs.versions.length ? finalsTabs.versions : undefined}
                      onVersionCaption={saveVersionCaption}
                      onCarouselType={(id) => void patchSettings({ carouselType: id })}
                      onLayouts={async (opts) => {
                        await flushBlocks();
                        replaceDoc(await generateCarouselLayouts(session.id, activeDoc.id, opts));
                      }}
                      preview={docPreview}
                      visualize={visualize}
                      onCloseVisualize={() => setVisualize(false)}
                      mine={mineSet}
                      onLock={(ids) => void lockSlides(ids)}
                      onLines={(input) => lineOptions(session.id, activeDoc.id, input)}
                      onQuote={cite}
                      onAsk={(input) => askAbout(session.id, activeDoc.id, input)}
                      changes={changes}
                    />
                  </div>
                ) : (
                  <p className="p-4 text-sm text-muted-foreground">No document yet — add one with “+ New”.</p>
                ),
              },
              cowork: {
                hint: usageHint,
                body: (
                  <ChatPane
                    messages={shownMessages}
                    docs={docs}
                    activeDoc={activeDoc}
                    thinking={thinking}
                    aiAvailable={aiAvailable}
                    pinned={pinned}
                    onUnpin={(i) => setPinned((p) => p.filter((_, j) => j !== i))}
                    quotes={quotes}
                    onQuote={cite}
                    onUnquote={(id) => setQuotes((qs) => qs.filter((q) => q.id !== id))}
                    onEditQuote={(id, at) => {
                      const q = quotes.find((x) => x.id === id);
                      if (q) setCiting({ quote: q, at, editing: true });
                    }}
                    sources={posts.map((p) => ({ id: p.id, handle: p.creator.username }))}
                    loaded={session.loaded ?? []}
                    onResetLoaded={resetLoaded}
                    deep={deep}
                    mineOnly={wordsOnly}
                    onMineOnly={setWordsOnly}
                    scope={scope}
                    onScope={setScope}
                    onDeep={setDeep}
                    researchAvailable={researchAvailable}
                    selectedIds={selectedIds}
                    full={posts.length >= MAX_SESSION_SOURCES}
                    onAddHit={(post) => {
                      if (!selectedIds.includes(post.id)) toggle(post);
                    }}
                    onReadHit={read}
                    onSend={(text, pasted, images, sentQuotes, files) => send(text, { pasted, images, quotes: sentQuotes, files })}
                    onStop={() => {
                      const live = messages.find((m) => m.status === "thinking");
                      if (live) stop(live.id);
                    }}
                    macOff={macOff}
                    ai={session.ai}
                    onAiChange={
                      me?.role === "admin"
                        ? (ai) => {
                            setSession((s) => (s ? { ...s, ai: ai ?? undefined } : s));
                            patchSession(session.id, { ai }).catch(fail);
                          }
                        : undefined
                    }
                    sessionId={session.id}
                    onRevert={(m) => m.edits?.versionBefore && void revertTo(m.edits.docId, m.edits.versionBefore)}
                    onRetry={(m) => void retry(m)}
                    onOpenDoc={selectDoc}
                    onOpenAudit={(m) => setAuditMessageId(m.id)}
                    onProposal={(m, action, depth, question) => void respond(m, action, depth, question)}
                    draftKey={draftKey}
                    audit={
                      activeDoc && activeDoc.kind !== "notes" && activeDoc.blocks.length > 0 ? (
                        <>
                          <AuditButton
                            available={researchAvailable}
                            busy={thinking}
                            onAudit={(depth) => void audit(depth)}
                            menu="up"
                            className="flex items-center gap-1 rounded-md border border-border bg-background/80 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                          />
                          <button
                            type="button"
                            onClick={() => void review()}
                            disabled={thinking}
                            title="A reader reads only the piece, as one of your followers would: where they'd stop, what they'd take away, whether they'd save or send it. Its read lands here and the writer sees it next turn."
                            className="flex items-center gap-1 rounded-md border border-border bg-background/80 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                          >
                            <Eye className="h-3.5 w-3.5" /> Read as a follower
                          </button>
                        </>
                      ) : null
                    }
                  />
                ),
              },
              content: {
                header: (
                  <div className="flex h-full items-center px-3 text-sm font-medium text-foreground">Browse</div>
                ),
                body: (
                  <div className="min-h-0 flex-1 overflow-y-auto p-3">
                      <div className="flex flex-col gap-4">
                        <section>
                          <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                            In this session · {posts.length}/{MAX_SESSION_SOURCES}
                          </p>
                          <SelectedSourcesStrip
                            posts={posts}
                            activeId={peekInSession ? (peek?.id ?? null) : null}
                            onCite={cite}
                            onRead={(id) => {
                              const p = posts.find((x) => x.id === id);
                              if (p) openPeek(p, true);
                            }}
                            onMove={move}
                            onRemove={(id) => {
                              const p = posts.find((x) => x.id === id);
                              if (p) toggle(p);
                            }}
                          />
                        </section>
                        <SourceSearch
                          query={query}
                          onQuery={setQuery}
                          kind={kind}
                          onKind={setKind}
                          counts={hitCounts ?? libraryCounts}
                          searching={searching}
                          mine={
                            mine
                              ? { on: mineOnly, label: `My account · @${mine.username}`, onToggle: () => setMineOnly((v) => !v) }
                              : null
                          }
                          format={{ on: formatOnly, onToggle: () => setFormatOnly((v) => !v) }}
                          elsewhere={mineOnly ? undefined : { on: showElsewhere, count: elsewhereCount, onToggle: () => setShowElsewhere((v) => !v) }}
                          order={activeResults ? undefined : { value: order, onChange: setOrder }}
                        />
                        {pastedLinks.length ? (
                          <div className="flex flex-col gap-2 rounded-lg border border-violet-400/30 bg-violet-500/[0.06] p-3 text-[12px]">
                            <p className="text-foreground">
                              {pastedLinks.length === 1 ? "A post or video" : `${pastedLinks.length} posts or videos`}: add {pastedLinks.length === 1 ? "it" : "them"} to your library and this session. The transcript and on-screen text start at once.
                            </p>
                            <div className="flex items-center gap-2">
                              <button type="button" disabled={adding?.busy || posts.length >= MAX_SESSION_SOURCES} onClick={() => void addFromLinks()} className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 font-medium text-white hover:bg-violet-500 disabled:opacity-50">
                                {adding?.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Add to the library and this session
                              </button>
                              <button type="button" onClick={() => setQuery("")} className="rounded-md px-2 py-1.5 text-muted-foreground hover:text-foreground">
                                Clear
                              </button>
                            </div>
                            {adding?.error ? <p className="text-red-300">{adding.error}</p> : null}
                          </div>
                        ) : activeResults && hits.length === 0 ? (
                          <p className="py-8 text-center text-sm text-muted-foreground">Nothing in the library talks about that yet.</p>
                        ) : !activeResults ? (
                          library === null ? (
                            <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" /> Loading the library…
                            </p>
                          ) : library.length === 0 ? (
                            <p className="py-8 text-center text-sm text-muted-foreground">
                              Nothing in the library yet —{" "}
                              <Link to="/instagram" className="text-violet-700 hover:underline dark:text-violet-300">
                                ingest posts in the Instagram Analyzer
                              </Link>{" "}
                              and they show up here.
                            </p>
                          ) : (
                            <div className="grid gap-2 md:grid-cols-2">
                              {shelf.map((h) => (
                                <SourceResultCard key={h.post.id} hit={h} plain selected={selectedIds.includes(h.post.id)} full={posts.length >= MAX_SESSION_SOURCES} usedIn={usesOf(h.post.id)} own={isOwnPost(h.post, contextAccount ?? mine)} onToggle={() => toggle(h.post)} onRead={() => openPeek(h.post)} />
                              ))}
                            </div>
                          )
                        ) : (
                          <div className="grid gap-2 md:grid-cols-2">
                            {hits.map((h) => (
                              <SourceResultCard key={h.post.id} hit={h} selected={selectedIds.includes(h.post.id)} full={posts.length >= MAX_SESSION_SOURCES} usedIn={usesOf(h.post.id)} own={isOwnPost(h.post, contextAccount ?? mine)} onToggle={() => toggle(h.post)} onRead={() => openPeek(h.post)} />
                            ))}
                          </div>
                        )}
                      </div>
                  </div>
                ),
              },
            }}
          />
          </div>
        </div>
      )}
      </div>
      {creatorId ? (
        <Dialog open onOpenChange={(open) => !open && setCreatorId(null)}>
          <DialogContent className="flex h-[min(900px,calc(100dvh-2rem))] w-[min(1100px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-y-auto p-6 sm:max-w-none">
            <DialogTitle className="sr-only">Creator</DialogTitle>
            <InstagramAccountPage accountId={creatorId} onOpenPost={openCreatorPost} onClose={() => setCreatorId(null)} />
          </DialogContent>
        </Dialog>
      ) : null}
      {auditOpen?.audit?.result ? (
        <AuditModal
          audit={{ ...auditOpen.audit, result: auditOpen.audit.result }}
          doc={docs.find((d) => d.id === auditOpen.audit!.target.id)}
          busy={thinking}
          onClose={() => setAuditMessageId(null)}
          onProcess={(claimIds) => processAudit(auditOpen, claimIds)}
        />
      ) : null}
    </div>
  );
}
