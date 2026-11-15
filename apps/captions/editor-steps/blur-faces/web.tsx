import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ScanFace } from "lucide-react";
import { AppBar, ToolIntro } from "@/components/AppBar";
import { dropZoneClass } from "@/components/DropZone";
import { Card, Row, Section, SettingsSelect, TextField, saveFailed } from "@/components/settings/ui";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  droppedOnMac,
  faceBlurChoose,
  faceBlurFaces,
  faceBlurHere,
  faceBlurPick,
  faceBlurShow,
  faceBlurStart,
  faceBlurState,
  faceBlurTry,
  faceBlurVersion,
  pathOnMac,
  type FaceBlurFace,
  type FaceBlurItem,
} from "@/lib/thisMac";
import { defineWebPlugin } from "../../src/lib/plugin";

const API = "/api/x/blur-faces";

/** plugin.ts Settings */
type Settings = {
  mode: "all" | "some";
  who: string;
  look: "blur" | "mosaic" | "solid";
  strength: number;
  softness: number;
  size: number;
  color: string;
  auto: boolean;
};
/** plugin.ts GET /auto */
type Auto = { can: boolean; why?: string; failed: { versionId: string; title: string; error: string }[] };
type Style = Pick<Settings, "look" | "strength" | "softness" | "size" | "color">;
const styleOf = ({ look, strength, softness, size, color }: Settings): Style => ({ look, strength, softness, size, color });

/** Instructions to start from: what can be seen, never who someone is */
const EXAMPLES = ["Every child's face", "The people in the background", "Everyone except the person speaking", "Every adult's face"];

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as T;
}

/** The account's Face Blur settings, read once, and a save that puts the old ones back when it fails. */
function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    call<Settings>(`${API}/settings`).then(setSettings, (e: Error) => saveFailed(e.message));
  }, []);
  const save = async (next: Settings) => {
    const prev = settings;
    setSettings(next);
    try {
      setSettings(await call<Settings>(`${API}/settings`, "PUT", next));
    } catch (e) {
      setSettings(prev);
      saveFailed((e as Error).message);
    }
  };
  return { settings, save };
}

/** What this Mac app's Face Blur can do (thisMac.ts faceBlurVersion): null in a browser, 0 an older app, 2 previews. */
function useMacVersion() {
  const [v, setV] = useState<number | null | undefined>(undefined);
  useEffect(() => void faceBlurVersion().then(setV), []);
  return v;
}

/** A file of the person's own (photo or video) the preview runs on, picked in the Mac app; kept while the app stays open. */
let own: { path: string; name: string } | null = null;
type Face = { id: string; picture: string; note: string };
/** The AI's pick for one file and one "Which faces", so a slider never asks it again. */
const picks = new Map<string, Promise<{ faces: Face[]; blur: string[] }>>();

/** The example picture (a base64 JPEG), read once. */
let example: Promise<string> | null = null;
const examplePicture = () => (example ??= call<{ picture: string }>(`${API}/example`).then((r) => r.picture));

/** Faces and Which faces: on the page and in Settings → Face Blur. */
function SettingsRows({ settings, save }: ReturnType<typeof useSettings>) {
  if (!settings) return null;
  return (
    <Card>
      <Row
        title="Faces"
        control={
          <SettingsSelect
            label="Faces"
            value={settings.mode}
            onValueChange={(v) => void save({ ...settings, mode: v as Settings["mode"] })}
            options={[
              { value: "all", label: "Every face" },
              { value: "some", label: "Only some faces" },
            ]}
          />
        }
      />
      {settings.mode === "some" && (
        <Row
          title="Which faces"
          description="Your AI looks at each face and picks the ones that match"
          control={<TextField label="Which faces" value={settings.who} maxLength={500} onCommit={(who) => save({ ...settings, who })} />}
        >
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((who) => (
              <Button key={who} size="sm" variant={settings.who === who ? "secondary" : "outline"} className="h-7 rounded-full text-xs" onClick={() => void save({ ...settings, who })}>
                {who}
              </Button>
            ))}
          </div>
        </Row>
      )}
    </Card>
  );
}

