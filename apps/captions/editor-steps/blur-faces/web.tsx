import { useEffect, useRef, useState } from "react";
import { ScanFace } from "lucide-react";
import { AppBar, ToolIntro } from "@/components/AppBar";
import { dropZoneClass } from "@/components/DropZone";
import { Card, Row, Section, SettingsSelect, TextField, saveFailed } from "@/components/settings/ui";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  droppedOnMac,
  faceBlurChoose,
  faceBlurHere,
  faceBlurShow,
  faceBlurStart,
  faceBlurState,
  pathOnMac,
  type FaceBlurItem,
} from "@/lib/thisMac";
import { defineWebPlugin } from "../../src/lib/plugin";

const API = "/api/x/blur-faces";

/** plugin.ts Settings */
type Settings = { mode: "all" | "some"; who: string; look: "blur" | "mosaic" | "solid" };

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as T;
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
  const [settings, setSettings] = useState<Settings | null>(null);
  const [here, setHere] = useState<"ok" | "old" | "none" | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  // a pick that failed, by file: the Mac wrote nothing, and the page says why
  const [failed, setFailed] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    call<Settings>(`${API}/settings`).then(setSettings, (e: Error) => saveFailed(e.message));
    void faceBlurHere().then(setHere);
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

  // "Only some faces": the faces go to the person's AI, and its answer to the Mac
  const pick = async (job: string, item: FaceBlurItem) => {
    try {
      const { blur } = await call<{ blur: string[] }>(`${API}/pick`, "POST", {
        who: settings?.who ?? "",
        faces: (item.faces ?? []).map(({ id, picture, note }) => ({ id, picture, note })),
      });
      await faceBlurChoose(job, item.path, blur);
    } catch (e) {
      const why = (e as Error).message;
      setFailed((f) => ({ ...f, [item.path]: why }));
      await faceBlurChoose(job, item.path, [], why).catch(() => undefined);
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
              if (i.stage === "choosing" && !asked.current.has(key)) {
                asked.current.add(key);
                void pick(id, i);
              }
            }
            setJobs((js) => js.map((j) => (j.id === id ? { ...j, items, settled: items.every((i) => finished(i, failed)) } : j)));
          },
          () => setJobs((js) => js.map((j) => (j.id === id ? { ...j, settled: true } : j))),
        );
      }
    }, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pick reads the settings of the moment
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

  const choose = async (files: FileList | null) => {
    const paths = await Promise.all([...(files ?? [])].map((f) => pathOnMac(f)));
    if (paths.some((p) => !p)) return saveFailed("Choose the files with Choose files, in the Mac app's own window.");
    await start(paths as string[]);
  };

  const again = async (job: string, path: string, blur: string[]) => {
    setFailed((f) => Object.fromEntries(Object.entries(f).filter(([p]) => p !== path)));
    asked.current.add(`${job}\n${path}`);
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
          </Section>
        )}

        {here === "none" && <p className="text-sm text-muted-foreground">Face Blur runs in the Creator Toolset Mac app and iPhone app.</p>}
        {here === "old" && <p className="text-sm text-muted-foreground">This Mac app is older than Face Blur. Update it: Creator Toolset → Check for Updates.</p>}
        {here === "ok" && (
          <div className={dropZoneClass(dragging, "gap-3 py-10")}>
            <p className="text-base font-semibold">Drop photos and videos here</p>
            <p className="text-sm text-muted-foreground">The covered copy is saved beside each one. Nothing is uploaded.</p>
            <Button asChild>
              <label className="cursor-pointer">
                Choose files
                <input type="file" multiple accept="image/*,video/*" className="hidden" onChange={(e) => void choose(e.target.files)} />
              </label>
            </Button>
          </div>
        )}

        {jobs.some((j) => j.items.length) && (
          <Section title="Files">
            <Card>
              {jobs.flatMap((j) => j.items.map((i) => <ItemRow key={`${j.id}\n${i.path}`} item={i} error={failed[i.path]} onAgain={(blur) => void again(j.id, i.path, blur)} />))}
            </Card>
          </Section>
        )}
      </main>
    </div>
  );
}

function ItemRow({ item, error, onAgain }: { item: FaceBlurItem; error?: string; onAgain: (blur: string[]) => void }) {
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
        ? `${faces.length === 1 ? "1 face" : `${faces.length} faces`}, ${on.size} covered`
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
              <img src={`data:image/jpeg;base64,${f.picture}`} alt="" className="h-16 rounded-md object-cover" />
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
  tiles: [{ stage: "Make", to: "/blur-faces", icon: ScanFace, name: "Face Blur", desc: "Cover faces in photos and videos before you share them", gate: "blur-faces" }],
});
