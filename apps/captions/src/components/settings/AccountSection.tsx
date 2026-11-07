import { useState } from "react";
import { KeyRound, LogOut } from "lucide-react";
import { logout, useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { AiKeyDialog } from "@/components/AiKeyDialog";
import { Card, Group, Row } from "./ui";

const ROLE_LABEL = { admin: "Administrator", team: "Team", user: "User", guest: "Guest" } as const;

/** Settings → Account: who is signed in, the AI access key, sign out. */
export function AccountSection() {
  const me = useAuth((s) => s.me);
  const [aiKey, setAiKey] = useState(false);
  if (!me) return null;

  return (
    <>
      <Group title="Signed in as">
        <Card>
          <Row label={me.username} hint={ROLE_LABEL[me.role]} />
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
