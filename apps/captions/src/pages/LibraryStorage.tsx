import { useEffect, useState, type ReactNode } from "react";
import { applyS3Preset, BUNNY_REGIONS, S3_PRESETS, type BunnyRegion, type LibraryStorage, type LibraryStorageInput, type S3PresetId } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, Section } from "@/components/settings/ui";
import { confirmDialog } from "@/lib/dialogs";
import { getLibraryStorage, setLibraryStorage } from "@/lib/library";
import { UPLOAD_LABEL } from "./library/UploadSelect";

/**
 * Where a library keeps its files, for its owner, in the library's settings (api/library/usage.ts): the server's disk,
 * the server's bucket, the library's own S3-compatible bucket (made when it doesn't exist yet), or Bunny Storage, set up
 * whole from one account key (the server makes the zones). Saved keys are never shown again. `onThisComputer`: the
 * server runs on the person's own computer, so its disk is called this Mac (or this computer). A library that holds
 * files keeps where they are: then there is no choice to make (an own bucket's keys and region can still change).
 * `children`: the card's rows that say where the files are (LibrarySettings SpaceRows), first, given what is saved.
 *
 * On this computer the first choice is the cloud copy, in the upload setting's words (./library/UploadSelect.tsx): off,
 * proxies only (one for every video, the originals stay here: allowed while the library holds files), or video files and
 * proxies; then which bucket.
 */

type Choice = "local" | "server" | "own" | "bunny";
type Cloud = "none" | "proxies" | "originals";

