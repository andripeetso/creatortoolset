import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

/** Copies `text()` as plain text and says so for a moment. */
export function CopyButton({ text, label, title, className }: { text: () => string; label?: ReactNode; title: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={className}
      onClick={() => {
        void navigator.clipboard.writeText(text()).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {label ? (copied ? "Copied" : label) : null}
    </button>
  );
}
