import { useCachedLoad } from "@/lib/local-cache";
import { Link } from "react-router";
import { CircleAlert, Eye, KeyRound, ListTodo } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { canUse, useMe, type Me } from "@/lib/auth";
import type { EditSummary } from "@contracts/editor";
import { listEdits } from "@/lib/editor";
import { listReviewAssets, type ReviewAsset } from "@/lib/review";

export interface TodoRow {
  key: string;
  to: string;
  text: string;
  icon: "review" | "failed" | "key";
}

/** What waits on you, from the lists the Home page already reads: videos to review, and edits whose last step failed
 *  or needs a key. Pure, so the rows can be tested without a server. */
export function todoRows(edits: EditSummary[], assets: ReviewAsset[]): TodoRow[] {
  const review = assets
    .filter((a) => a.approval.status === "needs_review")
    .map((a): TodoRow => ({ key: `r:${a.id}`, to: `/review/${a.id}`, text: `${a.name} is waiting for your review`, icon: "review" }));
  const edit = edits
    .filter((e) => e.last?.state === "failed" || e.last?.state === "needs_key")
    .map((e): TodoRow => {
      const needsKey = e.last?.state === "needs_key";
      return {
        key: `e:${e.id}`,
        to: `/editor/${e.id}`,
        text: needsKey ? `${e.name} needs a key to continue` : `${e.name}: the last step failed`,
        icon: needsKey ? "key" : "failed",
      };
    });
  return [...review, ...edit];
}

const ICON = { review: Eye, failed: CircleAlert, key: KeyRound };
const TONE = { review: "text-amber-500", failed: "text-red-500", key: "text-amber-400" };

/** The two lists the to-do and Home's badges count, from their saved copies (the same keys as Review's page), live. */
export function useTodoLists(me: Me | null) {
  const edits = useCachedLoad<EditSummary[]>(canUse(me, "editor") ? "/api/editor" : null, listEdits);
  const assets = useCachedLoad<ReviewAsset[]>(canUse(me, "review") ? "/api/review" : null, listReviewAssets);
  return {
    edits: edits.data ?? [],
    assets: assets.data ?? [],
    refresh: () => void Promise.all([edits.refresh(), assets.refresh()]).catch(() => {}),
  };
}

/** The Home page's to-do: an icon with a count of what waits on you, opening a list of the rows. Live from the saved
 *  lists, read again when opened. Shown only for the tools the account may use. */
export function HomeTodo() {
  const me = useMe();
  const show = canUse(me, "editor") || canUse(me, "review");
  if (!show) return null;
  return <TodoButton me={me} />;
}

function TodoButton({ me }: { me: Me | null }) {
  const { edits, assets, refresh } = useTodoLists(me);
  const rows = todoRows(edits, assets);
  const waiting = rows?.length ?? 0;
  return (
    <Popover onOpenChange={(open) => open && refresh()}>
      <PopoverTrigger asChild>
        <button
          title="To do"
          aria-label={waiting ? `To do, ${waiting} waiting` : "To do"}
          className="relative rounded-lg p-2 text-muted-foreground outline-none hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
        >
          <ListTodo className="h-4 w-4" />
          {waiting > 0 && (
            <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
              {waiting > 9 ? "9+" : waiting}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[94vw] p-0">
        <p className="border-b px-3 py-2 text-sm font-medium">To do</p>
        <div className="max-h-96 overflow-y-auto">
          {rows && rows.length === 0 && (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">Nothing is waiting on you.</p>
          )}
          {rows?.map((r) => {
            const Icon = ICON[r.icon];
            return (
              <Link key={r.key} to={r.to} className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs hover:bg-accent">
                <Icon className={`h-3.5 w-3.5 shrink-0 ${TONE[r.icon]}`} />
                <span className="min-w-0 flex-1 truncate">{r.text}</span>
              </Link>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
