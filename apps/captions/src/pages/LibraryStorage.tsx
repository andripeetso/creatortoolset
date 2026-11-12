import { useEffect, useState, type ReactNode } from "react";
import { applyS3Preset, BUNNY_REGIONS, S3_PRESETS, type BunnyRegion, type LibraryStorage, type LibraryStorageInput, type S3PresetId } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, Row, Section } from "@/components/settings/ui";
import { getLibraryStorage, setLibraryStorage } from "@/lib/library";

/**
 * Where a library keeps its files, for its owner, in the library's settings (api/library/usage.ts): this server's disk,
 * the server's bucket, the library's own S3-compatible bucket (made when it doesn't exist yet), or Bunny Storage, set up
 * whole from one account key (the server makes the zones). A bucket library shows what it holds. Saved keys are
 * never shown again. `onThisComputer`: the server runs on the person's own computer, so its disk is called that. A library
 * that holds files keeps where they are: then it says where in one line, with no choice to make (an own bucket's keys
 * and region can still change). `children`: more rows of the same card (the space its made files take).
 */

type Choice = "local" | "server" | "own" | "bunny";

const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(n < 10e6 ? 1 : 0)} MB`);

export function LibraryStorageSettings({
  libraryId,
  onSaved,
  onThisComputer = false,
  children,
}: {
  libraryId: string;
  onSaved: (kind: LibraryStorage["kind"]) => void;
  onThisComputer?: boolean;
  children?: ReactNode;
}) {
  const [s, setS] = useState<LibraryStorage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<Choice>("local");
  const [form, setForm] = useState({ endpoint: "", region: "", bucket: "", pathStyle: false, accessKey: "", secretKey: "" });
  /** The chosen preset's endpoint example, shown as the endpoint field's placeholder (never as its value). */
  const [endpointHint, setEndpointHint] = useState("");
  /** Where the chosen preset's provider makes keys. */
  const [keysUrl, setKeysUrl] = useState("");
  const [bunny, setBunny] = useState<{ apiKey: string; region: BunnyRegion }>({ apiKey: "", region: "DE" });

  const show = (v: LibraryStorage) => {
    setS(v);
    setChoice(v.kind === "local" || v.kind === "bunny" ? v.kind : (v.mode ?? "own"));
    setBunny((b) => ({ ...b, apiKey: "" }));
    setForm({ endpoint: v.endpoint ?? "", region: v.region ?? "", bucket: v.bucket ?? "", pathStyle: !!v.pathStyle, accessKey: "", secretKey: "" });
  };
  useEffect(() => {
    getLibraryStorage(libraryId).then(show, (e: Error) => setError(e.message));
  }, [libraryId]);

  const save = async () => {
    const input: LibraryStorageInput =
      choice === "local"
        ? { kind: "local" }
        : choice === "bunny"
          ? { kind: "bunny", apiKey: bunny.apiKey.trim() || undefined, region: bunny.region }
          : choice === "server"
          ? { kind: "s3", mode: "server" }
          : { kind: "s3", mode: "own", ...form, accessKey: form.accessKey || undefined, secretKey: form.secretKey || undefined };
    setBusy(true);
    try {
      const v = await setLibraryStorage(libraryId, input);
      show(v);
      onSaved(v.kind);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disk = onThisComputer ? "This computer's disk" : "This server's disk";
  // a bucket says what it holds; this disk is the chosen option below, said once, or the one line when it can't change
  const where =
    s?.kind === "bunny"
      ? `Kept in Bunny Storage (${s.zone}) · ${gb(s.storedBytes ?? 0)}`
      : s?.kind === "s3"
        ? `Kept in ${s.mode === "server" ? "the server's bucket" : s.bucket} · ${gb(s.storedBytes ?? 0)}`
        : s?.locked ? `Kept on ${onThisComputer ? "this computer's" : "this server's"} disk` : "";
  // what can still change: everything, an own bucket's keys and region, or nothing
  const changeable = !!s && (!s.locked || choice === "own");
  const field = (key: "endpoint" | "region" | "bucket" | "accessKey" | "secretKey", label: string, placeholder: string, locked = false) => (
    <label className="flex flex-col gap-1">
      <span className="text-zinc-500">{label}</span>
      <Input
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        placeholder={placeholder}
        disabled={locked}
        type={key === "secretKey" ? "password" : "text"}
        autoComplete="off"
      />
    </label>
  );
  const option = (value: Choice, text: string) => (
    <label className="flex items-center gap-2">
      <input type="radio" name={`storage-${libraryId}`} checked={choice === value} disabled={s?.locked} onChange={() => setChoice(value)} />
      {text}
    </label>
  );
  const ownLocked = !!s?.locked; // a library with files keeps its bucket; only the keys and region can change
  const pick = (id: string) => {
    if (!id) return;
    setForm((f) => applyS3Preset(f, id as S3PresetId));
    const p = S3_PRESETS.find((x) => x.id === id);
    setEndpointHint(p?.endpointHint ?? "");
    setKeysUrl(p?.keysUrl ?? "");
  };

  return (
    <Section title="Storage">
      <Card>
        {where && !changeable && <Row title={where} />}
        {/* nothing until it is known what can change, so no choice shows and then goes */}
        {changeable && (
        <div className="flex flex-col gap-3 px-3 py-3 text-sm sm:px-4">
          {where && <p className="font-medium">{where}</p>}
          {!s?.locked && (
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {option("local", disk)}
              {(s?.serverBucket || choice === "server") && option("server", "The server's bucket")}
              {option("bunny", "Bunny Storage")}
              {option("own", "Amazon S3 or Cloudflare R2")}
            </div>
          )}
          {choice === "bunny" && s?.kind !== "bunny" && (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-zinc-500">
                  Bunny API key ·{" "}
                  <a href="https://dash.bunny.net/account/api-key" target="_blank" rel="noreferrer" className="underline">
                    get it
                  </a>
                </span>
                <Input value={bunny.apiKey} onChange={(e) => setBunny({ ...bunny, apiKey: e.target.value })} type="password" autoComplete="off" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-zinc-500">Region</span>
                <select
                  aria-label="Bunny region"
                  value={bunny.region}
                  onChange={(e) => setBunny({ ...bunny, region: e.target.value as BunnyRegion })}
                  className="h-9 rounded-md border border-zinc-500/30 bg-transparent px-3"
                >
                  {BUNNY_REGIONS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {choice === "own" && (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-zinc-500">
                  Provider
                  {keysUrl && (
                    <>
                      {" · "}
                      <a href={keysUrl} target="_blank" rel="noreferrer" className="underline">
                        get keys
                      </a>
                    </>
                  )}
                </span>
                <select
                  aria-label="Provider preset"
                  value=""
                  disabled={ownLocked}
                  onChange={(e) => pick(e.target.value)}
                  className="h-9 rounded-md border border-zinc-500/30 bg-transparent px-3"
                >
                  <option value="">Pick a provider…</option>
                  {S3_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              {field("endpoint", "Endpoint", endpointHint || "Empty for Amazon", ownLocked)}
              {field("bucket", "Bucket", "tiny-acrobatics-footage", ownLocked)}
              {field("region", "Region", "us-east-1")}
              <label className="flex items-center gap-2 self-end pb-2">
                <input type="checkbox" checked={form.pathStyle} onChange={(e) => setForm({ ...form, pathStyle: e.target.checked })} />
                Path-style URLs
              </label>
              {field("accessKey", "Access key", s?.keysSet ? "Saved: leave empty to keep" : "")}
              {field("secretKey", "Secret key", s?.keysSet ? "Saved: leave empty to keep" : "")}
            </div>
          )}
          {s && s.kind !== "local" && s.days.length > 0 && (
            <ul className="text-zinc-500">
              {s.days.slice(0, 7).map((d) => (
                <li key={d.day}>
                  {d.day}: {gb(d.storedBytes)}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3">
            {/* a library holding files keeps where they are: only an own bucket's keys and region can still change */}
            {!(s?.locked && choice !== "own") && (
              <Button size="sm" disabled={busy || !s} onClick={() => void save()}>
                {busy ? (choice === "bunny" ? "Setting up Bunny…" : "Checking the bucket…") : choice === "bunny" && s?.kind !== "bunny" ? "Set up" : "Save"}
              </Button>
            )}
            {error && <p className="text-red-400">{error}</p>}
          </div>
        </div>
        )}
        {!changeable && error && <p className="px-3 py-3 text-sm text-red-400 sm:px-4">{error}</p>}
        {children}
      </Card>
    </Section>
  );
}
