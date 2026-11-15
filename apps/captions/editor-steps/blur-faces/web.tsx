import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ScanFace } from "lucide-react";
import { AppBar, ToolIntro } from "@/components/AppBar";
import { dropZoneClass } from "@/components/DropZone";
import { Card, Row, Section, SettingsSelect, TextField, saveFailed } from "@/components/settings/ui";
import { Button } from "@/components/ui/button";
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
  pathOnMac,
  type FaceBlurFace,
  type FaceBlurItem,
} from "@/lib/thisMac";
import { defineWebPlugin } from "../../src/lib/plugin";

const API = "/api/x/blur-faces";

/** plugin.ts Settings */
type Settings = { mode: "all" | "some"; who: string; look: "blur" | "mosaic" | "solid"; auto: boolean };
/** plugin.ts GET /auto */
type Auto = { can: boolean; why?: string; failed: { versionId: string; title: string; error: string }[] };

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

/** Faces, Which faces and Look: on the page and in Settings → Face Blur. */
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
        />
      )}
      <Row
        title="Look"
        control={
          <SettingsSelect
            label="Look"
            value={settings.look}
            onValueChange={(v) => void save({ ...settings, look: v as Settings["look"] })}
            options={[
              { value: "blur", label: "Blur" },
              { value: "mosaic", label: "Mosaic" },
              { value: "solid", label: "Solid" },
            ]}
          />
        }
      />
    </Card>
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
      const id = await faceBlurStart(paths, settings.mode, settings.look);
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
            <SettingsRows {...shared} />
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
