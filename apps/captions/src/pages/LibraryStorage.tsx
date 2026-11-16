import { useEffect, useState, type ReactNode } from "react";
import { applyS3Preset, BUNNY_REGIONS, S3_PRESETS, type BunnyRegion, type LibraryStorage, type LibraryStorageInput, type LibraryUpload, type S3PresetId } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, ErrorRow, Row, SecretField, Section, SettingsSelect } from "@/components/settings/ui";
import { confirmDialog } from "@/lib/dialogs";
import { getLibraryStorage, setLibraryStorage } from "@/lib/library";
import { UploadRow } from "./library/UploadSelect";

/**
 * Where a library keeps its files, for its owner, in the library's settings (api/library/usage.ts): the server's disk,
 * the server's bucket, the library's own S3-compatible bucket (made when it doesn't exist yet), or Bunny Storage, set up
 * whole from one account key (the server makes the zones). Saved keys are never shown again. `onThisComputer`: the
 * server runs on the person's own computer, so its disk is called this Mac (or this computer). A library that holds
 * files keeps where they are: then there is no choice to make (an own bucket's keys and region can still change).
 * `children`: the card's rows that say where the files are (LibrarySettings SpaceRows), first, given what is saved.
 *
 * Upload to the server is the section's first row on every install, the one control of ./library/UploadSelect.tsx. With
 * the server elsewhere it is the library's upload setting, saved at once (`upload`: that row). On this computer it is
 * the cloud copy: off, proxies only (one for every video, the originals stay here: allowed while the library holds
 * files), or video files and proxies; then which bucket, saved with Save.
 */

type Choice = "local" | "server" | "own" | "bunny";
/** The S3 form's own fields ("Other": no service picked, every field typed). */
const OTHER = "other";

/** What the person's own computer is called: this Mac in the Mac app or a Mac's browser, else this computer. */
export const thisComputer = () => (typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent) ? "this Mac" : "this computer");

/** A bucket by name, as the rows say it: "Bunny Storage (zone)", "the server's bucket", or the own bucket's name. */
export const storeName = (p: Pick<LibraryStorage, "kind" | "zone" | "mode" | "bucket">) =>
  p.kind === "bunny" ? `Bunny Storage (${p.zone})` : p.mode === "server" ? "the server's bucket" : (p.bucket ?? "the bucket");

export function LibraryStorageSettings({
  libraryId,
  onSaved,
  onThisComputer = false,
  upload,
  children,
}: {
  libraryId: string;
  onSaved: (kind: LibraryStorage["kind"]) => void;
  onThisComputer?: boolean;
  /** The library's Upload to the server row, with the server elsewhere (on this computer the row is the cloud copy). */
  upload?: ReactNode;
  children?: ReactNode | ((saved: LibraryStorage | null) => ReactNode);
}) {
  const [s, setS] = useState<LibraryStorage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<Choice>("local");
  // the cloud copy in the upload setting's words: "all" = the video files are in the bucket too
  const [cloud, setCloud] = useState<LibraryUpload>("none");
  const [form, setForm] = useState({ endpoint: "", region: "", bucket: "", pathStyle: false, accessKey: "", secretKey: "" });
  /** The chosen preset's endpoint example, shown as the endpoint field's placeholder (never as its value). */
  const [endpointHint, setEndpointHint] = useState("");
  /** Where the chosen service makes keys. */
  const [keysUrl, setKeysUrl] = useState("");
  const [preset, setPreset] = useState<string>(OTHER);
  const [bunny, setBunny] = useState<{ apiKey: string; region: BunnyRegion }>({ apiKey: "", region: "DE" });

  const show = (v: LibraryStorage) => {
    setS(v);
    const p = v.proxies ?? v; // the bucket the proxies are in, else the library's own
    setCloud(v.proxies ? "proxies" : v.kind === "local" ? "none" : "all");
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
      const ok = await confirmDialog({ title: "Delete the proxies in the bucket?", body: "The video files are not deleted.", ok: "Delete" });
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
  // so what its cloud copy cannot be switched to: originals here stay here, originals in a bucket stay there
  const off: LibraryUpload[] = s?.locked ? (s.kind === "local" ? ["all"] : ["none", "proxies"]) : [];
  const inCloud = !onThisComputer || cloud !== "none";
  const ownLocked = fixed; // a library with files keeps its bucket; only the keys and region can change
  const text = (key: "endpoint" | "region" | "bucket" | "accessKey", label: string, placeholder = "", locked = false) => (
    <Row
      title={label}
      control={<Input aria-label={label} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} placeholder={placeholder} disabled={locked} autoComplete="off" className="h-8 sm:w-72" />}
    />
  );
  const pick = (id: string) => {
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
        {typeof children === "function" ? children(s) : children}
        {!onThisComputer && upload}
        {/* nothing until it is known what can change, so no choice shows and then goes */}
        {changeable && onThisComputer && (keepsHere || !s?.locked) && (
          <UploadRow
            value={cloud}
            off={off}
            onChange={(value) => {
              setCloud(value);
              if (value !== "none" && choice === "local") setChoice(s?.serverBucket ? "server" : "bunny");
            }}
          />
        )}
        {changeable && !fixed && inCloud && (
          <Row
            title="Location"
            control={
              <SettingsSelect
                label="Location"
                value={choice}
                onValueChange={(v) => setChoice(v as Choice)}
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
        {changeable && choice === "bunny" && inCloud && (s?.proxies ?? s)?.kind !== "bunny" && (
          <>
            <Row
              title="Bunny API key"
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
        )}
        {changeable && choice === "own" && inCloud && (
          <>
            <Row
              title="Service"
              description={keysUrl ? link(keysUrl, "Get keys") : undefined}
              control={<SettingsSelect label="Service" value={preset} disabled={ownLocked} onValueChange={pick} options={[{ value: OTHER, label: "Other" }, ...S3_PRESETS.map((p) => ({ value: p.id, label: p.name }))]} />}
            />
            {text("endpoint", "Endpoint", endpointHint || "Empty for Amazon", ownLocked)}
            {text("bucket", "Bucket", "", ownLocked)}
            {text("region", "Region")}
            <Row title="Path-style URLs" control={<Switch aria-label="Path-style URLs" checked={form.pathStyle} onCheckedChange={(pathStyle) => setForm({ ...form, pathStyle })} />} />
            {text("accessKey", "Access key", s?.keysSet ? "Saved" : "")}
            <Row
              title="Secret key"
              control={
                <div className="w-full sm:w-72">
                  <SecretField label="Secret key" value={form.secretKey} onChange={(secretKey) => setForm({ ...form, secretKey })} placeholder={s?.keysSet ? "Saved" : ""} />
                </div>
              }
            />
          </>
        )}
        {error && <ErrorRow title={error} />}
        {/* a library holding files keeps where they are: only an own bucket's keys and region can still change */}
        {changeable && !(fixed && choice !== "own" && !keepsHere) && (
          <div className="flex justify-end px-3 py-3 sm:px-4">
            <Button size="sm" disabled={busy || !s} onClick={() => void save()}>
              {busy ? (onThisComputer && cloud === "none" ? "Saving…" : choice === "bunny" ? "Setting up Bunny…" : "Checking the bucket…") : "Save"}
            </Button>
          </div>
        )}
      </Card>
    </Section>
  );
}
