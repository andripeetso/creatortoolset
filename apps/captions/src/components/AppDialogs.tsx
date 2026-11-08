import { useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

import { setDialogHost, type DialogAsk } from "@/lib/dialogs";

type Ask = DialogAsk & { id: number };

/** Draws the confirm / prompt / alert asked for through `@/lib/dialogs`, one at a time. */
export function AppDialogs() {
  const [queue, setQueue] = useState<Ask[]>([]);
  useEffect(() => {
    let n = 0;
    setDialogHost((a) => setQueue((q) => [...q, { ...a, id: ++n }]));
    return () => setDialogHost(null);
  }, []);
  const cur = queue[0];
  if (!cur) return null;
  return (
    <Box
      key={cur.id}
      ask={cur}
      close={(v) => {
        cur.done(v);
        setQueue((q) => q.filter((x) => x.id !== cur.id));
      }}
    />
  );
}

function Box({ ask, close }: { ask: Ask; close: (v: boolean | string | null) => void }) {
  const [text, setText] = useState(ask.value ?? "");
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  // the action button also closes the dialog (onOpenChange): answer once
  const finish = (v: boolean | string | null) => {
    if (settled.current) return;
    settled.current = true;
    close(v);
  };
  const yes = () => finish(ask.kind === "prompt" ? text : true);
  return (
    <AlertDialog open onOpenChange={(o) => !o && finish(ask.kind === "prompt" ? null : false)}>
      <AlertDialogContent
        className="border-zinc-800 bg-zinc-950 text-zinc-200 sm:max-w-md"
        onOpenAutoFocus={(e) => {
          if (ask.kind !== "prompt") return;
          e.preventDefault();
          input.current?.focus();
          input.current?.select();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base">{ask.title}</AlertDialogTitle>
          <AlertDialogDescription className={cn("whitespace-pre-line text-zinc-400", !ask.body && "sr-only")}>
            {ask.body ?? ask.title}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {ask.kind === "prompt" && (
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              yes();
            }}
            className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-violet-500"
          />
        )}
        <AlertDialogFooter>
          {ask.kind !== "alert" && (
            <AlertDialogCancel className="border-zinc-800 bg-transparent text-zinc-200 hover:bg-zinc-900 hover:text-zinc-100">
              Cancel
            </AlertDialogCancel>
          )}
          <AlertDialogAction
            onClick={yes}
            className={ask.danger ? "bg-rose-600 text-white hover:bg-rose-500" : undefined}
          >
            {ask.ok ?? "OK"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
