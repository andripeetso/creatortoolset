import { useEffect, useRef, useState } from "react";
import type { CameraLut } from "@contracts/camera";
import { Button } from "@/components/ui/button";
import { addLut, deleteLut, listLuts, renameLut } from "@/lib/editor";
import { RowMenu, saveFailed, TextField } from "./ui";

/**
 * The LUTs added under Colour (api/editor/luts.ts): one row each, its name to change and ⋯ → Delete, and Add LUT for a
 * .cube file. The workspace's library: the Editor offers them for a clip; nothing here applies one.
 */
export function CameraLuts() {
  const [luts, setLuts] = useState<CameraLut[] | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  useEffect(() => void listLuts().then(setLuts, () => setLuts([])), []);
  const add = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      setLuts(await addLut(file));
    } catch (e) {
      saveFailed(`Could not add ${file.name}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (pick.current) pick.current.value = "";
    }
  };
  return (
    <div className="flex flex-col gap-1.5 py-1 text-sm">
      <span className="text-muted-foreground">LUTs</span>
      {luts?.map((l) => (
        <div key={l.id} className="flex items-center gap-2">
          <TextField label={`Name of ${l.name}`} value={l.name} className="w-full sm:w-80" onCommit={async (v) => setLuts(await renameLut(l.id, v))} />
          <span className="shrink-0 text-xs text-muted-foreground">{l.size}-point</span>
          <RowMenu
            label={`More for ${l.name}`}
            items={[{ label: "Delete", destructive: true, confirm: { title: `Delete ${l.name}?`, body: "Its file is deleted from this workspace.", ok: "Delete" }, onSelect: async () => setLuts(await deleteLut(l.id)) }]}
          />
        </div>
      ))}
      <div>
        <input ref={pick} type="file" accept=".cube" hidden onChange={(e) => void add(e.target.files?.[0])} />
        <Button size="sm" variant="outline" disabled={busy || !luts} onClick={() => pick.current?.click()}>
          Add LUT
        </Button>
      </div>
    </div>
  );
}
