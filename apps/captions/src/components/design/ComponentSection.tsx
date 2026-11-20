import { useEffect, useState } from "react";
import { Component, Plus, SquareArrowOutUpRight } from "lucide-react";
import type { DesignPage, GroupLayer, Layer } from "@contracts/design";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { detached, isInstance, isMain, mainsOf, propsOf, variantsOf, variantWith, type Instance, type Main } from "@/lib/design/components";
import { Choice, DIM, FIELD, PickOne, Section, Tap } from "./Inspector";

/** Words typed into a field, kept when it is left or Enter is pressed. */
function WordsField({ label, value, onCommit, placeholder }: { label: string; value: string; onCommit: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className={FIELD}>
      <span className={`w-14 shrink-0 truncate text-xs ${DIM}`}>{label}</span>
      <input aria-label={label} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onCommit(v)} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
    </label>
  );
}

/**
 * The Inspector's component section (lib/design/components.ts): an instance's variant, properties, Reset, Detach and Go to
 * main component; a main's set and properties and Place; a layer inside a main bound to a property; else Create
 * component and the design's components to place on the frame.
 */
export function ComponentSection({ pages, picked, path, onLayer, onMake, onPlace, onGoToMain }: {
  pages: readonly DesignPage[];
  /** the picked layers, as they lie in the frame */
  picked: readonly Layer[];
  /** the containers round the first of them, outermost first */
  path: readonly GroupLayer[];
  onLayer: (id: string, fn: (l: Layer) => Layer) => void;
  onMake: () => void;
  onPlace: (key: string) => void;
  onGoToMain: (key: string) => void;
}) {
  const mains = mainsOf(pages);
  const one = picked.length === 1 ? picked[0]! : null;
  const around = [...path].reverse().find(isInstance) as Instance | undefined;
  const inst = isInstance(one) ? one : around;
  if (inst) return <InstanceSection inst={inst} inside={inst !== one} pages={pages} onLayer={onLayer} onGoToMain={onGoToMain} />;
  if (isMain(one)) return <MainSection main={one} pages={pages} onLayer={onLayer} onPlace={onPlace} />;
  const inMain = path.some(isMain);
  if (one && inMain) return <BindSection layer={one} onLayer={onLayer} />;
  const all = [...mains.entries()];
  if (!picked.length && !all.length) return null;
  return (
    <Section title="Components" action={picked.length ? <Tap label="Create component (⌥⌘K)" onClick={onMake}><Component className="h-3.5 w-3.5" /></Tap> : undefined}>
      {!all.length && <p className={`text-xs ${DIM}`}>A part made once and placed on every slide follows each change to it</p>}
      {all.map(([key, { main }]) => (
        <div key={key} className="flex items-center gap-2">
          <Component className="h-3.5 w-3.5 shrink-0 text-[#9747ff]" />
          <span className="min-w-0 flex-1 truncate text-xs">{main.name ?? key}{main.variant ? ` (${Object.values(main.variant).join(", ")})` : ""}</span>
          <Tap label={`Place ${main.name ?? key} on this frame`} onClick={() => onPlace(key)}>
            <Plus className="h-3.5 w-3.5" />
          </Tap>
        </div>
      ))}
    </Section>
  );
}

