import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import { applyS3Preset, S3_PRESETS, type LibraryStorage, type LibraryStorageInput, type S3PresetId } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getLibraryStorage, setLibraryStorage } from "@/lib/library";

/**
 * Where a library keeps its files, for its owner (api/library/usage.ts): this server's disk, the server's bucket, or
 * the library's own S3-compatible bucket. A bucket library shows what it holds. Saved keys are never shown again.
 */

type Choice = "local" | "server" | "own";

const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(n < 10e6 ? 1 : 0)} MB`);

export function LibraryStorageSettings({ libraryId, onSaved }: { libraryId: string; onSaved: (kind: LibraryStorage["kind"]) => void }) {
  const [s, setS] = useState<LibraryStorage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<Choice>("local");
  const [form, setForm] = useState({ endpoint: "", region: "", bucket: "", pathStyle: false, accessKey: "", secretKey: "" });
  /** The chosen preset's endpoint example, shown as the endpoint field's placeholder (never as its value). */
  const [endpointHint, setEndpointHint] = useState("");

  const show = (v: LibraryStorage) => {
    setS(v);
    setChoice(v.kind === "local" ? "local" : (v.mode ?? "own"));
    setForm({ endpoint: v.endpoint ?? "", region: v.region ?? "", bucket: v.bucket ?? "", pathStyle: !!v.pathStyle, accessKey: "", secretKey: "" });
  };
  useEffect(() => {
    getLibraryStorage(libraryId).then(show, (e: Error) => setError(e.message));
  }, [libraryId]);

  const save = async () => {
    const input: LibraryStorageInput =
      choice === "local"
        ? { kind: "local" }
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

  const where = !s ? "Storage" : s.kind === "local" ? "Stored on this server's disk" : `Stored in ${s.mode === "server" ? "the server's bucket" : s.bucket} · ${gb(s.storedBytes ?? 0)}`;
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
    setEndpointHint(S3_PRESETS.find((p) => p.id === id)?.endpointHint ?? "");
  };

  return (
    <details className="rounded-xl border border-zinc-500/20 p-3 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 text-zinc-400">
        <HardDrive className="h-4 w-4" />
        {where}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {s?.locked && <p className="text-zinc-500">This library holds files, so where they live stays as it is. A new library can use other storage.</p>}
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {option("local", "This server's disk")}
          {(s?.serverBucket || choice === "server") && option("server", "The server's bucket")}
          {option("own", "Your own S3-compatible bucket")}
        </div>
        {choice === "own" && (
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-zinc-500">Provider preset</span>
              <select
                aria-label="Provider preset"
                value=""
                disabled={ownLocked}
                onChange={(e) => pick(e.target.value)}
                className="h-9 rounded-md border border-zinc-500/30 bg-transparent px-3"
              >
                <option value="">Fill in the endpoint for a provider…</option>
                {S3_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {field("endpoint", "Endpoint", endpointHint || "https://s3.example.com (empty: AWS)", ownLocked)}
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
        {s && s.kind === "s3" && s.days.length > 0 && (
          <ul className="text-zinc-500">
            {s.days.slice(0, 7).map((d) => (
              <li key={d.day}>
                {d.day}: {gb(d.storedBytes)}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={busy || !s} onClick={() => void save()}>
            {busy ? "Checking the bucket…" : "Save"}
          </Button>
          {error && <p className="text-red-400">{error}</p>}
        </div>
      </div>
    </details>
  );
}