/** A 0…1 (or `min`…`max`) value as a slider; moves show at once (`onMove`), the value is saved when let go. */
function StyleSlider({ label, value, min = 0, max = 1, onMove, onCommit }: { label: string; value: number; min?: number; max?: number; onMove: (v: number) => void; onCommit: (v: number) => void }) {
  return (
    <Slider
      aria-label={label}
      className="w-32 sm:w-36"
      min={min}
      max={max}
      step={(max - min) / 100}
      value={[value]}
      onValueChange={([v]) => onMove(v!)}
      onValueCommit={([v]) => onCommit(v!)}
    />
  );
}

/**
 * The style: the look and the adjustments the Mac and iPhone draw with (strength, soft edge, size, Solid's colour), and the
 * example covered in it, drawn by the Mac app as the sliders move.
 */
function StyleCard({ settings, save }: ReturnType<typeof useSettings>) {
  // the style while a slider moves, before it is saved
  const [draft, setDraft] = useState<Style | null>(null);
  if (!settings) return null;
  const style = draft ?? styleOf(settings);
  const move = (change: Partial<Style>) => setDraft({ ...style, ...change });
  const commit = (change: Partial<Style>) => {
    setDraft(null);
    void save({ ...settings, ...change });
  };
  // Solid is hard-edged until someone softens it; the other looks start soft
  const lookTo = (look: Style["look"]) =>
    commit({ look, softness: look === "solid" ? 0 : settings.look === "solid" ? 0.45 : settings.softness });
  return (
    <Card>
      {/* the app's own two-pane classes (Settings → Providers): a plug-in folder can use only classes the app has */}
      <div className="lg:grid lg:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="p-3 lg:border-r lg:border-border/50">
          <Preview settings={settings} style={style} />
        </div>
        <div className="min-w-0 [&>*+*]:border-t [&>*+*]:border-border/50">
          <Row
            title="Look"
            control={
              <SettingsSelect
                label="Look"
                value={style.look}
                onValueChange={(v) => lookTo(v as Style["look"])}
                options={[
                  { value: "blur", label: "Blur" },
                  { value: "mosaic", label: "Mosaic" },
                  { value: "solid", label: "Solid" },
                ]}
              />
            }
          />
          {style.look === "solid" ? (
            <Row
              title="Colour"
              control={
                <input
                  type="color"
                  aria-label="Colour"
                  value={style.color}
                  onChange={(e) => move({ color: e.target.value })}
                  onBlur={(e) => e.target.value !== settings.color && commit({ color: e.target.value })}
                  className="h-8 w-14 cursor-pointer rounded-md border border-border bg-transparent"
                />
              }
            />
          ) : (
            <Row
              title={style.look === "blur" ? "Strength" : "Square size"}
              control={<StyleSlider label={style.look === "blur" ? "Strength" : "Square size"} value={style.strength} onMove={(strength) => move({ strength })} onCommit={(strength) => commit({ strength })} />}
            />
          )}
          <Row title="Soft edge" control={<StyleSlider label="Soft edge" value={style.softness} onMove={(softness) => move({ softness })} onCommit={(softness) => commit({ softness })} />} />
          <Row title="Size" description="How far past the face it reaches" control={<StyleSlider label="Size" value={style.size} min={0.8} max={2} onMove={(size) => move({ size })} onCommit={(size) => commit({ size })} />} />
        </div>
      </div>
    </Card>
  );
}

/**
 * The test: the example, or a photo or video of the person's own, covered by the Mac app with these settings, nothing saved.
 * With "Only some faces" the AI picks from the faces it finds, once per file and instruction; a new style only draws again.
 */