const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(n < 10e6 ? 1 : 0)} MB`);

/** What the person's own computer is called: this Mac in the Mac app or a Mac's browser, else this computer. */
export const thisComputer = () => (typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent) ? "this Mac" : "this computer");

/** A bucket by name, as the rows say it: "Bunny Storage (zone)", "the server's bucket", or the own bucket's name. */
export const storeName = (p: Pick<LibraryStorage, "kind" | "zone" | "mode" | "bucket">) =>
  p.kind === "bunny" ? `Bunny Storage (${p.zone})` : p.mode === "server" ? "the server's bucket" : (p.bucket ?? "the bucket");

export function LibraryStorageSettings({
  libraryId,
  onSaved,
  onThisComputer = false,
  children,
}: {
  libraryId: string;
  onSaved: (kind: LibraryStorage["kind"]) => void;
  onThisComputer?: boolean;
  children?: ReactNode | ((saved: LibraryStorage | null) => ReactNode);
}) {
  const [s, setS] = useState<LibraryStorage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<Choice>("local");
  const [cloud, setCloud] = useState<Cloud>("none");
  const [form, setForm] = useState({ endpoint: "", region: "", bucket: "", pathStyle: false, accessKey: "", secretKey: "" });
  /** The chosen preset's endpoint example, shown as the endpoint field's placeholder (never as its value). */
  const [endpointHint, setEndpointHint] = useState("");
  /** Where the chosen preset's provider makes keys. */
  const [keysUrl, setKeysUrl] = useState("");
  const [bunny, setBunny] = useState<{ apiKey: string; region: BunnyRegion }>({ apiKey: "", region: "DE" });

  const show = (v: LibraryStorage) => {
    setS(v);
    const p = v.proxies ?? v; // the bucket the proxies are in, else the library's own
    setCloud(v.proxies ? "proxies" : v.kind === "local" ? "none" : "originals");
    setChoice(p.kind === "local" || p.kind === "bunny" ? p.kind : (p.mode ?? "own"));
    setBunny((b) => ({ ...b, apiKey: "" }));
    setForm({ endpoint: p.endpoint ?? "", region: p.region ?? "", bucket: p.bucket ?? "", pathStyle: !!p.pathStyle, accessKey: "", secretKey: "" });
  };
  useEffect(() => {
    getLibraryStorage(libraryId).then(show, (e: Error) => setError(e.message));
  }, [libraryId]);

  const save = async () => {
    const proxies = onThisComputer && cloud === "proxies" ? { proxies: true } : {};
    const input: LibraryStorageInput =
      choice === "local" || (onThisComputer && cloud === "none")
        ? { kind: "local" }
        : choice === "bunny"
          ? { kind: "bunny", apiKey: bunny.apiKey.trim() || undefined, region: bunny.region, ...proxies }
          : choice === "server"
          ? { kind: "s3", mode: "server", ...proxies }
          : { kind: "s3", mode: "own", ...form, accessKey: form.accessKey || undefined, secretKey: form.secretKey || undefined, ...proxies };
    if (s?.proxies && input.kind === "local") {
      const ok = await confirmDialog({ title: "Remove the proxies from the cloud?", body: `Each is generated again on ${thisComputer()} when a clip needs one. Your own footage is not touched.`, ok: "Remove" });
      if (!ok) return;
    }
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

  // where the files are is said by the rows (children); here only the choice
  const disk = onThisComputer ? (thisComputer() === "this Mac" ? "This Mac" : "This computer") : "The server";
  // what can still change: everything, an own bucket's keys and region, what goes to the cloud while the originals are
  // here, or nothing
  const keepsHere = onThisComputer && s?.kind === "local";
  const changeable = !!s && (!s.locked || choice === "own" || keepsHere);
  // a library holding files keeps where its originals are; its proxies may go anywhere
  const fixed = !!s?.locked && cloud !== "proxies";
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
      <input type="radio" name={`storage-${libraryId}`} checked={choice === value} disabled={fixed} onChange={() => setChoice(value)} />
      {text}
    </label>
  );
  const cloudOption = (value: Cloud, text: string) => (
    <label className="flex items-center gap-2">
      <input
        type="radio"
        name={`cloud-${libraryId}`}
        checked={cloud === value}
        disabled={!!s?.locked && (value === "originals" ? s.kind === "local" : s.kind !== "local")}
        onChange={() => {
          setCloud(value);
          if (value !== "none" && choice === "local") setChoice(s?.serverBucket ? "server" : "bunny");
        }}
      />
      {text}
    </label>
  );
  const ownLocked = fixed; // a library with files keeps its bucket; only the keys and region can change
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
        {typeof children === "function" ? children(s) : children}
        {/* nothing until it is known what can change, so no choice shows and then goes */}
        {changeable && (
        <div className="flex flex-col gap-3 px-3 py-3 text-sm sm:px-4">
          {onThisComputer && (keepsHere || !s?.locked) && (
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <span className="text-zinc-500">{UPLOAD_LABEL}</span>
              {cloudOption("none", "Off")}
              {cloudOption("proxies", "Proxies only")}
              {cloudOption("originals", "Video files and proxies")}
            </div>
          )}
          {!fixed && (!onThisComputer || cloud !== "none") && (
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {!onThisComputer && option("local", disk)}
              {(s?.serverBucket || choice === "server") && option("server", "The server's bucket")}
              {option("bunny", "Bunny Storage")}
              {option("own", "Amazon S3 or Cloudflare R2")}
            </div>
          )}
          {choice === "bunny" && (onThisComputer ? cloud !== "none" : true) && (s?.proxies ?? s)?.kind !== "bunny" && (
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
          {choice === "own" && (!onThisComputer || cloud !== "none") && (
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
          {s && (s.kind !== "local" || s.proxies) && s.days.length > 0 && (
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
            {!(fixed && choice !== "own" && !keepsHere) && (
              <Button size="sm" disabled={busy || !s} onClick={() => void save()}>
                {busy
                  ? onThisComputer && cloud === "none"
                    ? "Saving…"
                    : choice === "bunny"
                      ? "Setting up Bunny…"
                      : "Checking the bucket…"
                  : choice === "bunny" && cloud !== "none" && (s?.proxies ?? s)?.kind !== "bunny"
                    ? "Set up"
                    : "Save"}
              </Button>
            )}
            {error && <p className="text-red-400">{error}</p>}
          </div>
        </div>
        )}
        {!changeable && error && <p className="px-3 py-3 text-sm text-red-400 sm:px-4">{error}</p>}
      </Card>
    </Section>
  );
}
