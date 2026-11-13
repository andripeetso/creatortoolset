import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { ANIMATION_BRIEF_MAX, STYLE_NAME_MAX, type AnimationStyle, type StylePicture } from "@contracts/editor-styles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { RowMenu } from "@/components/settings/ui";
import { addStylePictures, createAnimationStyle, deleteAnimationStyle, listAnimationStyles, removeStylePicture, stylePictureUrl, updateAnimationStyle } from "@/lib/editor";
import { cn } from "@/lib/utils";

/**
 * The AI Editor's Animation styles tab: the person's styles as cards, and the sheet one is made and changed in. A style
 * is a name, a brief in their own words and pictures: the ones they add (inspirations) and stills of cards they liked
 * on an edit (made). `open` is the style in the sheet, "new" for a new one; the page owns it, so its own
 * "New animation style" button opens the same sheet. `onChat`: an AI answers in the assistant, so a first style is set
 * up by talking to it (the empty tab's button), with the form one quiet button away.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type OpenAnimation = AnimationStyle | "new" | null;

export function AnimationStyles({ styles, open, onOpen, onChanged, onChat }: { styles: AnimationStyle[]; open: OpenAnimation; onOpen: (s: OpenAnimation) => void; onChanged: () => Promise<unknown>; onChat?: () => void }) {
  return (
    <>
      {styles.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16">
          <Button size="sm" onClick={onChat ?? (() => onOpen("new"))}>
            <Plus className="h-4 w-4" />
            New animation style
          </Button>
          {onChat && (
            <Button size="sm" variant="ghost" className="text-zinc-500" onClick={() => onOpen("new")}>
              Use a form
            </Button>
          )}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {styles.map((s) => (
            <li key={s.id} className="relative">
              <button
                type="button"
                onClick={() => onOpen(s)}
                className="flex h-full w-full flex-col gap-1.5 rounded-xl border border-zinc-500/20 p-3.5 text-left transition-colors hover:border-violet-500/60"
              >
                <span className="w-full truncate pr-8 text-sm font-medium">{s.name}</span>
                {s.brief && <span className="line-clamp-2 whitespace-pre-line text-xs text-zinc-500">{s.brief}</span>}
                {s.pictures.length > 0 && (
                  <span className="mt-1 flex gap-1.5">
                    {s.pictures.slice(-4).map((p) => (
                      <img key={p.id} src={stylePictureUrl(s.id, p.id)} alt="" className="h-14 w-14 rounded-md bg-zinc-800 object-cover" />
                    ))}
                  </span>
                )}
              </button>
              <div className="absolute right-2 top-2.5">
                <RowMenu
                  label={`More for ${s.name}`}
                  items={[{ label: "Delete", destructive: true, confirm: { title: `Delete “${s.name}”?` }, onSelect: () => deleteAnimationStyle(s.id).then(onChanged) }]}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {open && <AnimationSheet key={open === "new" ? "new" : `${open.id}:${open.updatedAt}`} style={open === "new" ? null : open} onClose={() => onOpen(null)} onSaved={onChanged} />}
    </>
  );
}

/** A picture waiting for its style to be saved: the file and an address to show it by. */
interface Waiting {
  file: File;
  url: string;
}

/**
 * One style's sheet. Pictures dropped anywhere on it are added: on a saved style at once, on a new one when it is
 * saved. A picture added here is an inspiration; "Made & liked" fills from the 👍 on an edit's cards.
 */
