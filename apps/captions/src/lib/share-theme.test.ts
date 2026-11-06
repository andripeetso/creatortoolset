import { describe, expect, it } from "vitest";
import {
  SHARE_THEME_KEY,
  persistShareTheme,
  readShareTheme,
  storedThemeChoice,
  resolveShareTheme,
  systemShareTheme,
} from "./share-theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

describe("share theme", () => {
  it("reads only light or dark from storage", () => {
    expect(readShareTheme(memoryStorage())).toBeNull();
    expect(readShareTheme(memoryStorage({ [SHARE_THEME_KEY]: "light" }))).toBe(
      "light",
    );
    expect(readShareTheme(memoryStorage({ [SHARE_THEME_KEY]: "system" }))).toBeNull();
  });

  it("follows a stored choice over the browser preference", () => {
    expect(resolveShareTheme("light", "dark")).toBe("light");
    expect(resolveShareTheme("dark", "light")).toBe("dark");
  });

  it("falls back to the browser color scheme", () => {
    expect(resolveShareTheme(null, "light")).toBe("light");
    expect(resolveShareTheme(null, "dark")).toBe("dark");
    expect(systemShareTheme(false)).toBe("light");
    expect(systemShareTheme(true)).toBe("dark");
  });

  it("persists an explicit visitor choice", () => {
    const storage = memoryStorage();
    persistShareTheme("light", storage);
    expect(readShareTheme(storage)).toBe("light");
  });
});

describe("storedThemeChoice", () => {
  it("nothing stored: dark in the app, the system's on a share page; a stored choice wins, system included", () => {
    expect(storedThemeChoice(false, memoryStorage())).toBe("dark");
    expect(storedThemeChoice(true, memoryStorage())).toBe("system");
    expect(storedThemeChoice(false, memoryStorage({ [SHARE_THEME_KEY]: "system" }))).toBe("system");
    expect(storedThemeChoice(true, memoryStorage({ [SHARE_THEME_KEY]: "light" }))).toBe("light");
  });
});
