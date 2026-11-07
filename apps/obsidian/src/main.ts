import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from "obsidian";
import { readFileSync } from "fs";
import { homedir } from "os";
import { createHash } from "crypto";
import { copyName, inFolder, isSynced, readNote, safeVaultPath, shouldWriteBack, ymd } from "./lib.ts";

interface Settings {
  siteUrl: string;
  keyPath: string;
  folder: string;
  statusProperty: string;
  mediaProperty: string;
  projectId: string;
  syncMinutes: number;
  autoSync: boolean;
  /** Nothing syncs while true (the Send button still works). */
  paused: boolean;
}

const DEFAULTS: Settings = {
  siteUrl: "http://127.0.0.1:43128",
  keyPath: "~/.config/creator-toolset/key",
  folder: "Scripts",
  statusProperty: "selector.Status",
  mediaProperty: "selector.Media",
  projectId: "",
  syncMinutes: 5,
  autoSync: true,
  paused: false,
};

/** data.json: settings and the last sync time. No key, no per-note state (a vault is often synced or kept in git). */
interface PluginData {
  settings: Partial<Settings>;
  lastSync: number;
}

interface NoteState {
  mtime: number;
  status?: string;
  /** The session id once the site has linked this note (null = not linked). */
  id?: string | null;
}

/** Per-device state, kept in Obsidian's local storage rather than in the vault. */
interface LocalState {
  notes: Record<string, NoteState>;
  /** sha256 of what the plugin last wrote to each file of an export. */
  written: Record<string, string>;
}

const LOCAL_KEY = "creator-toolset-state";
const TEXT_SETTINGS = ["siteUrl", "keyPath", "folder", "statusProperty", "mediaProperty", "projectId"] as const;

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** The site refused the key: stop the sync rather than fail once per note. */
class AuthError extends Error {}

export default class CreatorToolsetPlugin extends Plugin {
  settings!: Settings;
  private lastSync = 0;
  private state!: LocalState;
  private lastRun = 0;
  private running = false;
  private debounceId: number | undefined;
  /** Each folder note's status as of the last metadata change (in memory). */
  private seen: Record<string, string | undefined> = {};

