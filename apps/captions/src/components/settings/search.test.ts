import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS_PAGE_IDS } from "./nav";
import { SETTINGS_SEARCH_INDEX, searchSettings } from "./search";

/** The sections of a full install (every page), with their titles, the way SettingsPage builds them. */
const ALL = new Map<string, string>([
  ["general", "General"], ["appearance", "Appearance"], ["folders", "Storage"], ["providers", "Providers"],
  ["devices", "Computers"], ["automations", "Scheduled tasks"], ["usage", "Usage"], ["connectors", "Social accounts"],
  ["keys", "API keys"], ["own-ai", "Use from your AI"], ["servers", "Servers"], ["team", "Team"], ["admin", "Admin"],
  ["account", "Account"],
]);
/** The first hit, on an install where sign-in is required (the default here: the sign-in rows exist). */
const first = (q: string, sections = ALL, signIn = true) => searchSettings(q, sections, undefined, signIn)[0];

describe("search index", () => {
  it("every row's section is a Settings page", () => {
    for (const row of SETTINGS_SEARCH_INDEX) expect(SETTINGS_PAGE_IDS).toContain(row.section);
  });

  it("row ids are unique", () => {
    const ids = SETTINGS_SEARCH_INDEX.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/** Every `<Row id="…">`-style element in the settings screens must have its id in the index. Reads the source: a row that
 *  is not mounted (its section is closed) is still searchable only if it is in the index. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".tsx") ? [path] : [];
  });
}

/** The props of each `<name …>` opening tag, with what sits inside {…} blanked (a nested element's props are not this one's). */
function openingTags(src: string, name: string): string[] {
  const tags: string[] = [];
  for (const m of src.matchAll(new RegExp(`<${name}(?=[\\s/>])`, "g"))) {
    let depth = 0;
    let props = "";
    for (let i = (m.index ?? 0) + name.length + 1; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && src[i - 1] !== "=") break;
      else if (depth === 0) props += c;
    }
    tags.push(props);
  }
  return tags;
}

describe("every id a settings row carries is in the index", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const indexed = new Set(SETTINGS_SEARCH_INDEX.map((r) => r.id));
  const files = [...sourceFiles(dir), fileURLToPath(new URL("../../pages/SettingsPage.tsx", import.meta.url))];
  const names = ["Row", "ListRow", "Section", "Group", "EmptyRow", "Advanced"];

  for (const name of names) {
    it(`<${name} id="…"> is indexed`, () => {
      const missing: string[] = [];
      for (const file of files) {
        for (const props of openingTags(readFileSync(file, "utf8"), name)) {
          for (const m of props.matchAll(/\sid="([^"]+)"/g)) if (!indexed.has(m[1])) missing.push(`${file}: ${m[1]}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});

describe("search ranking", () => {
  it("'password' lands on the Account password row", () => {
    expect(first("password")).toMatchObject({ id: "password", section: "account" });
  });

  it("offers the sign-in rows only where sign-in is required", () => {
    expect(searchSettings("password", ALL).some((h) => h.id === "password")).toBe(false);
    expect(searchSettings("sign out", ALL).some((h) => h.id === "sign-out")).toBe(false);
  });

  it("'theme' lands on the Theme row in Appearance", () => {
    expect(first("theme")).toMatchObject({ id: "theme", section: "appearance" });
  });

  it("'apify' lands on the Apify row in API keys (the key leaves Social accounts)", () => {
    expect(first("apify")).toMatchObject({ id: "apify-key", section: "keys" });
  });

  it("'sign out' lands on the Sign out row", () => {
    expect(first("sign out")).toMatchObject({ id: "sign-out", section: "account" });
  });

  it("'deepgram' lands in API keys, on its own row", () => {
    expect(first("deepgram")).toMatchObject({ id: "api-key-DEEPGRAM_API_KEY", section: "keys" });
  });

  it("finds the rows that keep the cache, all in General", () => {
    const hits = searchSettings("cache", ALL);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.section === "general")).toBe(true);
  });

  it("finds nothing for a word no section or row has", () => {
    expect(searchSettings("zzqx", ALL)).toEqual([]);
  });

  it("leaves the Mac app's own rows out of a browser's results", () => {
    expect(searchSettings("recording shortcut", ALL).some((h) => h.id === "recording-shortcut")).toBe(false);
    expect(searchSettings("recording shortcut", ALL, undefined, false, true)[0]?.id).toBe("recording-shortcut");
  });

  it("finds nothing in a section this install does not show (team on a local server)", () => {
    const local = new Map([...ALL].filter(([id]) => id !== "team" && id !== "admin"));
    expect(searchSettings("invite", local).some((h) => h.section === "team")).toBe(false);
  });

  it("an empty query finds nothing", () => {
    expect(searchSettings("   ", ALL)).toEqual([]);
  });
});
