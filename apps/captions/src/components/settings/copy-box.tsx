import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { saveFailed } from "./ui";

/**
 * Text a person copies (a command, an address, a link, a key): the text in mono and Copy under it. The one copy of this
 * box in Settings: Headless access, Computers, Servers and Access keys all draw it.
 */
export function CopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-muted/40">
      <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed text-foreground">{text}</pre>
      <div className="flex justify-end border-t border-border/50 px-2 py-1.5">
        <Button
          type="button"
          size="sm"
          variant={copied ? "ghost" : "outline"}
          onClick={() =>
            void navigator.clipboard.writeText(text).then(
              () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              },
              () => saveFailed("Could not copy it. Select the text and copy it."),
            )
          }
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
