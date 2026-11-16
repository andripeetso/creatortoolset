import { useEffect, useState, type ReactNode } from "react";
import { applyS3Preset, BUNNY_REGIONS, S3_PRESETS, type BunnyRegion, type LibraryStorage, type LibraryStorageInput, type LibraryUpload, type S3PresetId } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, ErrorRow, Row, SecretField, Section, SettingsSelect, Status, saveFailed } from "@/components/settings/ui";
import { confirmDialog } from "@/lib/dialogs";
import { getLibraryStorage, setLibraryStorage } from "@/lib/library";
import { UploadRow } from "./library/UploadSelect";

/**
 * Where a library keeps its files, for its owner, in the library's settings (api/library/usage.ts): the server's disk,
 * the server's bucket, the library's own S3-compatible bucket (made when it doesn't exist yet), or Bunny Storage, set up
 * whole from one account key (the server makes the zones). Saved keys are never shown again. `onThisComputer`: the
 * server runs on the person's own computer, so its disk is called this Mac (or this computer). A library that holds
 * files keeps where they are: then there is no choice to make (an own bucket's keys and region can still change).
 * `children`: the card's rows that say what the library's own files take (LibrarySettings SpaceRows), first, given
 * what is saved and whether the Upload row is drawn.
 *
 * Upload to the server is the one control of ./library/UploadSelect.tsx. With the server elsewhere it is the library's
 * upload setting (`upload`: that row). On this computer it is the cloud copy: off, proxies only (one for every video,
 * the originals stay here: allowed while the library holds files), or video files and proxies; then which bucket.
 * `videos`: what that row says of the video files in place of its own sentence (how many are where).
 *
 * Two cards, never mixed. The first holds the rows that save when picked: a choice that needs nothing typed (off, this
 * disk, the server's bucket, a bucket whose keys are saved) is saved at once, and a failed save puts the saved choice
 * back and says why in a toast. A bucket that needs its keys opens the second card: a form with one Save, never off or
 * hidden while the form shows; pressed with something missing it names it in that row (no row grows for it, so Save
 * stays where it is). Inside the form an on/off choice is a checkbox.
 */

type Choice = "local" | "server" | "own" | "bunny";
/** The S3 form's own fields ("Other": no service picked, every field typed). */
const OTHER = "other";

/** What the person's own computer is called: this Mac in the Mac app or a Mac's browser, else this computer. */
export const thisComputer = () => (typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent) ? "this Mac" : "this computer");

/** A bucket by name, as the rows say it: "Bunny Storage (zone)", "the server's bucket", or the own bucket's name. */
export const storeName = (p: Pick<LibraryStorage, "kind" | "zone" | "mode" | "bucket">) =>
  p.kind === "bunny" ? `Bunny Storage (${p.zone})` : p.mode === "server" ? "the server's bucket" : (p.bucket ?? "the bucket");

/** What is picked: what goes to the cloud (on this computer), and which bucket. */
interface Picked {
  choice: Choice;
  cloud: LibraryUpload;
}

/** A saved storage as the two choices on screen. */
const pickedOf = (v: LibraryStorage): Picked => {
  const p = v.proxies ?? v; // the bucket the proxies are in, else the library's own
  // the cloud copy in the upload setting's words: "all" = the video files are in the bucket too
  return { cloud: v.proxies ? "proxies" : v.kind === "local" ? "none" : "all", choice: p.kind === "local" || p.kind === "bunny" ? p.kind : (p.mode ?? "own") };
};

