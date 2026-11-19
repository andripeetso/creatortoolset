import { useLocation, useNavigate } from "react-router";
import { useImportQueue } from "@/lib/import-queue";
import { summaryLine } from "@/pages/library/Placeholders";

/**
 * A Media Library import going in while the person is somewhere else (lib/import-queue.ts): its one line in the top bar,
 * a click away from the Library, where its cards are. Nothing on the Library page itself (its own line is there).
 */
export function ImportIndicator() {
  const { items, startedAt, usd } = useImportQueue();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const line = summaryLine(items, startedAt, Date.now(), usd);
  if (!line || pathname.startsWith("/library")) return null;
  return (
    <button
      type="button"
      role="status"
      onClick={() => navigate("/library")}
      className="hidden max-w-[22rem] truncate rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground sm:block"
      title={line}
    >
      {line}
    </button>
  );
}
