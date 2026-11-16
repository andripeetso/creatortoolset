import type { MemoryFact } from "@contracts/memory";
import { useCachedLoad } from "@/lib/local-cache";
import { Card, EmptyRow, ErrorRow, ListRow, LoadingRow, RowMenu, Section } from "./ui";

/** This window's own remove reads the list again too. */
const OWN_TOO = { own: true };

async function call<T>(path = "", method = "GET"): Promise<T> {
  const r = await fetch(`/api/memory${path}`, { method, credentials: "same-origin" }).catch(() => null);
  if (!r) throw new Error("Can't reach the server");
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `Failed (${r.status})`);
  return data;
}

/**
 * Settings → Memory: what the assistant keeps from one chat to the next (api/memory.ts): the rule it wrote, what the
 * person said under it, and Remove in the row's menu. Things get in only by being said to the assistant, so there is nothing to add here, and with
 * nothing kept the list says so in one line, as the other Settings lists do (a blank page reads as a broken one). The
 * list follows the chat: a fact kept while the page is open shows at once.
 */
export function MemorySection() {
  const kept = useCachedLoad<{ facts: MemoryFact[] }>("/api/memory", () => call<{ facts: MemoryFact[] }>(), OWN_TOO);
  const facts = kept.data?.facts;
  const refresh = kept.refresh;
  if (!facts) return <Card>{kept.error ? <ErrorRow title="Could not load what is kept" detail={kept.error} retry={() => void refresh().catch(() => {})} /> : <LoadingRow />}</Card>;
  return (
    <Section title="Rules from your chats">
      <Card>
        {!facts.length && <EmptyRow title="Nothing kept yet" />}
        {facts.map((f) => (
          <ListRow
            key={f.id}
            // a rule is one sentence: it wraps rather than being cut
            title={<span className="whitespace-normal font-normal [overflow-wrap:anywhere]">{f.text}</span>}
            subtitle={f.said && <span title={f.said}>You said “{f.said}”</span>}
            status={f.project?.name}
            actions={<RowMenu label="Rule" items={[{ label: "Remove", destructive: true, confirm: { title: "Remove this rule?" }, onSelect: () => call(`/${f.id}`, "DELETE").then(refresh) }]} />}
          />
        ))}
      </Card>
    </Section>
  );
}