function InstanceSection({ inst, inside, pages, onLayer, onGoToMain }: { inst: Instance; inside: boolean; pages: readonly DesignPage[]; onLayer: (id: string, fn: (l: Layer) => Layer) => void; onGoToMain: (key: string) => void }) {
  const mains = mainsOf(pages);
  const main = mains.get(inst.instance.of)?.main;
  const set = (fn: (i: Instance) => Instance) => onLayer(inst.id, (l) => (isInstance(l) ? fn(l) : l));
  const prop = (name: string, v: string | boolean) => set((i) => ({ ...i, instance: { ...i.instance, props: { ...i.instance.props, [name]: v } } }));
  const variants = variantsOf(inst.instance.of, pages);
  const changed = !!inst.instance.overrides || !!inst.instance.props;
  return (
    <Section
      title="Instance"
      action={
        main && (
          <Tap label="Go to main component" onClick={() => onGoToMain(inst.instance.of)}>
            <SquareArrowOutUpRight className="h-3.5 w-3.5" />
          </Tap>
        )
      }
    >
      <p className="flex items-center gap-1.5 text-xs">
        <Component className="h-3.5 w-3.5 shrink-0 text-[#9747ff]" />
        <span className="truncate">{main ? (variants.set ?? main.name ?? inst.instance.of) : `No main component "${inst.instance.of}"`}</span>
      </p>
      {inside && <p className={`text-xs ${DIM}`}>A change here is this instance's own; the rest follows its main</p>}
      {[...variants.props].map(([name, values]) => (
        <div key={name} className="flex flex-col gap-1">
          <span className={`text-xs ${DIM}`}>{name}</span>
          <Choice
            label={name}
            value={main?.variant?.[name] ?? null}
            options={values.map((v) => [v, v] as const)}
            onPick={(v) => {
              const to = variantWith(inst.instance.of, name, v, pages);
              if (to) set((i) => ({ ...i, instance: { ...i.instance, of: to } }));
            }}
          />
        </div>
      ))}
      {main &&
        propsOf(main).map((p) => {
          const v = inst.instance.props?.[p.name] ?? p.value;
          if (p.kind === "text") return <WordsField key={p.name} label={p.name} value={String(v)} onCommit={(t) => prop(p.name, t)} />;
          if (p.kind === "visible")
            return (
              <label key={p.name} className="flex items-center gap-2 text-xs">
                <Checkbox checked={v === true} onCheckedChange={(on) => prop(p.name, on === true)} />
                {p.name}
              </label>
            );
          return (
            <div key={p.name} className="flex items-center gap-2">
              <span className={`w-14 shrink-0 truncate text-xs ${DIM}`}>{p.name}</span>
              <div className="min-w-0 flex-1">
                <PickOne label={p.name} value={mains.get(String(v))?.main.name ?? String(v)} options={[...mains.entries()].filter(([k]) => k !== inst.instance.of).map(([k, m]) => [k, m.main.name ?? k] as const)} onPick={(k) => prop(p.name, k)} />
              </div>
            </div>
          );
        })}
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" className="h-6 flex-1 text-xs" disabled={!changed} onClick={() => set((i) => ({ ...i, instance: { of: i.instance.of } }))}>
          Reset
        </Button>
        <Button size="sm" variant="secondary" className="h-6 flex-1 text-xs" onClick={() => onLayer(inst.id, (l) => (isInstance(l) ? detached(l) : l))}>
          Detach
        </Button>
      </div>
    </Section>
  );
}

function MainSection({ main, pages, onLayer, onPlace }: { main: Main; pages: readonly DesignPage[]; onLayer: (id: string, fn: (l: Layer) => Layer) => void; onPlace: (key: string) => void }) {
  const props = propsOf(main);
  const variants = variantsOf(main.component, pages);
  return (
    <Section
      title="Main component"
      action={
        <Tap label="Place an instance on this frame" onClick={() => onPlace(main.component)}>
          <Plus className="h-3.5 w-3.5" />
        </Tap>
      }
    >
      <p className={`text-xs ${DIM}`}>Every instance follows a change made here</p>
      {main.set &&
        Object.entries(main.variant ?? {}).map(([k, v]) => (
          <WordsField key={k} label={k} value={v} onCommit={(t) => t.trim() && onLayer(main.id, (l) => (isMain(l) ? { ...l, variant: { ...l.variant, [k]: t.trim() } } : l))} />
        ))}
      {main.set && <p className={`text-xs ${DIM}`}>One of {variants.members.length} variants of {main.set}</p>}
      {props.length > 0 && <p className={`text-xs ${DIM}`}>Properties: {props.map((p) => p.name).join(", ")}</p>}
    </Section>
  );
}

/** A layer of a main bound to its properties (Box `bind`): its words, whether it shows, which component it shows. */
function BindSection({ layer, onLayer }: { layer: Layer; onLayer: (id: string, fn: (l: Layer) => Layer) => void }) {
  const bind = (k: "text" | "visible" | "swap", name: string) =>
    onLayer(layer.id, (l) => {
      const b = { ...l.bind, [k]: name.trim() || undefined };
      return { ...l, bind: b.text || b.visible || b.swap ? b : undefined };
    });
  return (
    <Section title="Component property">
      {layer.type === "text" && <WordsField label="Words" value={layer.bind?.text ?? ""} placeholder="Property name" onCommit={(v) => bind("text", v)} />}
      <WordsField label="Show" value={layer.bind?.visible ?? ""} placeholder="Property name" onCommit={(v) => bind("visible", v)} />
      {isInstance(layer) && <WordsField label="Swap" value={layer.bind?.swap ?? ""} placeholder="Property name" onCommit={(v) => bind("swap", v)} />}
    </Section>
  );
}