export function AnimationSheet({ style, onClose, onSaved }: { style: AnimationStyle | null; onClose: () => void; onSaved: (saved: AnimationStyle) => Promise<unknown> }) {
  const [saved, setSaved] = useState(style);
  const [name, setName] = useState(style?.name ?? "");
  const [brief, setBrief] = useState(style?.brief ?? "");
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(message(e));
    }
    setBusy(false);
  };

  const add = (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/")); // before any await: clearing the input empties the list in WebKit
    if (!files.length) return;
    if (!saved) {
      const more = files.map((file) => ({ file, url: URL.createObjectURL(file) }));
      urls.current.push(...more.map((w) => w.url));
      setWaiting((w) => [...w, ...more]);
      return;
    }
    void run(async () => {
      const s = await addStylePictures(saved.id, files);
      setSaved(s);
      await onSaved(s);
    });
  };

  const save = () =>
    run(async () => {
      const s = saved ? await updateAnimationStyle(saved.id, { name, brief }) : await createAnimationStyle({ name, brief });
      setSaved(s);
      const files = waiting.map((w) => w.file);
      setWaiting([]);
      try {
        if (files.length) await addStylePictures(s.id, files);
      } catch (e) {
        // the style is there now, with the pictures that were taken before the one refused: the sheet stays on it
        setSaved((await listAnimationStyles()).styles.find((x) => x.id === s.id) ?? s);
        await onSaved(s);
        throw e;
      }
      await onSaved(s);
      onClose();
    });

  const take = (p: StylePicture) =>
    run(async () => {
      const s = await removeStylePicture(saved!.id, p.id);
      setSaved(s);
      await onSaved(s);
    });

  const group = (kind: StylePicture["kind"]) => (saved?.pictures ?? []).filter((p) => p.kind === kind);
  const made = group("made");
  const inspirations = group("inspiration");

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" aria-describedby={undefined} className="w-full overflow-y-scroll p-0 sm:max-w-xl">
        <form
          className={cn("flex min-h-full flex-col gap-4 p-4 pt-12", over && "bg-violet-500/10")}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            add(e.dataTransfer.files);
          }}
        >
          <SheetTitle className="text-base">{style ? "Animation style" : "New animation style"}</SheetTitle>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="animation-name">Name</Label>
            <Input id="animation-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={STYLE_NAME_MAX} autoFocus={!style} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="animation-brief">Describe the animation style</Label>
            <Textarea id="animation-brief" value={brief} onChange={(e) => setBrief(e.target.value)} rows={5} maxLength={ANIMATION_BRIEF_MAX} placeholder="Big white words on deep blue, one idea at a time. Slow moves, nothing bounces. Numbers count up." />
          </div>
          {made.length > 0 && (
            <section aria-label="Made & liked" className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Made &amp; liked</h3>
              <Pictures styleId={saved!.id} pictures={made} busy={busy} onTake={take} />
            </section>
          )}
          <section aria-label="Inspirations" className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Inspirations</h3>
            {(inspirations.length > 0 || waiting.length > 0) && (
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                <Pictures styleId={saved?.id ?? ""} pictures={inspirations} busy={busy} onTake={take} bare />
                {waiting.map((w) => (
                  <Tile key={w.url} src={w.url} label="Take this picture out" disabled={busy} onTake={() => setWaiting((all) => all.filter((x) => x !== w))} />
                ))}
              </ul>
            )}
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              aria-label="Pictures from this computer"
              onChange={(e) => {
                add(e.target.files);
                e.target.value = "";
              }}
            />
            <div className={cn("flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-3 py-3", over ? "border-violet-500" : "border-zinc-500/30")}>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Plus className="h-3.5 w-3.5" />
                Add pictures
              </Button>
            </div>
          </section>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button type="submit" disabled={busy || !name.trim()} className="self-start">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** One picture with its ×. */
function Tile({ src, label, disabled, onTake }: { src: string; label: string; disabled: boolean; onTake: () => void }) {
  return (
    <li className="relative">
      <img src={src} alt="" className="aspect-square w-full rounded-lg bg-zinc-800 object-cover" />
      <button type="button" aria-label={label} disabled={disabled} onClick={onTake} className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white hover:bg-black disabled:opacity-50">
        <X className="h-3 w-3" />
      </button>
    </li>
  );
}

/** A style's saved pictures as tiles; `bare` leaves the list around them to the caller. */
function Pictures({ styleId, pictures, busy, onTake, bare }: { styleId: string; pictures: StylePicture[]; busy: boolean; onTake: (p: StylePicture) => void; bare?: boolean }) {
  const tiles = pictures.map((p) => <Tile key={p.id} src={stylePictureUrl(styleId, p.id)} label="Take this picture out" disabled={busy} onTake={() => onTake(p)} />);
  return bare ? <>{tiles}</> : <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">{tiles}</ul>;
}
