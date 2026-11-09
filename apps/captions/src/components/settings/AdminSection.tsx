import { Link } from "react-router";
import { AdminPanel, type AdminTab } from "@/components/AdminPanel";
import { cn } from "@/lib/utils";

const TABS: Array<{ id: AdminTab; label: string }> = [
  { id: "users", label: "Accounts" },
  { id: "access", label: "Access" },
  { id: "projects", label: "Projects" },
];

/** Settings → Admin (hosted servers, platform admins only): accounts, which apps each gets, and the server's projects. */
export function AdminSection({ sub }: { sub?: string }) {
  const tab = TABS.find((t) => t.id === sub)?.id ?? "users";
  return (
    <>
      <div role="tablist" aria-label="Admin" className="mb-5 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={`/settings/admin/${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            replace
            className={cn(
              "-mb-px border-b-2 px-2.5 py-2 text-sm transition-colors",
              tab === t.id ? "border-violet-500 font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
      <AdminPanel tab={tab} />
    </>
  );
}
