# Creator Toolset for Obsidian

Desktop only. Links the notes in one vault folder with the Content Workshop on your Creator Toolset server (by default the Mac app's own, `http://127.0.0.1:43128`): a note becomes a session, its status stays in step both ways, and the Workshop's Obsidian exports land in the vault.

## Install

```sh
cd apps/obsidian && npm ci && npm run build
```

Copy `manifest.json` and `main.js` to `<vault>/.obsidian/plugins/creator-toolset/`, then in Obsidian: Settings → Community plugins → enable **Creator Toolset**.

## The key

The plugin signs in with an AI access key with Full access, made in Creator Toolset's settings. Save it in a file outside the vault (a vault is often synced or kept in git):

```sh
mkdir -p ~/.config/creator-toolset
pbpaste > ~/.config/creator-toolset/key && chmod 600 ~/.config/creator-toolset/key   # copy the key first
```

The key file path is a setting. The key is read from the file on each sync and is never saved in the plugin's data.

## What syncs

- **Notes in the folder** (and its subfolders). A note with a status of Filming, Editing or Ready is sent on its own, with its title, status, format, details and body, and the site creates a session for it. Notes in other statuses (Idea, Writing, Published, Shelved…) are sent only once they are linked: when Send was used for them, or when the site already has a session for them.
- **Status, both ways.** A change made on either side comes to the other; the later change wins. The plugin writes only the status property and `change` (the date) into the note. Note bodies are never changed by a sync.
- **Exports.** Obsidian exports queued in the Workshop are written at their paths (folders created). If the file was changed by hand, the export goes to `<name> (2).md` instead.
- **Send to Creator Toolset** (ribbon icon or command): sends the open note as a new session, or re-opens its session, and opens it in the Mac app (`creatortoolset://workshop/sessions/<id>`).

## What does not sync

- Notes outside the folder, and notes in the folder that are Idea, Writing or Shelved and not linked.
- Renamed or moved notes: a link is by path, so a moved note is a new note.
- The Workshop's text is not written back into your notes, except new exports.

## Settings

Server address, key file, folder, status and media property names, **Statuses that sync on their own** (comma-separated; default `Filming, Editing, Ready`, the site's labels; a vault with its own labels lists them here, e.g. `🎥 Filming, ✂️ Editing, 👍 Ready`), project id, sync interval (default 5 minutes), auto sync, and **Paused** (nothing syncs; Send still works). A note with no status is sent as `Idea`.

Plugin data (`data.json`) holds the settings and the last sync time. The list of which notes were sent is kept on this device, not in the vault.
