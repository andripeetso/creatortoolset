import { useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

type Level = "review" | "full";

/** AI access keys at two levels (api/users.ts KeyLevel): Review only, or Full = the site headless, as you. */
export function AiKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [key, setKey] = useState("");
  const [made, setMade] = useState<Level>("review");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const create = async (level: Level) => {
    setError("");
    const res = await fetch("/api/auth/api-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level }),
    }).catch(() => null);
    const j = await res?.json().catch(() => null);
    if (res?.ok && j?.key) {
      setKey(j.key);
      setMade(level);
    }
    else setError(j?.error || "Couldn't make a key. Try again.");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setKey("");
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>AI access key</DialogTitle>
          <DialogDescription>
            Lets your AI (an MCP connector in Claude, ChatGPT, Cursor, or a script)
            work in Creator Toolset for you. Pick how much it may do. Making a new
            key turns off the old key of that level.
          </DialogDescription>
        </DialogHeader>
        {key ? (
          <>
            <p className="text-sm font-medium">{LEVELS.find((l) => l.level === made)?.name} key</p>
            <div className="flex gap-1.5">
              <input
                readOnly
                value={key}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={async () => {
                  await navigator.clipboard.writeText(key);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Shown once. Put it in the MCP config as <code>CT_API_KEY</code>, or send
              it as <code>Authorization: Bearer …</code>.
            </p>
            {made === "full" && (
              <div className="rounded-md border p-2.5 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">Use it from claude.ai, ChatGPT or any AI app</p>
                <p className="mt-1">
                  Add a custom connector with the address <code>{`${window.location.origin}/api/mcp`}</code>, choose no sign-in,
                  and add the request header <code>Authorization</code> = <code>Bearer</code> + this key. In claude.ai: Settings →
                  Connectors → Add custom connector. It then works in the Claude app on your phone too.
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="grid gap-2">
            {LEVELS.map((l) => (
              <div key={l.level} className="flex items-start gap-3 rounded-md border p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{l.name}</p>
                  <p className="text-xs text-muted-foreground">{l.what}</p>
                </div>
                <Button size="sm" variant={l.level === "full" ? "default" : "outline"} onClick={() => void create(l.level)}>
                  <KeyRound /> Make
                </Button>
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-xs text-rose-500">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}

const LEVELS: { level: Level; name: string; what: string }[] = [
  {
    level: "review",
    name: "Review only",
    what: "Reads your Review videos and comments, resolves a comment once it made the change, uploads a cut.",
  },
  {
    level: "full",
    name: "Full access",
    what: "Does what you can do on the site: Workshop projects, sessions, pieces and chat, Review. Never Admin, AI settings, paired Macs or your sign-in. Give it only to AIs you trust.",
  },
];
