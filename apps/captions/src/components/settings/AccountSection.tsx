import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, LogOut } from "lucide-react";
import { logout, useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
      <Group title="Profile" hint={`${ROLE_LABEL[me.role]}. Your files stay filed under "${me.username}" whatever you call yourself.`}>
        <Card>
          <NameRow />
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

/** What the app calls you (PATCH /api/auth/account): shown in the account menu and Settings. */
function NameRow() {
  const me = useAuth((s) => s.me);
  const required = useAuth((s) => s.required);
  const setAuth = useAuth((s) => s.setAuth);
  const [name, setName] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void fetch("/api/auth/account")
      .then((r) => (r.ok ? (r.json() as Promise<{ name: string }>) : null))
      .then((d) => setName(d?.name ?? ""))
      .catch(() => setName(""));
  }, []);
  if (!me || name === null) return null;
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get("name") ?? "");
    const r = await fetch("/api/auth/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: value }) });
    const d = (await r.json().catch(() => ({}))) as { error?: string; user?: Partial<typeof me> };
    if (r.ok && d.user) setAuth(required, { ...me, ...d.user });
    setNote(r.ok ? "Saved." : (d.error ?? "Could not save it"));
  };
  return (
    <Row label="Name" hint={note ?? "What the app calls you."}>
      <form onSubmit={(e) => void save(e)} className="flex gap-2">
        <Input name="name" defaultValue={name} placeholder={me.username} maxLength={60} className="h-8 w-44 text-sm" aria-label="Name" />
        <Button type="submit" variant="outline" size="sm">Save</Button>
      </form>
    </Row>
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
