// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogContent, DialogTitle } from "@/components/ui/dialog";
import { FormDialog, SettingsDialog } from "./kit-dialog";

// A dialog a row menu opens ("Edit" on a task, "Workspaces…" on a member) comes up while the menu is still closing, and
// the menu then gives the focus back to its `…` button, outside the dialog. A Settings dialog stays open through that.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
});

/** Draws `dialog` beside a button outside it, moves the focus to that button, and says whether the dialog was told to close. */
async function closedByFocusOutside(dialog: (onOpenChange: (open: boolean) => void) => ReactNode): Promise<boolean> {
  const onOpenChange = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<><button id="menu">…</button>{dialog(onOpenChange)}</>));
  await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
  await act(async () => {
    document.getElementById("menu")!.focus();
    await new Promise<void>((done) => setTimeout(done, 0));
  });
  return onOpenChange.mock.calls.some(([open]) => open === false);
}

describe("Settings dialogs", () => {
  it("stay open when the focus goes back to the row menu's button", async () => {
    expect(await closedByFocusOutside((on) => <FormDialog open onOpenChange={on} title="Edit task" submitLabel="Save" onSubmit={() => {}}>fields</FormDialog>)).toBe(false);
  });

  it("which a dialog that is not modal would otherwise close on", async () => {
    const plain = (on: (open: boolean) => void) => (
      <SettingsDialog open onOpenChange={on}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Edit task</DialogTitle>
        </DialogContent>
      </SettingsDialog>
    );
    expect(await closedByFocusOutside(plain)).toBe(true);
  });
});
