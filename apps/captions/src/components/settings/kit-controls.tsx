import { Fragment, useEffect, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { confirmDialog } from "@/lib/dialogs";
import { cn } from "@/lib/utils";

/** The one place a failed save is said: a toast with a plain sentence. The control shows its old value again. */
export function saveFailed(message: string): void {
  toast.error(message);
}

const field = "h-8 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/**
 * A text setting. Saves on blur or Enter (no Save button); a value that did not change is not sent. If the save throws,
 * the field goes back to the saved value and a toast says why. `label` is required (it is the field's accessible name).
 */
export function TextField({ label, value, onCommit, placeholder, type = "text", maxLength, disabled, className }: {
  label: string;
  value: string;
  onCommit: (next: string) => unknown | Promise<unknown>;
  placeholder?: string;
  type?: "text" | "email";
  maxLength?: number;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = async () => {
    if (draft === value) return;
    try {
      await onCommit(draft);
    } catch (e) {
      setDraft(value);
      saveFailed(e instanceof Error && e.message ? e.message : "That did not save. Try again.");
    }
  };
  return (
    <input
      aria-label={label}
      type={type}
      value={draft}
      placeholder={placeholder}
      maxLength={maxLength}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className={cn(field, "sm:w-72", className)}
    />
  );
}

/**
 * A secret (an API key). Shows dots; when a key is saved, `last4` shows as the placeholder so the person can tell which
 * one it is. Controlled: the caller keeps the typed value and saves it (in a dialog, with its own button).
 */
export function SecretField({ label, value, onChange, last4, placeholder, error, disabled }: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  last4?: string | null;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <div className="w-full">
      <input
        aria-label={label}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        aria-invalid={!!error}
        placeholder={last4 ? `••••••••${last4}` : placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(field, "font-mono", error && "border-destructive")}
      />
      {error && <p role="alert" className="pt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

/** A choice from a short list, on the Radix select at size sm: full width below `sm`, 11rem from `sm` up. */
export function SettingsSelect({ label, value, onValueChange, options, disabled, className }: {
  label: string;
  value: string;
  onValueChange: (next: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger size="sm" aria-label={label} className={cn("w-full sm:w-44", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The status of a thing, quiet by default. No tone = information (a version, a plan), muted text. "attention" = the person
 * must act: an amber dot, and the action button goes next to it. "broken" = something failed: red. Never green.
 */
export function Status({ tone, children }: { tone?: "attention" | "broken"; children: ReactNode }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs", tone === "broken" ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
      {tone && <StatusDot tone={tone} />}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/** The small dot of a Status: amber for "the person must act", red for "broken". */
export function StatusDot({ tone }: { tone: "attention" | "broken" }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone === "broken" ? "bg-red-500" : "bg-amber-500")} />;
}

export interface RowMenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => unknown;
  /** Shown last, in red. Pair it with `confirm` (anything that removes or stops something). */
  destructive?: boolean;
  /** Asked first with the app's own dialog (confirmDialog). The item runs only on OK. */
  confirm?: { title: string; body?: string; ok?: string };
}

/**
 * The `…` menu of a row: secondary and destructive actions. Destructive items go last, in red, after a separator, and
 * always ask first (`confirm`).
 */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const plain = items.filter((i) => !i.destructive);
  const danger = items.filter((i) => i.destructive);
  const run = async (it: RowMenuItem) => {
    if (it.confirm) {
      const ok = await confirmDialog({ title: it.confirm.title, body: it.confirm.body, ok: it.confirm.ok ?? it.label, danger: it.destructive });
      if (!ok) return;
    }
    try {
      await it.onSelect();
    } catch (e) {
      saveFailed(e instanceof Error && e.message ? e.message : `${it.label} did not work. Try again.`);
    }
  };
  const render = (it: RowMenuItem) => (
    <DropdownMenuItem
      key={it.label}
      onSelect={() => void run(it)}
      className={cn("text-sm", it.destructive && "text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400")}
    >
      {it.icon}
      {it.label}
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} title={label}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {plain.map(render)}
        {plain.length > 0 && danger.length > 0 && <DropdownMenuSeparator />}
        {danger.map((it) => (
          <Fragment key={it.label}>{render(it)}</Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
