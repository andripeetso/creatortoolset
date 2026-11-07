import { useState } from "react";
import { KeyRound, LogOut } from "lucide-react";
import { logout, useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { AiKeyDialog } from "@/components/AiKeyDialog";
import { Card, Group, Row } from "./ui";

const ROLE_LABEL = { admin: "Administrator", team: "Team", user: "User" } as const;

/** Settings → Account: who is signed in, the password (when sign-in is on), the AI access key, sign out. */
export function AccountSection() {
  const me = useAuth((s) => s.me);
  const required = useAuth((s) => s.required);
  const [aiKey, setAiKey] = useState(false);
  if (!me) return null;

  return (
    <>
      <Group title="Signed in as">
        <Card>
          <Row label={me.username} hint={ROLE_LABEL[me.role]} />
          {required && <PasswordRow />}
        </Card>
      </Group>

      <Group title="Connections">
        <Card>
          <Row
            label="AI access key"
            hint="Lets your AI (an MCP connector in Claude, or a script) work here for you: Review only, or Full access to everything you can do. Shown once."
          >
            <Button variant="outline" size="sm" onClick={() => setAiKey(true)}>
              <KeyRound className="h-3.5 w-3.5" /> Make a key
            </Button>
          </Row>
        </Card>
      </Group>

      <Group title="Session">
        <Card>
          <Row label="Sign out" hint="On this device.">
            <Button variant="outline" size="sm" onClick={() => void logout()}>
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </Button>
          </Row>
        </Card>
      </Group>

      <AiKeyDialog open={aiKey} onClose={() => setAiKey(false)} />
    </>
  );
}

/** A new password (POST /api/auth/password): this session stays signed in, every other one is signed out. */
function PasswordRow() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await fetch("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current, password: next }) });
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    setNote(r.ok ? "Saved. Other devices are signed out." : (d.error ?? "Could not change it"));
    if (r.ok) [setCurrent, setNext].forEach((f) => f(""));
  };
  const field = "h-8 w-36 rounded-md border border-input bg-transparent px-2 text-sm";
  return (
    <Row label="Password" hint={note ?? "At least 6 characters."}>
      <form onSubmit={(e) => void save(e)} className="flex flex-wrap items-center gap-2">
        <input type="password" autoComplete="current-password" placeholder="Current" value={current} onChange={(e) => setCurrent(e.target.value)} className={field} />
        <input type="password" autoComplete="new-password" placeholder="New" value={next} onChange={(e) => setNext(e.target.value)} className={field} />
        <Button type="submit" variant="outline" size="sm" disabled={!current || next.length < 6}>Change</Button>
      </form>
    </Row>
  );
}
