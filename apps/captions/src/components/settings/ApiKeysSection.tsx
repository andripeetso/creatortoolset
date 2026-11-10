import { useEffect, useState } from "react";
import { MY_KEYS, type MyKeyEnv, type MyKeyGroup, type MyKeyView } from "@contracts/service-keys";
import type { SetupView } from "@contracts/tools";
import { removeApify, saveApify, type ApifyStatus } from "@/lib/instagram";
import { Card, ErrorRow, LoadingRow, Section } from "./ui";
import { KeyRow } from "./KeyRow";
import { getMyKeys, saveMyKey } from "./MyKeysSection";
import type { ApiKeyRowId } from "./search";
import { msg } from "./helpers";

const GROUPS: Array<{ id: MyKeyGroup; title: string }> = [
  { id: "voice", title: "Transcription and voice" },
  { id: "research", title: "Research and reading the web" },
  { id: "ai", title: "AI" },
];

async function json<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as T;
}
const getApify = () => fetch("/api/instagram/apify").then((r) => json<ApifyStatus>(r));

/**
 * The Apify key (other creators' public posts), one row on the API keys page and in the setup dialog. Saved by the
 * account's own Apify routes (api/instagram.ts), not api/my-keys.ts.
 */
export function ApifyKeyRow({ onChanged }: { onChanged?: () => void }) {
  const [status, setStatus] = useState<ApifyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => getApify().then(setStatus).catch((e) => setError(msg(e)));
  useEffect(() => void load(), []);
  if (!status)
    return error ? <ErrorRow title="Couldn't load the Apify key" detail={error} retry={() => (setError(null), void load())} /> : <LoadingRow />;
  return (
    <KeyRow
      id="apify-key"
      name="Apify"
      subtitle="Reading other creators' Instagram, TikTok and YouTube posts in Social accounts and the Content Analyzer"
      set={status.configured}
      last4={status.last4}
      readOnly={status.source === "env"}
      broken={status.configured && status.valid === false ? "Apify refused this key" : undefined}
      removeBody="Social accounts and the Content Analyzer stop reading public posts until you add it again."
      save={async (value) => {
        try {
          const s = value ? await saveApify(value) : await removeApify();
          if (value && s.valid === false) throw new Error("Apify refused this key. Paste a new one.");
        } finally {
          void load();
          onChanged?.();
        }
      }}
    />
  );
}

/**
 * Settings → API keys: every key the person can paste, in sections by what it is for. Each service appears once. A key
 * that is not set shows only its button. A key the server provides says so, and the person can use a key of their own
 * instead (their own key wins, api/my-keys.ts keyFor). Anthropic is listed only when the account has no AI of its own.
 */
export function ApiKeysSection() {
  const [keys, setKeys] = useState<MyKeyView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // no AI of its own yet: the Anthropic key is what the tools use. Until the check answers, it stays hidden.
  const [ownAi, setOwnAi] = useState(true);
  const reload = () => getMyKeys().then(setKeys).catch((e) => setError(msg(e)));
  useEffect(() => {
    void reload();
    void fetch("/api/setup")
      .then((r) => json<SetupView>(r))
      .then((v) => setOwnAi(v.have.includes("ownAi")))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!keys)
    return (
      <Card>
        {error ? <ErrorRow title="Couldn't load your API keys" detail={error} retry={() => (setError(null), void reload())} /> : <LoadingRow />}
      </Card>
    );

  const shown = (env: MyKeyEnv, mine?: MyKeyView) => env !== "ANTHROPIC_API_KEY" || !ownAi || !!mine?.set;
  const rows = (group: MyKeyGroup) =>
    MY_KEYS.filter((k) => k.group === group).map((k) => {
      const mine = keys.find((x) => x.env === k.env);
      if (!shown(k.env, mine)) return null;
      return (
        <KeyRow
          key={k.env}
          id={`api-key-${k.env}` as ApiKeyRowId}
          name={k.name}
          subtitle={k.what}
          where={"where" in k ? k.where : undefined}
          set={!!mine?.set}
          last4={mine?.last4}
          provided={!mine?.set && !!mine?.server}
          save={(v) => saveMyKey(k.env as MyKeyEnv, v).then(reload)}
        />
      );
    });

  return (
    <>
      {GROUPS.map((g) => (
        <Section key={g.id} title={g.title}>
          <Card>
            {g.id === "research" && <ApifyKeyRow />}
            {rows(g.id)}
          </Card>
        </Section>
      ))}
    </>
  );
}
