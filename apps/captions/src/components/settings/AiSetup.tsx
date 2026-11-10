import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { Driver } from "@contracts/providers";
import { Button } from "@/components/ui/button";

/**
 * How to install and sign in a coding tool on a computer, from its own docs: shown when the tool is not there. The site
 * never installs anything on a computer itself: that would make it a way to run commands there. A tool not listed here
 * gets only a line saying to install it there and press Test.
 */
const TOOLS: Partial<Record<Driver, { name: string; install: string; signIn: string }>> = {
  claude: { name: "Claude Code", install: "curl -fsSL https://claude.ai/install.sh | bash", signIn: "claude" },
  codex: { name: "Codex", install: "npm install -g @openai/codex", signIn: "codex login" },
  gemini: { name: "Gemini CLI", install: "npm install -g @google/gemini-cli", signIn: "gemini" },
};

/** The install and sign-in lines for one tool, on its detail page and in the Add provider dialog, when the computer doesn't have it. */
export function InstallHelp({ driver }: { driver: Driver }) {
  const tool = TOOLS[driver];
  if (!tool) {
    return <p className="text-xs text-muted-foreground">Not installed on this computer. Install it there, then press Test.</p>;
  }
  return (
    <div className="space-y-1.5 text-xs text-muted-foreground">
      <p>Not installed on this computer. Install {tool.name} in Terminal there:</p>
      <Command text={tool.install} />
      <p>
        Then sign in: run <code>{tool.signIn}</code> once.
      </p>
    </div>
  );
}

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded border bg-muted px-2 py-1 font-mono text-[11px] text-foreground">{text}</code>
      <Button
        size="icon-xs"
        variant="outline"
        aria-label="Copy command"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