  async onload() {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = { ...DEFAULTS, ...data.settings };
    this.lastSync = data.lastSync ?? 0;
    this.state = (this.app.loadLocalStorage(LOCAL_KEY) as LocalState | null) ?? { notes: {}, written: {} };

    this.addRibbonIcon("send", "Send to Creator Toolset", () => this.send());
    this.addCommand({ id: "send", name: "Send to Creator Toolset", callback: () => this.send() });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync(true) });
    this.addSettingTab(new SettingsTab(this.app, this));

    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.onChanged(file)));
    this.registerInterval(window.setInterval(() => this.tick(), 60_000));
    this.app.workspace.onLayoutReady(() => {
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (inFolder(file.path, this.settings.folder)) this.seen[file.path] = readNote(this.frontmatter(file), this.keys()).status;
      }
      this.tick();
    });
  }

  onunload() {
    window.clearTimeout(this.debounceId);
  }

  /** Settings and last sync time go to data.json. */
  async savePluginData() {
    await this.saveData({ settings: this.settings, lastSync: this.lastSync } satisfies PluginData);
  }

  private saveState() {
    this.app.saveLocalStorage(LOCAL_KEY, this.state);
  }

  private keys() {
    return { status: this.settings.statusProperty, media: this.settings.mediaProperty };
  }

  private frontmatter(file: TFile) {
    return this.app.metadataCache.getFileCache(file)?.frontmatter;
  }

  /** Once a minute: sync when the interval has passed. The first tick runs on load. */
  private tick() {
    if (!this.settings.autoSync || this.settings.paused) return;
    if (Date.now() - this.lastRun < this.settings.syncMinutes * 60_000) return;
    void this.sync(false);
  }

  /** A note in the folder changed its status: sync soon (a few edits in a row cost one sync). Body edits do nothing. */
  private onChanged(file: TFile) {
    if (!inFolder(file.path, this.settings.folder)) return;
    const status = readNote(this.frontmatter(file), this.keys()).status;
    if (this.seen[file.path] === status) return;
    this.seen[file.path] = status;
    if (!this.settings.autoSync) return;
    window.clearTimeout(this.debounceId);
    this.debounceId = window.setTimeout(() => void this.sync(false), 3000);
  }

  private keyFile(): string {
    return this.settings.keyPath.replace(/^~(?=\/|$)/, homedir());
  }

  /** The AI access key, read from its file on every sync (never stored). */
  private readKey(manual: boolean): string | null {
    try {
      const key = readFileSync(this.keyFile(), "utf8").trim();
      if (key) return key;
    } catch {
      // handled below
    }
    if (manual) new Notice(`Creator Toolset: no key at ${this.settings.keyPath}`);
    return null;
  }

  keyStatus(): string {
    return this.readKey(false) ? "Key found." : `No key at ${this.settings.keyPath} yet.`;
  }

  private async api(key: string, method: string, path: string, body?: unknown) {
    return requestUrl({
      url: this.settings.siteUrl.replace(/\/+$/, "") + path,
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      throw: false,
    });
  }

  /** One sync: push the notes that changed, pull the status changes, then write the pending exports. */
  async sync(manual: boolean) {
    if (this.settings.paused) {
      if (manual) new Notice("Creator Toolset: sync is paused in settings");
      return;
    }
    if (this.running) return;
    const key = this.readKey(manual);
    if (!key) return;
    this.running = true;
    this.lastRun = Date.now();
    try {
      await this.push(key);
      await this.pull(key);
      await this.exportsPending(key);
      if (manual) new Notice("Creator Toolset: synced");
    } catch (error) {
      console.error("[creator-toolset] sync failed", error);
      if (manual) new Notice(`Creator Toolset: ${(error as Error).message}`);
    } finally {
      this.running = false;
      this.saveState();
    }
  }

  /** PUT every synced or linked note whose file changed since the last push. */
  private async push(key: string) {
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!inFolder(file.path, this.settings.folder)) continue;
      const note = readNote(this.frontmatter(file), this.keys());
      const prev = this.state.notes[file.path];
      if (!note.status || !isSynced(note.status, !!prev?.id)) continue;
      if (prev && prev.mtime === file.stat.mtime && prev.status === note.status) continue;
      try {
        const res = await this.api(key, "PUT", "/api/workshop/notes", {
          path: file.path,
          title: file.basename,
          status: note.status,
          media: note.media,
          details: note.details,
          markdown: await this.app.vault.cachedRead(file),
          mtime: file.stat.mtime,
          projectId: this.settings.projectId || undefined,
        });
        if (res.status === 401 || res.status === 403) throw new AuthError(`key refused (${res.status})`);
        // 404 or no id = no session for this note (the site creates one only for the synced statuses)
        if (res.status >= 300 && res.status !== 404) throw new Error(`PUT ${res.status}`);
        const id = res.status === 404 ? null : ((res.json?.id as string | undefined) ?? null);
        this.state.notes[file.path] = { mtime: file.stat.mtime, status: note.status, id };
      } catch (error) {
        if (error instanceof AuthError) throw error;
        console.error("[creator-toolset] push failed for", file.path, error);
      }
    }
  }

  /** GET the sessions whose status changed on the site, and write those statuses into their notes. */
  private async pull(key: string) {
    const started = Date.now();
    // a margin for clock skew: a repeat costs nothing, a miss loses a change
    const since = this.lastSync ? this.lastSync - 10 * 60_000 : 0;
    const res = await this.api(key, "GET", `/api/workshop/notes?since=${since}`);
    if (res.status >= 300) throw new Error(`notes ${res.status}`);
    const rows = res.json as Array<{ id: string; path: string; status: string; statusAt: number }>;
    const keys = this.keys();
    for (const row of rows) {
      const file = this.app.vault.getAbstractFileByPath(row.path);
      if (!(file instanceof TFile)) continue;
      const note = readNote(this.frontmatter(file), keys);
      if (!shouldWriteBack({ status: note.status, mtime: file.stat.mtime }, row)) continue;
      this.state.notes[file.path] = { ...this.state.notes[file.path], mtime: file.stat.mtime, status: row.status, id: row.id };
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm[keys.status] = row.status;
        fm.change = ymd(row.statusAt);
      });
      this.state.notes[file.path].mtime = file.stat.mtime;
    }
    this.lastSync = started;
    await this.savePluginData();
  }

  /** The Workshop's "plugin" exports: write each file at its path, never over a file changed by hand. */
  private async exportsPending(key: string) {
    const res = await this.api(key, "GET", "/api/workshop/exports/pending");
    if (res.status >= 300) throw new Error(`exports ${res.status}`);
    const rows = res.json as Array<{ id: string; path: string; markdown: string }>;
    for (const row of rows) {
      const target = safeVaultPath(row.path);
      if (!target) {
        console.error("[creator-toolset] refused export path", row.path);
        continue;
      }
      try {
        await this.placeExport(target, row.markdown);
        const done = await this.api(key, "POST", `/api/workshop/exports/pending/${row.id}/done`);
        if (done.status >= 300) throw new Error(`done ${done.status}`);
      } catch (error) {
        console.error("[creator-toolset] export failed", target, error);
      }
    }
  }

  private async placeExport(target: string, markdown: string) {
    const sha = hash(markdown);
    const existing = this.app.vault.getAbstractFileByPath(target);
    if (existing instanceof TFile) {
      const current = hash(await this.app.vault.read(existing));
      if (current === sha) return;
      if (current === this.state.written[target]) {
        // still what we wrote last time: safe to update
        await this.app.vault.modify(existing, markdown);
        this.state.written[target] = sha;
        return;
      }
    }
    // changed by hand (or it is not ours): the first free "name (n).md", unless that copy is already there
    for (let n = existing ? 2 : 1; ; n++) {
      const path = n === 1 ? target : copyName(target, n);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) {
        await this.ensureFolder(path);
        await this.app.vault.create(path, markdown);
        this.state.written[path] = sha;
        return;
      }
      if (file instanceof TFile && hash(await this.app.vault.read(file)) === sha) return;
    }
  }

  private async ensureFolder(path: string) {
    const parts = path.split("/").slice(0, -1);
    let dir = "";
    for (const part of parts) {
      dir = dir ? `${dir}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
    }
  }

  /** The Send button: create (or re-open) the session for the active note, then open it. */
  async send() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Creator Toolset: open a note first");
      return;
    }
    const key = this.readKey(true);
    if (!key) return;
    const note = readNote(this.frontmatter(file), this.keys());
    try {
      const res = await this.api(key, "PUT", "/api/workshop/notes", {
        path: file.path,
        title: file.basename,
        status: note.status ?? "💡 Idea",
        media: note.media,
        details: note.details,
        markdown: await this.app.vault.cachedRead(file),
        mtime: file.stat.mtime,
        projectId: this.settings.projectId || undefined,
        create: "send",
      });
      if (res.status >= 300) throw new Error(`send ${res.status}`);
      const session = res.json as { id: string; url: string };
      this.state.notes[file.path] = { mtime: file.stat.mtime, status: note.status, id: session.id };
      this.saveState();
      window.open(`creatortoolset://${session.url.replace(/^\/+/, "")}`); // the Mac app opens its links
      new Notice("Sent to Creator Toolset");
    } catch (error) {
      new Notice(`Creator Toolset: ${(error as Error).message}`);
    }
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: CreatorToolsetPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const save = async () => this.plugin.savePluginData();

    const text = (name: string, desc: string, key: (typeof TEXT_SETTINGS)[number]) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((input) =>
          input.setValue(String(settings[key])).onChange(async (value) => {
            settings[key] = value.trim();
            await save();
          }),
        );
    const toggle = (name: string, desc: string, key: "autoSync" | "paused") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((input) =>
          input.setValue(Boolean(settings[key])).onChange(async (value) => {
            settings[key] = value;
            await save();
          }),
        );

    text("Server address", "The Creator Toolset server: the Mac app's own is http://127.0.0.1:43128.", "siteUrl");
    text("Key file", `Path to the AI access key (outside the vault). ${this.plugin.keyStatus()}`, "keyPath");
    text("Folder to sync", "Notes in this vault folder (and its subfolders) sync.", "folder");
    text("Status property", "Frontmatter property with the status.", "statusProperty");
    text("Media property", "Frontmatter property with the format (Reel, Carousel…).", "mediaProperty");
    text("Project ID", "Optional: the Workshop project new sessions go to.", "projectId");
    new Setting(containerEl)
      .setName("Sync every (minutes)")
      .addText((input) =>
        input.setValue(String(this.plugin.settings.syncMinutes)).onChange(async (value) => {
          this.plugin.settings.syncMinutes = Math.max(1, Number(value) || DEFAULTS.syncMinutes);
          await save();
        }),
      );
    toggle("Auto sync", "Sync on load, on the interval, and when a note's status changes.", "autoSync");
    toggle("Paused", "Nothing syncs while on. The Send button still works.", "paused");
  }
}
