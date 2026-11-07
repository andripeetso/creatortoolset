import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Columns2, Maximize2, Rows2, X } from "lucide-react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { DeskIsland } from "./DeskIsland";
import {
  ISLAND_LABEL,
  enterFocus,
  groupLayout,
  hideIsland,
  leaveFocus,
  rememberSizes,
  reorderIslands,
  setGeometry,
  showIsland,
  stackedSlots,
  visibleIslands,
  type DeskLayout,
  type IslandId,
} from "@/lib/workshop-desk";

const HANDLE =
  "!w-2 !bg-transparent hover:!bg-violet-500/25 data-[panel-group-direction=vertical]:!h-2 data-[panel-group-direction=vertical]:!w-full [&>div]:!border-border [&>div]:!bg-muted-foreground/40";
const chip = "inline-flex h-7 items-center rounded-md px-2 text-[11px]";

export interface IslandSlot {
  header?: ReactNode;
  untitled?: boolean;
  hint?: string;
  body: ReactNode;
}

export function DeskControls({
  layout,
  onChange,
}: {
  layout: DeskLayout;
  onChange: Dispatch<SetStateAction<DeskLayout>>;
}) {
  const focused = layout.focus === "writing";
  const vis = visibleIslands({ ...layout, focus: null });
  const [dragId, setDragId] = useState<IslandId | null>(null);
  const [overId, setOverId] = useState<IslandId | null>(null);
  const dragIdRef = useRef<IslandId | null>(null);
  const overIdRef = useRef<IslandId | null>(null);
  const skipClick = useRef(false);
  const dragging = !layout.focus;
  const preview = dragId ? reorderIslands({ ...layout, focus: null }, dragId, overId ?? dragId).order : layout.order;
  const btn = (on: boolean) => `${chip} ${on ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"}`;
  const clearDrag = () => {
    dragIdRef.current = null;
    overIdRef.current = null;
    setDragId(null);
    setOverId(null);
  };
  const hoverChip = (id: IslandId) => {
    if (overIdRef.current === id) return;
    overIdRef.current = id;
    setOverId(id);
  };
  return (
    <div className="flex items-center gap-1">
      <button type="button" className={btn(layout.geometry === "stacked" && !layout.focus)} onClick={() => onChange((d) => setGeometry(d, "stacked"))} aria-pressed={layout.geometry === "stacked" && !layout.focus}>
        <Rows2 className="mr-1 inline h-3 w-3" /> Stacked
      </button>
      <button type="button" className={btn(layout.geometry === "columns" && !layout.focus)} onClick={() => onChange((d) => setGeometry(d, "columns"))} aria-pressed={layout.geometry === "columns" && !layout.focus}>
        <Columns2 className="mr-1 inline h-3 w-3" /> Columns
      </button>
      <button type="button" className={btn(focused)} onClick={() => onChange((d) => enterFocus(d, "writing"))} aria-pressed={focused} title="Writing only — Esc to restore">
        <Maximize2 className="mr-1 inline h-3 w-3" /> Focus
      </button>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <div
        className="flex items-center gap-1"
        onDragOver={(e) => {
          if (!dragIdRef.current || !dragging) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          e.preventDefault();
          const from = dragIdRef.current;
          const to = overIdRef.current;
          if (from && to && from !== to) onChange((d) => reorderIslands(d, from, to));
          clearDrag();
        }}
      >
        {layout.order.map((id) => {
          const on = vis.includes(id);
          const last = vis.length === 1 && on;
          const held = dragId === id;
          return (
            <button
              key={id}
              type="button"
              draggable={dragging}
              style={!held && dragId ? { order: preview.indexOf(id) + 1 } : undefined}
              className={
                held
                  ? "h-0 w-0 overflow-hidden p-0 opacity-0"
                  : `${btn(on)} ${dragging ? "cursor-grab active:cursor-grabbing" : ""}`
              }
              aria-pressed={on}
              title={
                last
                  ? `${ISLAND_LABEL[id]} · drag to reorder`
                  : on
                    ? `Hide ${ISLAND_LABEL[id]} · drag to reorder`
                    : `Show ${ISLAND_LABEL[id]} · drag to reorder`
              }
              onDragStart={(e) => {
                if (!dragging) return;
                skipClick.current = true;
                dragIdRef.current = id;
                overIdRef.current = id;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", id);
                requestAnimationFrame(() => {
                  if (dragIdRef.current !== id) return;
                  setDragId(id);
                  setOverId(overIdRef.current ?? id);
                });
              }}
              onDragOver={(e) => {
                const from = dragIdRef.current;
                if (!from || from === id || !dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                hoverChip(id);
              }}
              onDragEnd={() => {
                clearDrag();
                window.setTimeout(() => {
                  skipClick.current = false;
                }, 0);
              }}
              onClick={() => {
                if (skipClick.current) {
                  skipClick.current = false;
                  return;
                }
                if (last && on) return;
                onChange((d) => {
                  const base = d.focus ? leaveFocus(d) : d;
                  return visibleIslands(base).includes(id) ? hideIsland(base, id) : showIsland(base, id);
                });
              }}
            >
              {ISLAND_LABEL[id]}
            </button>
          );
        })}
        {dragId ? (
          <div
            aria-hidden
            className={`${chip} pointer-events-none border border-dashed border-violet-400/70 bg-violet-500/10 text-transparent`}
            style={{ order: preview.indexOf(dragId) + 1 }}
          >
            {ISLAND_LABEL[dragId]}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Renders the three islands in stacked or column geometry, with resize + focus. */
export function WorkshopDesk({
  layout,
  onChange,
  islands,
  overlay,
}: {
  layout: DeskLayout;
  onChange: Dispatch<SetStateAction<DeskLayout>>;
  islands: Record<IslandId, IslandSlot>;
  /** Laid over the piece and the chat, never over Browse / Read (the post preview while browsing). */
  overlay?: ReactNode;
}) {
  useEffect(() => {
    if (!layout.focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onChange(leaveFocus);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout.focus, onChange]);

  const wrap = (id: IslandId) => {
    const slot = islands[id];
    return (
      <DeskIsland id={id} hint={slot.hint} header={slot.header} untitled={slot.untitled}>
        {slot.body}
      </DeskIsland>
    );
  };

  // Browse / Read is a drawer on the right: the piece and the chat take the screen; the drawer
  // opens from the Content chip or when a source is read, and closes with its ×. Alone or in Focus it is the board.
  const all = visibleIslands(layout);
  const drawer = !layout.focus && all.includes("content") && all.some((id) => id !== "content");
  const board = (layout: DeskLayout) => {
    const vis = visibleIslands(layout);
    if (vis.length === 1) {
      return <div className={DESK}>{wrap(vis[0]!)}</div>;
    }

    if (layout.geometry === "columns") {
      return (
        <div className={DESK}>
          <Split id={`cols-${vis.join("-")}`} orientation="horizontal" kind="columns" ids={vis} layout={layout} onChange={onChange}>
            {vis.map((id) => wrap(id))}
          </Split>
        </div>
      );
    }

    const { stack, side } = stackedSlots(layout);
    if (side && stack.length) {
      const left = stack.length === 1 ? wrap(stack[0]!) : (
        <Split id={`stack-v-${stack.join("-")}`} orientation="vertical" kind="stack-v" ids={stack} layout={layout} onChange={onChange}>
          {stack.map((id) => wrap(id))}
        </Split>
      );
      return (
        <div className={DESK}>
          <Split
            id={`stack-h-${stack.join("-")}_${side}`}
            orientation="horizontal"
            kind="stack-h"
            ids={["stack", side]}
            layout={layout}
            onChange={onChange}
          >
            {[left, wrap(side)]}
          </Split>
        </div>
      );
    }

    const rest = stack.length ? stack : vis;
    if (rest.length === 1) {
      return <div className={DESK}>{wrap(rest[0]!)}</div>;
    }
    return (
      <div className={DESK}>
        <Split id={`stack-v-${rest.join("-")}`} orientation="vertical" kind="stack-v" ids={rest} layout={layout} onChange={onChange}>
          {rest.map((id) => wrap(id))}
        </Split>
      </div>
    );

  };
  const over = overlay ? <div className="absolute inset-0 z-30">{overlay}</div> : null;
  if (!drawer)
    return (
      <div className="relative h-full min-h-0">
        {board(layout)}
        {over}
      </div>
    );
  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        {board(hideIsland(layout, "content"))}
        {over}
      </div>
      <aside className="relative w-[min(34rem,40vw)] shrink-0 pb-10 pr-2 pt-2" aria-label="Browse and read">
        {wrap("content")}
        <button
          type="button"
          onClick={() => onChange((d) => hideIsland(d, "content"))}
          className="absolute right-4 top-4 z-10 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Close Browse (the Content chip opens it again)"
          aria-label="Close Browse"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </aside>
    </div>
  );
}

/** The panels stop above a strip at the bottom, where Update sits (CornerNav), so nothing covers a panel. */
const DESK = "h-full min-h-0 px-2 pt-2 pb-10";

function Split({
  id,
  orientation,
  kind,
  ids,
  layout,
  onChange,
  children,
}: {
  id: string;
  orientation: "horizontal" | "vertical";
  kind: "columns" | "stack-h" | "stack-v";
  ids: string[];
  layout: DeskLayout;
  onChange: Dispatch<SetStateAction<DeskLayout>>;
  children: ReactNode[];
}) {
  const sizes = groupLayout(layout, id, kind, ids);
  const nodes: ReactNode[] = [];
  children.forEach((child, i) => {
    const panelId = ids[i]!;
    if (i > 0) {
      nodes.push(<ResizableHandle key={`h-${panelId}`} withHandle className={HANDLE} />);
    }
    nodes.push(
      <ResizablePanel key={panelId} id={panelId} minSize="16%" className="h-full min-h-0 min-w-0">
        {child}
      </ResizablePanel>,
    );
  });
  return (
    <ResizablePanelGroup
      key={id}
      id={id}
      orientation={orientation}
      className="h-full min-h-0"
      defaultLayout={sizes}
      onLayoutChange={(next) => onChange((d) => rememberSizes(d, id, next))}
    >
      {nodes}
    </ResizablePanelGroup>
  );
}