export function LibraryStorageSettings({
  libraryId,
  onSaved,
  onThisComputer = false,
  upload,
  videos,
  children,
}: {
  libraryId: string;
  onSaved: (kind: LibraryStorage["kind"]) => void;
  onThisComputer?: boolean;
  /** The library's Upload to the server row, with the server elsewhere (on this computer the row is the cloud copy). */
  upload?: (description: string | undefined) => ReactNode;
  /** What the Upload row says of the video files in place of its own sentence; nothing = its own sentence. */
  videos?: (saved: LibraryStorage) => string | undefined;
  /** `uploadRow`: the Upload row is drawn, so where the video files are is said there. */
  children?: ReactNode | ((saved: LibraryStorage | null, uploadRow: boolean) => ReactNode);
}) {
  const [s, setS] = useState<LibraryStorage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The form's failed save. */
  const [error, setError] = useState<string | null>(null);
  /** A save on its way: a row's, or the form's. */
  const [busy, setBusy] = useState<"pick" | "form" | null>(null);
  const [{ choice, cloud }, setPicked] = useState<Picked>({ choice: "local", cloud: "none" });
  const [form, setForm] = useState({ endpoint: "", region: "", bucket: "", pathStyle: false, accessKey: "", secretKey: "" });
  /** Save was pressed with something missing: the rows that lack a value say so until they have one. */
  const [asked, setAsked] = useState(false);
  /** The chosen preset's endpoint example, shown as the endpoint field's placeholder (never as its value). */
  const [endpointHint, setEndpointHint] = useState("");
  /** Where the chosen service makes keys. */
  const [keysUrl, setKeysUrl] = useState("");
  const [preset, setPreset] = useState<string>(OTHER);
  const [bunny, setBunny] = useState<{ apiKey: string; region: BunnyRegion }>({ apiKey: "", region: "DE" });

  const show = (v: LibraryStorage) => {
    setS(v);
    setPicked(pickedOf(v));
    const p = v.proxies ?? v;
    setBunny((b) => ({ ...b, apiKey: "" }));
    setForm({ endpoint: p.endpoint ?? "", region: p.region ?? "", bucket: p.bucket ?? "", pathStyle: !!p.pathStyle, accessKey: "", secretKey: "" });
    setError(null);
    setAsked(false);
  };
  useEffect(() => {
    getLibraryStorage(libraryId).then(show, (e: Error) => setLoadError(e.message));
  }, [libraryId]);

  // the bucket in use: the proxies', else the library's own
  const bucket = s?.proxies ?? s;
  const keysSaved = bucket?.mode === "own" && bucket.keysSet;
  // a bucket that is set up needs nothing typed: Bunny once its zones are made, an own one once its keys are saved
  const ready = (c: Choice) => c === "local" || c === "server" || (c === "bunny" ? bucket?.kind === "bunny" : !!keysSaved);

  const inputOf = (to: Picked): LibraryStorageInput => {
    const proxies = onThisComputer && to.cloud === "proxies" ? { proxies: true } : {};
    return to.choice === "local" || (onThisComputer && to.cloud === "none")
      ? { kind: "local" }
      : to.choice === "bunny"
        ? { kind: "bunny", apiKey: bunny.apiKey.trim() || undefined, region: bunny.region, ...proxies }
        : to.choice === "server"
          ? { kind: "s3", mode: "server", ...proxies }
          : { kind: "s3", mode: "own", ...form, accessKey: form.accessKey || undefined, secretKey: form.secretKey || undefined, ...proxies };
  };

  const save = async (to: Picked, from: "pick" | "form") => {
    const input = inputOf(to);
    if (s?.proxies && input.kind === "local") {
      const ok = await confirmDialog({ title: "Delete the proxies in the bucket?", body: "The video files are not deleted.", ok: "Delete" });
      if (!ok) return setPicked(pickedOf(s));
    }
    setBusy(from);
    try {
      const v = await setLibraryStorage(libraryId, input);
      show(v);
      onSaved(v.kind);
    } catch (e) {
      const why = (e as Error).message;
      if (from === "form") setError(why);
      else {
        // the row shows the saved choice again
        if (s) setPicked(pickedOf(s));
        saveFailed(why);
      }
    } finally {
      setBusy(null);
    }
  };

  /** A row's choice: saved at once, unless its bucket still needs its keys (the form opens, and its Save saves both). */
  const pick = (to: Picked) => {
    setPicked(to);
    setError(null);
    setAsked(false);
    // back on what is saved: nothing to save
    if (!s || JSON.stringify(inputOf(to)) === JSON.stringify(inputOf(pickedOf(s)))) return;
    if (inputOf(to).kind === "local" || ready(to.choice)) void save(to, "pick");
  };

  /** What the form still lacks, by row. Keys that are saved may stay empty. */
  const lacks = (): string[] =>
    choice === "bunny"
      ? bunny.apiKey.trim() ? [] : ["bunnyKey"]
      : [...(form.bucket.trim() ? [] : ["bucket"]), ...(keysSaved || form.accessKey.trim() ? [] : ["accessKey"]), ...(keysSaved || form.secretKey.trim() ? [] : ["secretKey"])];
  const saveForm = () => {
    if (busy) return;
    setAsked(true);
    if (!lacks().length) void save({ choice, cloud }, "form");
  };
  const lacking = asked ? lacks() : [];
  /**
   * A form row's title, with what it lacks beside it (under it where the row is narrow). The words are always there,
   * unseen until they apply, so the row is as tall with them as without and Save stays where it is at any width.
   */
  const titled = (label: string, key: string, needs: string) => (
    <span className="flex flex-wrap items-baseline gap-x-2">
      {label}
      <span data-needs={key} className={lacking.includes(key) ? undefined : "invisible"}>
        <Status tone="broken">{needs}</Status>
      </span>
    </span>
  );

  // where the files are is said by the rows (children); here only the choice
  const disk = onThisComputer ? (thisComputer() === "this Mac" ? "This Mac" : "This computer") : "The server";
  // what can still change: everything, an own bucket's keys and region, what goes to the cloud while the originals are
  // here, or nothing
  const keepsHere = onThisComputer && s?.kind === "local";
  const changeable = !!s && (!s.locked || choice === "own" || keepsHere);
  // a library holding files keeps where its originals are; its proxies may go anywhere
  const fixed = !!s?.locked && cloud !== "proxies";
  // so what its cloud copy cannot be switched to: originals here stay here, originals in a bucket stay there
  const off: LibraryUpload[] = s?.locked ? (s.kind === "local" ? ["all"] : ["none", "proxies"]) : [];
  const inCloud = !onThisComputer || cloud !== "none";
  const ownLocked = fixed; // a library with files keeps its bucket; only the keys and region can change
  // nothing until it is known what can change, so no choice shows and then goes
  const uploadRow = onThisComputer ? changeable && (keepsHere || !s?.locked) : !!upload;
  const detail = s ? videos?.(s) : undefined;
  // the form: an own bucket's fields (its keys and region can always change), or Bunny's key until Bunny is set up
  const fields = changeable && inCloud ? (choice === "own" ? "own" : choice === "bunny" && bucket?.kind !== "bunny" ? "bunny" : null) : null;
  const text = (key: "endpoint" | "region" | "bucket" | "accessKey", label: string, placeholder = "", locked = false, needs = "") => (
    <Row
      title={titled(label, key, needs)}
      control={<Input aria-label={label} aria-invalid={lacking.includes(key) || undefined} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} placeholder={placeholder} disabled={locked} autoComplete="off" className="h-8 sm:w-72" />}
    />
  );
  const service = (id: string) => {
    setPreset(id);
    const p = S3_PRESETS.find((x) => x.id === id);
    if (p) setForm((f) => applyS3Preset(f, id as S3PresetId));
    setEndpointHint(p?.endpointHint ?? "");
    setKeysUrl(p?.keysUrl ?? "");
  };
  const link = (href: string, words: string) => (
    <a href={href} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
      {words}
    </a>
  );

  return (
    <Section title="Storage">
      <Card>
        {typeof children === "function" ? children(s, uploadRow) : children}
        {loadError && <ErrorRow title={loadError} />}
        {!onThisComputer && upload?.(detail)}
        {uploadRow && onThisComputer && (
          <UploadRow
            value={cloud}
            off={off}
            disabled={!!busy}
            description={detail}
            onChange={(value) => pick({ cloud: value, choice: value !== "none" && choice === "local" ? (s?.serverBucket ? "server" : "bunny") : choice })}
          />
        )}
        {changeable && !fixed && inCloud && (
          <Row
            title="Location"
            control={
              <SettingsSelect
                label="Location"
                value={choice}
                disabled={!!busy}
                onValueChange={(v) => pick({ cloud, choice: v as Choice })}
                options={[
                  ...(!onThisComputer ? [{ value: "local", label: disk }] : []),
                  ...(s?.serverBucket || choice === "server" ? [{ value: "server", label: "The server's bucket" }] : []),
                  { value: "bunny", label: "Bunny Storage" },
                  { value: "own", label: "Amazon S3 or Cloudflare R2" },
                ]}
              />
            }
          />
        )}
      </Card>
      {fields && (
        <>
          <Card>
            {fields === "bunny" ? (
              <>
                <Row
                  title={titled("Bunny API key", "bunnyKey", "Needs a Bunny API key")}
                  description={link("https://dash.bunny.net/account/api-key", "Get a key")}
                  control={
                    <div className="w-full sm:w-72">
                      <SecretField label="Bunny API key" value={bunny.apiKey} onChange={(apiKey) => setBunny({ ...bunny, apiKey })} />
                    </div>
                  }
                />
                <Row
                  title="Region"
                  control={<SettingsSelect label="Bunny region" value={bunny.region} onValueChange={(region) => setBunny({ ...bunny, region: region as BunnyRegion })} options={BUNNY_REGIONS.map((r) => ({ value: r.id, label: r.name }))} />}
                />
              </>
            ) : (
              <>
                <Row
                  title="Service"
                  description={keysUrl ? link(keysUrl, "Get keys") : undefined}
                  control={<SettingsSelect label="Service" value={preset} disabled={ownLocked} onValueChange={service} options={[{ value: OTHER, label: "Other" }, ...S3_PRESETS.map((p) => ({ value: p.id, label: p.name }))]} />}
                />
                {text("endpoint", "Endpoint", endpointHint || "Empty for Amazon", ownLocked)}
                {text("bucket", "Bucket", "", ownLocked, "Needs a bucket")}
                {text("region", "Region")}
                <Row title="Path-style URLs" control={<Checkbox aria-label="Path-style URLs" checked={form.pathStyle} onCheckedChange={(on) => setForm({ ...form, pathStyle: on === true })} />} />
                {text("accessKey", "Access key", keysSaved ? "Saved" : "", false, "Needs an access key")}
                <Row
                  title={titled("Secret key", "secretKey", "Needs a secret key")}
                  control={
                    <div className="w-full sm:w-72">
                      <SecretField label="Secret key" value={form.secretKey} onChange={(secretKey) => setForm({ ...form, secretKey })} placeholder={keysSaved ? "Saved" : ""} />
                    </div>
                  }
                />
              </>
            )}
          </Card>
          {/* Save is never off or hidden while the form shows; a failed save is said beside it, and it stays where it is */}
          <div className="flex items-start justify-end gap-4">
            {error && (
              <p role="alert" className="min-w-0 flex-1 px-0.5 pt-2 text-xs text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <Button size="sm" aria-busy={busy === "form"} onClick={saveForm}>
              {busy === "form" ? (fields === "bunny" ? "Setting up Bunny…" : "Checking the bucket…") : "Save"}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}
