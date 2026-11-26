// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { OFF_LINE, useLoadBalancing } from "./ServerWorkSection";

// the real select is a menu a test cannot open: a plain one with the same props
vi.mock("./kit-controls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kit-controls")>()),
  SettingsSelect: ({ label, value, onValueChange, options }: { label: string; value: string; onValueChange: (v: string) => void; options: ReadonlyArray<{ value: string; label: string }> }) => (
    <select aria-label={label} value={value} onChange={(e) => onValueChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  ),
}));

// Settings → Computers, Load balancing: the menu a computer's row carries and the switch under the list. Server stubbed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** One Mac that registered twice, as its row asks: the record that speaks for it first. */
const IDS = ["mac-now", "mac-before"];
function Row() {
  const b = useLoadBalancing();
  return (
    <>
      <p>{b.off(IDS) ? OFF_LINE : "Takes work"}</p>
      {b.preference(IDS, "Tiny Mac")}
      {b.rows}
    </>
  );
}

it("a computer's menu shows its main record's value, saves every record of it, and goes with the switch", async () => {
  let balance = { on: true, weights: { "mac-now": 100, "mac-before": 25 } as Record<string, number>, libraries: {}, originals: {} };
  const saved: unknown[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.endsWith("/balance")) return json({ kind: "server", place: null });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { on?: boolean; weights?: Record<string, number> };
      saved.push(body);
      balance = { ...balance, on: body.on ?? balance.on, weights: { ...balance.weights, ...body.weights } };
    }
    return json(balance);
  }));
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => createRoot(host).render(<Row />));
  const menu = () => host.querySelector<HTMLSelectElement>('select[aria-label="Tiny Mac load preference"]');

  // the first record's value (Prefer), never an older record's
  expect(menu()!.value).toBe("100");
  expect(host.textContent).toContain("Takes work");

  menu()!.value = "0";
  await act(async () => void menu()!.dispatchEvent(new Event("change", { bubbles: true })));
  expect(saved.at(-1)).toEqual({ weights: { "mac-now": 0, "mac-before": 0 } });
  expect(host.textContent).toContain(OFF_LINE);

  // the switch off: no menu and no Off line, since the preferences count only while it is on
  await act(async () => host.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Load balancing"]')!.click());
  expect(saved.at(-1)).toEqual({ on: false });
  expect(menu()).toBeNull();
  expect(host.textContent).not.toContain(OFF_LINE);
});
