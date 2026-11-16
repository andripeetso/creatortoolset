import { str, type ToolModule } from "./types";

/**
 * Looking inside a folder on the person's computer, subfolders too (api/assistant.ts POST /folder-list walks it there,
 * or has a Mac of theirs walk it). For the app's own assistant only: which folders it may look in follows the chat.
 */
export const foldersTools: ToolModule = {
  defs: [
    {
      name: "folder_list",
      description:
        "Look inside a folder on the user's computer, its subfolders too (up to 6 levels): each entry's path inside it, file or folder, kind (video, audio, image, doc), size and, for media, its length when known. match = words that must all be in an entry's path or kind (\"song\" finds audio files, \"music\" the files in a MUSIC folder). Use it before saying a file is not there or asking what it is called. path = one of this workspace's folders (Settings → Folders), a folder the user dropped or named in this chat, or one inside those; never a whole disk or home folder. Works where the server runs on that computer and through a paired Mac.",
      inputSchema: { type: "object", properties: { path: str, depth: { type: "integer" }, match: str }, required: ["path"] },
      dockOnly: true,
    },
  ],
  handlers: {
    folder_list: (a, ctx) => ctx.json("/api/assistant/folder-list", "POST", { path: a.path, depth: a.depth, match: a.match }),
  },
  steps: { folder_list: "Looking in your folder" },
};
