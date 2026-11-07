import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { PACK_LIMITS, PACK_SLOTS, instructionProblems, type Pack, type PackSlot } from "@contracts/packs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Loading, Notice } from "./ui";
import { msg, selectCls } from "./helpers";
import { ContentsView } from "./PacksShared";
import { LICENCES, USED_SLOTS, slugify } from "./packs-helpers";
import { ApiError, exportPack, listOwnFrameworks, listOwnPresets } from "./packs-api";

/** Share as pack: pick your own items, write the instructions per place, check, then download the file. */
export function PacksShare() {
  const me = useAuth((s) => s.me);
  const [own, setOwn] = useState<{ frameworks: Array<{ id: string; name: string }>; presets: Array<{ id: string; name: string; kind?: string }> } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [description, setDescription] = useState("");
  const [license, setLicense] = useState<(typeof LICENCES)[number]>("CC-BY-4.0");
  const [licenceOther, setLicenceOther] = useState("");
  const [niche, setNiche] = useState("");
  const [frameworks, setFrameworks] = useState<Set<string>>(new Set());
  const [presets, setPresets] = useState<Set<string>>(new Set());
  const [instructions, setInstructions] = useState<Partial<Record<PackSlot, string>>>({});

  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<Pack | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([listOwnFrameworks(), listOwnPresets()])
      .then(([fw, pr]) => {
        if (!live) return;
        setOwn({
          frameworks: fw.filter((f) => f.owner === me?.username),
          presets: pr.filter((p) => p.owner === me?.username && p.scope !== "global"),
        });
      })
      .catch((e) => live && setLoadError(msg(e)));
    return () => {
      live = false;
    };
  }, [me?.username]);

  const toggle = (set: Set<string>, value: string, put: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    put(next);
  };

  const build = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblems([]);
    setError(null);
    setBuilt(null);
    try {
      const r = await exportPack({
        id: id || slugify(name),
        name,
        version,
        description,
        license: license === "Other" ? licenceOther : license,
        niche: niche || undefined,
        frameworks: [...frameworks],
        presets: [...presets],
        instructions,
      });
      setBuilt(r.pack);
    } catch (err) {
      const list = err instanceof ApiError && Array.isArray(err.body.problems) ? (err.body.problems as string[]) : null;
      if (list) setProblems(list);
      else setError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!built) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(built, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${built.id}.ctpack.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (!own) return <Loading />;

  return (
    <div className="space-y-6">
      <form onSubmit={build} className="space-y-6">
        <section className="space-y-3">
          <h4 className="text-sm font-medium text-foreground">About the pack</h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
            </Field>
            <Field label="Id" hint="Lowercase letters, digits and dashes. Filled from the name if empty.">
              <Input value={id} onChange={(e) => setId(e.target.value)} placeholder={slugify(name) || "my-pack"} maxLength={48} />
            </Field>
            <Field label="Version" hint="x.y.z, like 1.0.0">
              <Input value={version} onChange={(e) => setVersion(e.target.value)} required />
            </Field>
            <Field label="Licence">
              <div className="flex gap-2">
                <select value={license} onChange={(e) => setLicense(e.target.value as (typeof LICENCES)[number])} className={selectCls} aria-label="Licence">
                  {LICENCES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                {license === "Other" && <Input value={licenceOther} onChange={(e) => setLicenceOther(e.target.value)} placeholder="Licence name" className="min-w-0 flex-1" />}
              </div>
            </Field>
            <Field label="Niche" hint="Optional: who it's for, like fitness or B2B.">
              <Input value={niche} onChange={(e) => setNiche(e.target.value)} maxLength={40} />
            </Field>
          </div>
          <Field label="Description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} rows={2} required />
            <span className="text-[11px] text-muted-foreground">{description.length} / 300</span>
          </Field>
        </section>

        <PickSection title="Frameworks" count={own.frameworks.length} empty="No frameworks of your own yet. Make one in the Workshop.">
          {own.frameworks.map((f) => (
            <PickBox key={f.id} label={f.name} checked={frameworks.has(f.id)} onChange={() => toggle(frameworks, f.id, setFrameworks)} />
          ))}
        </PickSection>

        <PickSection title="Caption styles" count={own.presets.length} empty="No caption styles of your own yet.">
          {own.presets.map((p) => (
            <PickBox key={p.id} label={`${p.name}${p.kind ? ` (${p.kind})` : ""}`} checked={presets.has(p.id)} onChange={() => toggle(presets, p.id, setPresets)} />
          ))}
        </PickSection>

        <section className="space-y-3">
          <h4 className="text-sm font-medium text-foreground">Instructions</h4>
          <p className="text-xs text-muted-foreground">
            Added on top of the app&apos;s own prompt at each place you pick. Leave a place empty to skip it. No links, and nothing that tells the AI to ignore its rules.
          </p>
          {USED_SLOTS.map((slot) => {
            const text = instructions[slot] ?? "";
            const issues = text.trim() ? instructionProblems(text) : [];
            const over = text.length > PACK_LIMITS.instructionChars;
            return (
              <Field key={slot} label={PACK_SLOTS[slot]}>
                <Textarea
                  value={text}
                  onChange={(e) => setInstructions({ ...instructions, [slot]: e.target.value })}
                  rows={3}
                  aria-label={PACK_SLOTS[slot]}
                />
                <div className="flex flex-wrap justify-between gap-x-3 text-[11px]">
                  <span className={cn("text-muted-foreground", over && "text-red-600 dark:text-red-300")}>
                    {text.length} / {PACK_LIMITS.instructionChars}
                  </span>
                  {issues.length > 0 && <span className="text-red-600 dark:text-red-300">{issues.join("; ")}</span>}
                </div>
              </Field>
            );
          })}
        </section>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Checking…" : "Check and build the pack"}
          </Button>
        </div>
      </form>

      {problems.length > 0 && (
        <div className="rounded-md bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">
          <div className="font-medium">Not ready to share yet:</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      {built && (
        <section className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-medium text-foreground">{built.name}</span>
            <span className="text-xs text-muted-foreground">v{built.version}</span>
          </div>
          <ContentsView pack={built} />
          <Button size="sm" variant="outline" onClick={download}>
            Download .ctpack.json
          </Button>
        </section>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
      <div className="space-y-1">{children}</div>
    </label>
  );
}

function PickSection({ title, empty, count, children }: { title: string; empty: string; count: number; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      {count ? <div className="flex flex-col gap-1.5">{children}</div> : <p className="text-xs text-muted-foreground">{empty}</p>}
    </section>
  );
}

function PickBox({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <input type="checkbox" checked={checked} onChange={onChange} className="h-4 w-4 accent-violet-600" />
      <span className="min-w-0 truncate">{label}</span>
    </label>
  );
}
