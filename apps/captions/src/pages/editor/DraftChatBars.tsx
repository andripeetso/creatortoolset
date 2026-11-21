import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { Check, CornerUpLeft, Loader2, MessagesSquare } from "lucide-react";
import type { Draft, Edit } from "@contracts/editor";
import type { NleFoot } from "@/components/nle/NleEditor";
import { approveCut } from "@/components/assistant/VideoCard";
import { askAbout } from "@/lib/assistant";
import { getEditChat } from "@/lib/editor";
import { letterOf } from "@/lib/editor-takes";
import { cn } from "@/lib/utils";
import { versionTitle } from "./ProjectView";

// The draft page beside the chats (chat mode): over the viewer the draft and its versions, under the timeline what the
// person changed and their two answers, Send back and Approve. Saving stays theirs: both save their changes first.

const making = (e: Edit, v: string) => e.jobs.some((j) => j.variant === v && (j.state === "queued" || j.state === "running"));

/** `Draft 2` (its Review version) and `Version A | Version B` (a spinner on one being made), and this edit's chat. */
export function RoundBar({ e, name }: { e: Edit; name: string }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const versions = e.plans.filter((p) => !e.marks?.[p.name]?.trashedAt && (e.drafts.includes(p.name) || making(e, p.name)));
  // the newest chat about this edit (one the phone or a chat made it from), to open beside it
  const [chat, setChat] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getEditChat(e.id).then((v) => live && setChat(v.chat ?? null), () => {});
    return () => void (live = false);
  }, [e.id]);
  const open = (v: string) => v !== name && navigate(`/editor/${e.id}/${v}`);
  return (
    <>
      <span className="shrink-0 px-1 text-[13px] font-semibold text-zinc-100">Draft {e.previews[name]?.n ?? 1}</span>
      {versions.length > 1 && (
        <span role="group" aria-label="Versions" className="inline-flex min-w-0 shrink overflow-x-auto rounded-md border border-zinc-700/70 p-0.5 [scrollbar-width:none]">
          {versions.map((p) => (
            <button key={p.name} type="button" aria-pressed={p.name === name} disabled={!e.drafts.includes(p.name)} onClick={() => open(p.name)}
              title={e.drafts.includes(p.name) ? versionTitle(e, p.name) : "Being made"}
              className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] px-2.5 text-[12px] disabled:opacity-60",
                p.name === name ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:text-zinc-100")}>
              {making(e, p.name) && <Loader2 className="size-3 animate-spin" />}Version {letterOf(e, p.name)}
            </button>
          ))}
        </span>
      )}
      {chat && (
        <button type="button" onClick={() => navigate(`${pathname}?chat=${encodeURIComponent(chat)}`)} title="Open the chat about this edit"
          className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-zinc-300 hover:bg-white/[0.06]">
          <MessagesSquare className="size-3.5" /> This edit's chat
        </button>
      )}
    </>
  );
}

/**
 * Under the timeline: the person's changes, ↩ Send back and ✓ Approve. Send back saves their changes and puts the version
 * and what they changed in the chat box, where they say what should change. Approve takes the Review version that is
 * exactly the saved timeline (a save first renders a new one: Approve waits for it).
 */
export function ChatFoot({ f, e, name, unsaved, filed, busy }: {
  f: NleFoot; e: Edit; name: string;
  /** their unsaved changes in words (contracts/edit-summary describeChanges) */
  unsaved: string;
  /** the Review version whose cut is exactly the saved timeline */
  filed: Draft["filed"];
  /** the page is saving or this version is being made */
  busy: boolean;
}) {
  const navigate = useNavigate();
  const [doing, setDoing] = useState<"approve" | "back" | null>(null);
  const title = versionTitle(e, name);
  const run = (which: "approve" | "back", fn: () => Promise<void>) => {
    setDoing(which);
    fn().catch((x: Error) => x.message && toast.error(x.message)).finally(() => setDoing(null));
  };
  const sendBack = () => run("back", async () => {
    const changed = unsaved;
    if (!(await f.save())) return;
    askAbout(`Send back ${e.name}, ${title}${changed ? `, with my changes: ${changed}` : f.changes ? ", with my changes" : ""}`);
  });
  const approve = () => run("approve", async () => {
    if (!filed) return;
    const notInFinals = await approveCut({ asset: filed.assetId, n: filed.n });
    if (notInFinals) toast(`Approved, not in Finals: ${notInFinals}`);
    else toast(`${title} is approved`, { action: { label: "Open in Review", onClick: () => navigate(`/review/${filed.assetId}?v=${filed.n}`) } });
  });
  const said = !f.changes ? "No changes by you yet" : `${f.changes} ${f.changes === 1 ? "change" : "changes"} by you · ${f.dirty ? "not saved yet" : "saved"}`;
  const off = busy || !!doing;
  const waits = f.dirty ? "Save your changes first (⌘S): their render is what gets approved" : !filed ? "Its render isn't in Review yet" : "";
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 px-1.5 pt-1">
      <p className="mr-auto min-w-0 truncate text-[12px] text-zinc-400">{said}</p>
      <button type="button" disabled={off} onClick={sendBack} title="Your changes saved and a note in the chat box: say what should change"
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-zinc-700 px-3 text-[13px] text-zinc-200 hover:bg-white/[0.06] disabled:opacity-50">
        {doing === "back" ? <Loader2 className="size-3.5 animate-spin" /> : <CornerUpLeft className="size-3.5" />} Send back
      </button>
      <button type="button" disabled={off || !!waits} onClick={approve} title={waits || "Approve this cut in Review"}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-[13px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
        {doing === "approve" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Approve
      </button>
    </div>
  );
}
