/**
 * In-app stand-ins for window.confirm / prompt / alert: await one, `<AppDialogs />` (App.tsx) draws it. Without the host (a test) they fall
 * back to the browser's own.
 */

import { storedConfirmDeletes } from "./settings";

/** `deleting`: a reversible delete (to the trash, a comment). Skipped when Settings → General turns confirms off. */
export type DialogOpts = { title: string; body?: string; ok?: string; danger?: boolean; deleting?: boolean };
export type DialogAsk = DialogOpts & { kind: "confirm" | "prompt" | "alert"; value?: string; done: (v: boolean | string | null) => void };

let show: ((a: DialogAsk) => void) | null = null;

/** AppDialogs registers itself here while mounted. */
export function setDialogHost(fn: ((a: DialogAsk) => void) | null): void {
  show = fn;
}

const plain = (o: DialogOpts) => (o.body ? `${o.title}\n\n${o.body}` : o.title);

export function confirmDialog(o: DialogOpts): Promise<boolean> {
  if (o.deleting && !storedConfirmDeletes()) return Promise.resolve(true);
  if (!show) return Promise.resolve(window.confirm(plain(o)));
  const host = show;
  return new Promise((done) => host({ ...o, kind: "confirm", done: (v) => done(v === true) }));
}

/** The text typed, or null when cancelled. */
export function promptDialog(o: DialogOpts & { value?: string }): Promise<string | null> {
  if (!show) return Promise.resolve(window.prompt(plain(o), o.value ?? ""));
  const host = show;
  return new Promise((done) => host({ ...o, kind: "prompt", done: (v) => done(typeof v === "string" ? v : null) }));
}

export function alertDialog(o: DialogOpts): Promise<void> {
  if (!show) {
    window.alert(plain(o));
    return Promise.resolve();
  }
  const host = show;
  return new Promise((done) => host({ ...o, kind: "alert", done: () => done() }));
}
