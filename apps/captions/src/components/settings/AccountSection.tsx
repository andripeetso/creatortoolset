import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, LogOut } from "lucide-react";
import { logout, useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

/** Password: one Change button; the dialog takes the current and new password (POST /api/auth/password), this
 * session stays signed in and every other one is signed out. */
function PasswordRow() {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <Row label="Password" hint={note ?? undefined}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Change
      </Button>
      <PasswordDialog open={open} onClose={() => setOpen(false)} onDone={() => setNote("Changed. Other devices are signed out.")} />
    </Row>
  );
}

function PasswordDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    const r = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current: f.get("current"), password: f.get("next") }),
    }).catch(() => null);
    const d = (await r?.json().catch(() => ({}))) as { error?: string } | undefined;
    setBusy(false);
    if (r?.ok) return onDone(), onClose();
    setError(d?.error ?? "Could not change it");
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && (setError(""), onClose())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>Your other devices sign in again with the new one.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="grid gap-2">
          <Input name="current" type="password" autoComplete="current-password" placeholder="Current password" autoFocus required />
          <Input name="next" type="password" autoComplete="new-password" placeholder="New password (6+ characters)" minLength={6} required />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Change password"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
