import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { KeyRound, MessageCircle, Send, X } from "lucide-react";
import type { AssistantView } from "@contracts/assistant";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isDemo, isGuest, useViewedMe } from "@/lib/auth";
import {
  cancelSecret,
  getAssistant,
  keySaved,
  navigated,
  openAssistant,
  remember,
  rememberedFor,
  saveKey,
  sendTurn,
  useAssistant,
} from "@/lib/assistant";
import { cn } from "@/lib/utils";

/**
 * The assistant dock, bottom right of every signed-in page (App.tsx). Its state is the server's (api/assistant.ts):
 * no AI yet = "Connect your AI first"; an AI = the choice of setup paths on the first open, then the chat. "Later"
 * collapses it to a small button. A key it asks for is typed into a password box that saves straight to My API keys.
 */
export function AssistantDock() {
  const me = useViewedMe();
  const navigate = useNavigate();
  const { collapsed, setupAsked, set } = useAssistant();
  const real = !!me && !isGuest(me) && !isDemo(me);
  const user = me?.username ?? "";
  const [view, setView] = useState<AssistantView | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await getAssistant();
    if (r.ok) setView(r.data);
  }, []);

  useEffect(() => {
    if (!real) return;
    const remembered = rememberedFor(user);
    // only a setup path counts as chosen; "later" just starts collapsed, and the choices still show when it opens
    setChoice(remembered === "self" || remembered === "chat" ? remembered : null);
    if (remembered === "later") set({ collapsed: true });
    void load();
  }, [real, user, load, set]);

  const thinking = view?.messages.at(-1)?.status === "thinking";
  // a reply on the Mac takes a while: look again every 1.5 s until it's done
  useEffect(() => {
    if (!real || !thinking) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [real, thinking, load]);

  // a page the assistant opened: move there once, then clear it on the server
  useEffect(() => {
    if (!view?.navigate) return;
    navigate(view.navigate);
    void navigated().then((r) => r.ok && setView(r.data));
  }, [view?.navigate, navigate]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [view?.messages.length, view?.pending, collapsed]);

  if (!real) return null;

  const send = async (text: string) => {
    setBusy(true);
    setError(null);
    const r = await sendTurn(text);
    setBusy(false);
    if (r.ok) setView(r.data);
    else {
      setError(r.error);
      if (r.code === "NO_PROVIDER") void load();
    }
  };

  const submitChat = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy || thinking) return;
    setDraft("");
    void send(text);
  };

  const pick = (how: "self" | "chat") => {
    remember(user, how);
    setChoice(how);
    set({ setupAsked: false });
    if (how === "self") navigate("/?setup=project");
    else void send("Set me up. Go one step at a time.");
  };

  // Later stays collapsed across page loads (the X only folds it for this page)
  const later = () => {
    remember(user, "later");
    set({ collapsed: true });
  };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => {
          remember(user, "open");
          openAssistant();
        }}
        className="fixed right-4 bottom-4 z-40 flex items-center gap-2 rounded-full border bg-popover px-4 py-2 text-sm text-popover-foreground shadow-md hover:bg-accent"
      >
        <MessageCircle className="size-4" aria-hidden />
        I&apos;m here if you need me.
      </button>
    );
  }

  const showChoice = !!view && view.provider !== "none" && (setupAsked || (!choice && view.messages.length === 0));
  const pending = view?.pending;

  return (
    <section
      aria-label="Assistant"
      className="fixed right-4 bottom-4 z-40 flex h-[min(540px,72dvh)] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg"
    >
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <span className="text-sm font-medium">Assistant</span>
        <Button variant="ghost" size="icon-sm" onClick={() => set({ collapsed: true })} aria-label="Hide the assistant">
          <X className="size-4" />
        </Button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        {!view && <p className="text-muted-foreground">Loading…</p>}

        {view?.provider === "none" && (
          <div className="space-y-3">
            <p className="font-medium">Install Claude Code first</p>
            <p className="text-muted-foreground">The assistant runs on your own Claude, on this Mac and your own plan. Install it and sign in, then come back:</p>
            <pre className="select-all rounded bg-muted px-2 py-1.5 text-xs">npm install -g @anthropic-ai/claude-code{"\n"}claude</pre>
            <Button size="sm" variant="outline" onClick={() => navigate("/?setup=ai")}>Check again</Button>
          </div>
        )}

        {showChoice && (
          <div className="space-y-3">
            <p>Want help setting up Creator Toolset?</p>
            <div className="flex flex-col gap-2">
              <Button variant="outline" onClick={() => pick("self")}>Do it myself (click through the setup)</Button>
              <Button onClick={() => pick("chat")} disabled={busy}>Set up with chat</Button>
              <Button variant="ghost" onClick={later}>Later</Button>
            </div>
          </div>
        )}

        {view && view.provider !== "none" && !showChoice &&
          view.messages.map((m) => (
            <div
              key={m.id}
              className={cn(
                "max-w-[88%] rounded-lg px-3 py-2 whitespace-pre-wrap",
                m.role === "user" && "ml-auto bg-primary text-primary-foreground",
                m.role === "assistant" && "bg-muted",
                m.role === "note" && "mx-auto text-center text-xs text-muted-foreground",
              )}
            >
              {m.status === "thinking" ? <span className="text-muted-foreground">Thinking…</span> : m.text || (m.status === "error" ? "That didn't work." : "")}
            </div>
          ))}

        {pending && (
          <form
            className="space-y-2 rounded-lg border border-dashed p-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const value = secret.trim();
              setSecret("");
              if (!value) return;
              const saved = await saveKey(pending.env, value);
              if (!saved.ok) return setError(saved.error);
              const r = await keySaved(pending.env);
              if (r.ok) setView(r.data);
              else setError(r.error);
            }}
          >
            <p className="flex items-center gap-2 font-medium"><KeyRound className="size-4" aria-hidden /> {pending.name} key</p>
            <p className="text-muted-foreground">{pending.why}</p>
            <Input type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={`Paste your ${pending.name} key`} aria-label={`${pending.name} key`} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!secret.trim()}>Save key</Button>
              <Button type="button" size="sm" variant="ghost" onClick={async () => { setSecret(""); const r = await cancelSecret(); if (r.ok) setView(r.data); }}>Not now</Button>
            </div>
          </form>
        )}

        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <div ref={bottom} />
      </div>

      {view && view.provider !== "none" && !showChoice && (
        <form onSubmit={submitChat} className="flex gap-2 border-t p-3">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={thinking ? "Thinking…" : "Ask, or say what to set up"} aria-label="Message the assistant" disabled={thinking} />
          <Button type="submit" size="icon" disabled={busy || thinking || !draft.trim()} aria-label="Send">
            <Send className="size-4" />
          </Button>
        </form>
      )}
    </section>
  );
}