function Preview({ settings, style }: { settings: Settings; style: Style }) {
  const mac = useMacVersion();
  const [mine, setMine] = useState(own);
  const [shown, setShown] = useState<{ frames: string[]; faces: (Face & { covered: boolean })[] } | null>(null);
  const [moment, setMoment] = useState(0);
  const [ratio, setRatio] = useState("760 / 534");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const seq = useRef(0);
  const some = settings.mode === "some";
  const key = JSON.stringify([style, some && settings.who, mine?.path]);
  useEffect(() => {
    if (!mac || mac < 2) return;
    const n = ++seq.current;
    const live = () => n === seq.current;
    const t = setTimeout(async () => {
      try {
        const source = mine ? { path: mine.path } : { picture: await examplePicture() };
        let blur: string[] | undefined;
        let failed: string | null = null;
        if (some) {
          const at = `${mine?.path ?? "example"}\n${settings.who}`;
          let pick = picks.get(at);
          if (!pick) {
            setBusy("Your AI is choosing the faces");
            pick = (async () => {
              const faces = (await faceBlurTry(source, style, { facesOnly: true })).faces;
              return { faces, blur: faces.length ? (await call<{ blur: string[] }>(`${API}/pick`, "POST", { who: settings.who, faces })).blur : [] };
            })();
            picks.set(at, pick);
          }
          try {
            blur = (await pick).blur;
          } catch (e) {
            picks.delete(at);
            failed = (e as Error).message;
            blur = [];
          }
        }
        if (!live()) return;
        setBusy(null);
        const r = await faceBlurTry(source, style, blur ? { blur } : {});
        if (!live()) return;
        setShown({ frames: r.frames, faces: r.faces.map((f) => ({ ...f, covered: blur ? blur.includes(f.id) : true })) });
        setProblem(failed);
      } catch (e) {
        if (!live()) return;
        setBusy(null);
        setProblem((e as Error).message);
      }
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the style, the instruction and the file
  }, [key, mac]);
  const choose = (next: typeof own) => {
    own = next;
    setMine(next);
    setShown(null);
    setMoment(0);
    setProblem(null);
  };
  const pickFile = async () => {
    const path = (await faceBlurPick())?.[0];
    if (path) choose({ path, name: path.split("/").pop() ?? path });
  };
  if (mac === undefined) return null;
  if (mac === null) return <p className="text-xs text-muted-foreground">The example is drawn by the Creator Toolset Mac app</p>;
  if (mac < 2) return <p className="text-xs text-muted-foreground">Update the Mac app to see the example: Creator Toolset → Check for Updates</p>;
  const frame = shown?.frames[moment] ?? shown?.frames[0];
  const covered = shown?.faces.filter((f) => f.covered).length ?? 0;
  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-lg bg-muted" style={{ aspectRatio: ratio, maxHeight: "24rem" }}>
        {frame && (
          <img
            src={`data:image/jpeg;base64,${frame}`}
            alt={mine ? "Your file with its faces covered" : "The example with its faces covered"}
            className="h-full w-full object-contain"
            onLoad={(e) => setRatio(`${e.currentTarget.naturalWidth} / ${e.currentTarget.naturalHeight}`)}
          />
        )}
      </div>
      {shown && shown.frames.length > 1 && (
        <div className="flex gap-1.5">
          {shown.frames.map((f, i) => (
            <button key={i} type="button" aria-label={`Moment ${i + 1}`} onClick={() => setMoment(i)} className={`overflow-hidden rounded-md border ${i === moment ? "border-foreground" : "border-border"}`}>
              <img src={`data:image/jpeg;base64,${f}`} alt="" className="h-10 object-cover" />
            </button>
          ))}
        </div>
      )}
      {busy && <p className="text-xs text-muted-foreground">{busy}</p>}
      {problem && <p className="text-xs text-red-500">{problem}</p>}
      {shown && !busy && (
        <p className="text-xs text-muted-foreground">
          {shown.faces.length ? `${covered} of ${shown.faces.length} ${shown.faces.length === 1 ? "face" : "faces"} covered${some ? ", your AI's pick" : ""}` : "No face found"}
        </p>
      )}
      {shown && shown.faces.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {shown.faces.map((f) => (
            <div key={f.id} className="flex w-14 flex-col items-center gap-1 text-center" title={f.note}>
              <img src={`data:image/jpeg;base64,${f.picture}`} alt="" className="h-10 rounded-md object-cover" />
              <span className="text-[11px] leading-tight text-muted-foreground">{f.covered ? "Covered" : "Left"}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        {/* the example's credit is its licence: shown whole, never cut short */}
        <p className={`text-[11px] text-muted-foreground ${mine ? "min-w-0 truncate" : ""}`}>{mine ? mine.name : "Tears of Steel (CC BY 3.0) Blender Foundation"}</p>
        <Button size="sm" variant="ghost" onClick={() => void (mine ? choose(null) : pickFile())}>
          {mine ? "Back to the example" : "Try your own file"}
        </Button>
      </div>
    </div>
  );
}

/**
 * "New Media Library files": its switch where a Mac of this account can cover them (or while it is on, so it can be
 * switched off), else the line that says why not; and the files it could not cover, each with why and Try again.
 */
function AutoRows({ settings, save }: ReturnType<typeof useSettings>) {
  const [auto, setAuto] = useState<Auto | null>(null);
  const load = () => void call<Auto>(`${API}/auto`).then(setAuto, () => setAuto(null));
  useEffect(load, []);
  if (!settings || !auto) return null;
  const retry = (versionId: string) => call(`${API}/auto/retry`, "POST", { versionId }).then(load, (e: Error) => saveFailed(e.message));
  return (
    <Card>
      {auto.can || settings.auto ? (
        <Row
          title="New Media Library files"
          description="Each photo and video that comes into your Media Library is covered by your Mac with these settings, and the covered copy is added beside it"
          control={<Switch checked={settings.auto} onCheckedChange={(on) => void save({ ...settings, auto: on })} aria-label="New Media Library files" />}
        />
      ) : (
        <Row title="New Media Library files" description={auto.why} />
      )}
      {auto.failed.map((f) => (
        <Row
          key={f.versionId}
          title={f.title}
          description={f.error}
          control={
            <Button size="sm" variant="outline" onClick={() => void retry(f.versionId)}>
              Try again
            </Button>
          }
        />
      ))}
    </Card>
  );
}

function FaceBlurSettings() {
  const s = useSettings();
  return (
    <div className="space-y-4">
      <SettingsRows {...s} />
      <Section title="Style">
        <StyleCard {...s} />
      </Section>
      <AutoRows {...s} />
      <p className="text-sm text-muted-foreground">
        Faces in AI Editor edits are covered by the AI Editor's own Blur faces step:{" "}
        <Link to="/settings/tools/editor" className="underline underline-offset-2">
          Settings → Tools → AI Editor
        </Link>
      </p>
    </div>
  );
}

const STAGE: Record<FaceBlurItem["stage"], string> = {
  queued: "Waiting",
  scanning: "Finding faces",
  choosing: "Your AI is choosing the faces",
  writing: "Writing the copy",
  done: "Saved beside the original",
  failed: "Failed",
};

type Job = { id: string; items: FaceBlurItem[]; settled: boolean };
const finished = (i: FaceBlurItem, failed: Record<string, string>) => i.stage === "done" || i.stage === "failed" || !!failed[i.path];

function FaceBlurPage() {
  const shared = useSettings();
  const { settings } = shared;
  const [here, setHere] = useState<"ok" | "old" | "none" | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  // a pick that failed, by file: the Mac wrote nothing, and the page says why
  const [failed, setFailed] = useState<Record<string, string>>({});
  // each file's faces are read once, with their pictures (the state polled twice a second leaves them out)
  const asked = useRef(new Set<string>());
  const [pictures, setPictures] = useState<Record<string, Record<string, string>>>({});
  const [dragging, setDragging] = useState(false);

  useEffect(() => void faceBlurHere().then(setHere), []);

  // a file's face pictures, read once; in "Only some faces" (stage choosing) they go to the person's AI, and its
  // answer to the Mac
  const read = async (job: string, item: FaceBlurItem) => {
    const choosing = item.stage === "choosing";
    try {
      const faces = await faceBlurFaces(job, item.path);
      setPictures((p) => ({ ...p, [`${job}\n${item.path}`]: Object.fromEntries(faces.map((f) => [f.id, f.picture ?? ""])) }));
      if (choosing) await pick(job, item.path, faces);
    } catch (e) {
      if (choosing) await pickFailed(job, item.path, (e as Error).message);
    }
  };
  const pickFailed = async (job: string, path: string, why: string) => {
    setFailed((f) => ({ ...f, [path]: why }));
    await faceBlurChoose(job, path, [], why).catch(() => undefined);
  };
  const pick = async (job: string, path: string, faces: FaceBlurFace[]) => {
    try {
      const { blur } = await call<{ blur: string[] }>(`${API}/pick`, "POST", {
        who: settings?.who ?? "",
        faces: faces.map(({ id, picture, note }) => ({ id, picture, note })),
      });
      await faceBlurChoose(job, path, blur);
    } catch (e) {
      await pickFailed(job, path, (e as Error).message);
    }
  };

  const unsettled = jobs.filter((j) => !j.settled).map((j) => j.id).join(",");
  useEffect(() => {
    if (!unsettled) return;
    const t = setInterval(() => {
      for (const id of unsettled.split(",")) {
        faceBlurState(id).then(
          ({ items }) => {
            for (const i of items) {
              const key = `${id}\n${i.path}`;
              if (i.faces?.length && !asked.current.has(key)) {
                asked.current.add(key);
                void read(id, i);
              }
            }
            setJobs((js) => js.map((j) => (j.id === id ? { ...j, items, settled: items.every((i) => finished(i, failed)) } : j)));
          },
          () => setJobs((js) => js.map((j) => (j.id === id ? { ...j, settled: true } : j))),
        );
      }
    }, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read and pick use the settings of the moment
  }, [unsettled, failed]);

  const start = async (paths: string[]) => {
    if (!paths.length || !settings) return;
    try {
      const id = await faceBlurStart(paths, settings.mode, styleOf(settings));
      setJobs((js) => [{ id, items: [], settled: false }, ...js]);
    } catch (e) {
      saveFailed((e as Error).message);
    }
  };

  // the Mac app's own open panel (any server); a Mac app from before it could takes the file input's pick
  const input = useRef<HTMLInputElement>(null);
  const pickFiles = async () => {
    const paths = await faceBlurPick();
    if (paths === null) input.current?.click();
    else await start(paths);
  };

  const choose = async (files: FileList | null) => {
    const paths = await Promise.all([...(files ?? [])].map((f) => pathOnMac(f)));
    if (paths.some((p) => !p)) return saveFailed("Choose the files with Choose files, in the Mac app's own window.");
    await start(paths as string[]);
  };

  const again = async (job: string, path: string, blur: string[]) => {
    setFailed((f) => Object.fromEntries(Object.entries(f).filter(([p]) => p !== path)));
    try {
      await faceBlurChoose(job, path, blur);
      setJobs((js) => js.map((j) => (j.id === job ? { ...j, settled: false } : j)));
    } catch (e) {
      saveFailed((e as Error).message);
    }
  };

  return (
    <div
      className="flex min-h-dvh flex-col"
      onDragOver={(e) => {
        if (here !== "ok") return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        if (here !== "ok") return;
        e.preventDefault();
        setDragging(false);
        void droppedOnMac().then((d) => start((d ?? []).filter((x) => !x.folder).map((x) => x.path)));
      }}
    >
      <AppBar tool="Face Blur" />
      <main className="mx-auto w-full max-w-2xl space-y-6 px-4 pb-10">
        <ToolIntro icon={ScanFace} title="Face Blur" line="Covers faces in your photos and videos before you share them, on your own computer or phone" className="mb-0" />

        {settings && (
          <Section title="What to cover">
            <div className="space-y-4">
              <SettingsRows {...shared} />
              <StyleCard {...shared} />
            </div>
          </Section>
        )}

        {here === "none" && <p className="text-sm text-muted-foreground">Face Blur runs in the Creator Toolset Mac app and iPhone app.</p>}
        {here === "old" && <p className="text-sm text-muted-foreground">This Mac app is older than Face Blur. Update it: Creator Toolset → Check for Updates.</p>}
        {here === "ok" && (
          <div className={dropZoneClass(dragging, "gap-3 py-10")}>
            <p className="text-base font-semibold">Drop photos and videos here</p>
            <p className="text-sm text-muted-foreground">The covered copy is saved beside each one. Nothing is uploaded.</p>
            <Button onClick={() => void pickFiles()}>Choose files</Button>
            <input ref={input} type="file" multiple accept="image/*,video/*" className="hidden" onChange={(e) => void choose(e.target.files)} />
          </div>
        )}

        {jobs.some((j) => j.items.length) && (
          <Section title="Files">
            <Card>
              {jobs.flatMap((j) => j.items.map((i) => <ItemRow key={`${j.id}\n${i.path}`} item={i} pictures={pictures[`${j.id}\n${i.path}`]} error={failed[i.path]} onAgain={(blur) => void again(j.id, i.path, blur)} />))}
            </Card>
          </Section>
        )}
      </main>
    </div>
  );
}

function ItemRow({ item, pictures, error, onAgain }: { item: FaceBlurItem; pictures?: Record<string, string>; error?: string; onAgain: (blur: string[]) => void }) {
  const faces = item.faces ?? [];
  // the switches start from what the Mac covered, and again each time it writes the file anew
  const from = faces.filter((f) => f.blur).map((f) => f.id).join(",");
  const [on, setOn] = useState(() => new Set(from.split(",").filter(Boolean)));
  const [base, setBase] = useState(from);
  if (base !== from) {
    setBase(from);
    setOn(new Set(from.split(",").filter(Boolean)));
  }
  const stage = error ? "failed" : item.stage;
  const working = stage !== "done" && stage !== "failed";
  const changed = [...on].sort().join(",") !== [...from.split(",")].filter(Boolean).sort().join(",");
  const status =
    stage === "failed"
      ? (error ?? item.error ?? STAGE.failed)
      : stage === "done"
        ? (item.note ?? `${faces.length === 1 ? "1 face" : `${faces.length} faces`}, ${on.size} covered`)
        : `${STAGE[stage]}${item.progress > 0 ? ` ${Math.round(item.progress * 100)}%` : ""}`;
  return (
    <Row
      title={<span className="block truncate">{item.name}</span>}
      status={<span className={stage === "failed" ? "text-red-500" : undefined}>{status}</span>}
      control={
        stage === "done" && (
          <>
            {changed && (
              <Button size="sm" onClick={() => onAgain([...on])}>
                Blur again
              </Button>
            )}
            {item.out && (
              <Button size="sm" variant="outline" onClick={() => void faceBlurShow(item.out!).catch((e: Error) => saveFailed(e.message))}>
                Show in Finder
              </Button>
            )}
          </>
        )
      }
    >
      {working && item.progress > 0 && (
        <div className="h-1 overflow-hidden rounded bg-muted">
          <div className="h-full bg-violet-600 transition-all" style={{ width: `${Math.round(item.progress * 100)}%` }} />
        </div>
      )}
      {stage === "done" && faces.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {faces.map((f) => (
            <label key={f.id} className="flex flex-col items-center gap-1.5" title={f.note}>
              {pictures?.[f.id] ? (
                <img src={`data:image/jpeg;base64,${pictures[f.id]}`} alt="" className="h-16 rounded-md object-cover" />
              ) : (
                <div className="h-16 w-16 rounded-md bg-muted" />
              )}
              <Switch
                aria-label={`Cover ${f.note}`}
                checked={on.has(f.id)}
                onCheckedChange={(c) => setOn((s) => (c ? new Set([...s, f.id]) : new Set([...s].filter((x) => x !== f.id))))}
              />
            </label>
          ))}
        </div>
      )}
    </Row>
  );
}

export default defineWebPlugin({
  id: "blur-faces",
  name: "Face Blur",
  about: "Covers every face, or only the ones you name, in your photos and videos, on your Mac and iPhone",
  routes: [{ path: "/blur-faces", element: <FaceBlurPage /> }],
  settings: [{ id: "blur-faces", title: "Face Blur", icon: ScanFace, body: <FaceBlurSettings /> }],
  tiles: [{ stage: "Make", to: "/blur-faces", icon: ScanFace, name: "Face Blur", desc: "Cover faces in photos and videos before you share them", gate: "blur-faces" }],
});
