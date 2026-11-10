# Plug-ins

A plug-in changes Creator Toolset for one install without touching the app's own code. It is a folder with one
or two files, and it gets into the app in one of two ways:

- **The downloaded Mac app:** the folder goes in `~/Library/Application Support/Creator Toolset/plugins/<id>/` and
  the person switches it on in the app. Nothing is installed and no checkout is needed
  ([In the downloaded Mac app](#in-the-downloaded-mac-app)).
- **A checkout of this repository:** the folder is `apps/captions/plugins/<id>/` and the build compiles it in. That
  is for your own server, the Docker kit, and work on the app itself ([Make one](#make-one-in-a-checkout)). Git
  ignores that folder, so `git pull` never conflicts with it, while an edit to one of the app's own files conflicts
  with every update from then on.

The files are the same both ways. This page is for a coding AI working for the person who uses the app, and for
people who write plug-ins by hand.

## Before you write one

Work down this list and stop at the first that does the job:

1. **A setting**, or the tool's own Defaults dialog. It may already do it.
2. **A pack**: storytelling frameworks, caption styles and instructions on top of the AI prompts, as one JSON file
   with no code ([packs.md](apps/captions/docs/features/packs.md)).
3. **The person's own AI with the app's tools** (Settings → Headless access). A job the AI can do with the tools
   that exist needs no change to the app.
4. **A plug-in** (this page).
5. **A plug-in plus one new slot**, when no slot fits ([below](#when-no-slot-fits)).
6. **A fork.** Tell the person first: from then on they merge every update by hand.

## In the downloaded Mac app

The app builds a plug-in folder by itself and joins it to the app that is already running. The person installs
nothing: no Node, no pnpm, no checkout.

1. **See that the app can.** This file must exist (it does from the version that brought plug-in folders):
   `/Applications/Creator Toolset.app/Contents/Resources/server/source/scripts/plugin-build.mjs`. If it is missing,
   the app is older: the person picks Check for Updates in the app, or you use a checkout (below).
2. **Read the app's own source**, in `/Applications/Creator Toolset.app/Contents/Resources/server/source/`:
   `api/lib/plugin.ts`, `src/lib/plugin.ts`, `plugin-examples/hello` and this page. Those are the files that copy of
   the app was built from. The repository's main branch can be ahead of it.
3. **Write the folder**: `~/Library/Application Support/Creator Toolset/plugins/<id>/` with `plugin.ts`, `web.tsx`
   or both ([What it can add](#what-it-can-add)). Keep the import lines a checkout has (`../../api/lib/plugin`,
   `../../src/lib/plugin`, `@/components/ui/button`): the folder is read as if it were
   `apps/captions/plugins/<id>`.
4. **Check it.** This prints `ok`, or what is wrong, and runs nothing of the plug-in:

   ```sh
   APP="/Applications/Creator Toolset.app/Contents/Resources/server"
   "$APP/bin/node" "$APP/source/scripts/plugin-build.mjs" check "$HOME/Library/Application Support/Creator Toolset/plugins/<id>"
   ```
5. **Tell the person to switch it on**: the account menu → Community → Installed → Plug-ins, the switch on its
   row. The app asks them in its own dialog and then restarts its server. Only they can do this. No file, setting
   or tool switches a plug-in on, so don't look for one.
6. **After you change the folder**, its row says Changed, and Use the new version takes it. Until then the copy
   they switched on keeps running.

What is different from a checkout:

- **Imports:** the app's own files, and the packages the app itself uses. There is no `npm install` for a plug-in;
  the check names an import the app doesn't have. Anything else runs as its own program beside the app.
- **No type-checking.** The check finds syntax errors, missing files and packages, and names that are taken. A type
  mistake shows when the code runs. For `pnpm check`, use a checkout.
- **Not there:** `?url` imports, web workers and `import.meta.glob` in `web.tsx`; `env: […]` names with a `.env`
  file (keep a plug-in's own settings in its Settings section, saved under its data folder); a `site`.
- **When it fails**, the app starts without it and its row says why: it doesn't build, it throws while loading,
  it uses a name another plug-in has, or it stopped the app's server. A page that throws while it is drawn shows
  one line in its place. `~/Library/Logs/Creator Toolset Server.log` has the `[plugins]` lines.
- **Updates:** the app updates itself and the folder stays. When the app changed something the plug-in imports,
  the row says what is missing; fix the folder and they take the new version.

## Make one in a checkout

```sh
cd apps/captions
mkdir -p plugins && cp -R plugin-examples/hello plugins/sponsors   # then change every "hello" inside to your id
pnpm dev                                                           # http://localhost:43127, with the plug-in loaded
```

A plug-in has one or both of these files, and any other files beside them:

| File | Runs | Starts with |
|---|---|---|
| `plugin.ts` | on the server | `export default definePlugin({ id: "sponsors", … })` from `../../api/lib/plugin` |
| `web.tsx` | in the browser | `export default defineWebPlugin({ id: "sponsors", … })` from `../../src/lib/plugin` |

- The id is lowercase letters, digits and dashes, the same in both files. Write it as a plain string, and keep it
  the first `id: "…"` in each file: the build reads it from the text.
- Give `name` and `about` (one line) in both files. Community → Installed lists the plug-in under them.
- With no `CT_PLUGINS` set, every folder in `plugins/` is loaded. `CT_PLUGINS=a,b` loads only those.
- `scripts/plugins.mjs` runs before `dev`, `build`, `check` and `test` and writes the two lists the app imports
  (`api/plugins.gen.ts`, `src/plugins.gen.ts`). Never edit those.

## What it can add

| You want | Field | File |
|---|---|---|
| A page of your own | `routes: [{ path, element }]` | `web.tsx` |
| A tile on Home, in Plan, Make, Distribute or Tools | `tiles` | `web.tsx` |
| A section in Settings | `settings` | `web.tsx` |
| An item in the account menu | `accountMenu` | `web.tsx` |
| A button on a Workshop session, a review upload, an export or a library item | `itemActions` | `web.tsx` |
| Panels and toolbar buttons in Review | `review` | `web.tsx` |
| Your page in place of a built-in one (AI Editor, Media Library, Finals, Settings → Storage) | `replaces` | `web.tsx` |
| An API of its own, at `/api/x/<id>/…` behind the app's login | `routes` (a Hono app) | `plugin.ts` |
| A tool the person's own AI can call | `tools: { defs, handlers }` | `plugin.ts` |
| A switch per account for the whole plug-in | `gates`, `requireGate(id)` on its routes, `gate` on its tile | both |
| Something done each time a session is published or changes status, an export finishes or a review gets a new version | `onEvent(name, fn)` from `api/lib/events.ts`, called in `start` | `plugin.ts` |
| Work that starts with the server | `start` | `plugin.ts` |
| Media Library sources, filters and badges | `library` | both |
| AI provider kinds and presets | `providers` | `plugin.ts` |
| Rows and menu items in the Mac app's menu bar | `activity`, `menu` | `plugin.ts` |

A page, a tile, an API and a tool together make a whole new tool in the app. `plugin-examples/hello` has one of
each, and a test.

The full list is two interfaces: `ServerPlugin` in `apps/captions/api/lib/plugin.ts` and `WebPlugin` in
`apps/captions/src/lib/plugin.ts`. Each field has a comment saying what it does and where the app reads it. Read
both before you decide a slot is missing.

## Rules

- **It is code with the whole server's access**: every account's data and keys on that install. In the Mac app
  that is the person's own files, their saved keys, the internet, and what macOS has allowed the app. The switch
  is their consent, not a cage. Install a plug-in only from someone you trust, and read it first, or have your AI
  read it.
- **The app's own rules still hold** ([AGENTS.md](AGENTS.md)): a paid service is called with the key from `keyFor`,
  social platforms are read only through the official logins and the person's own Apify key, and one account never
  reaches another account's data or AI.
- **Packages:** import only what `apps/captions/package.json` already has. Anything else runs as its own program
  beside the app, and the plug-in calls it.
- **Settings it needs:** list the names in `env: […]`, put the values in `apps/captions/.env`, and read them with
  `process.env` where they are used. The build reports any that are unset. No keys in the code.
- **Its files:** under `path.join(env.dataDir, "plugins", "<id>")` (`env` from `api/lib/env.ts`), per account by
  `c.get("user").username`.
- **Where its pieces go:** where the built-in ones are. A choice about how the app is set up is a Settings section,
  a tool is a Home tile and a page. Settings sections use the kit in `src/components/settings/ui.tsx`.
- **Names that are taken:** a page path of a built-in page, a tool name the app already serves, and a gate id that
  is a built-in app are refused, by the build or when the server starts, with a message naming the plug-in.

## Check it

- `pnpm check` type-checks `plugin.ts`, `web.tsx` and everything they import.
- Tests: the app's own `pnpm test` doesn't look in `plugins/`. The example brings a test and the small
  `vitest.config.ts` that runs it, so a copy has both: `pnpm exec vitest run --root plugins/<id>`.
- Open the app: the account menu → Community → Installed lists the plug-in and what it adds.
- A tool: connect your AI in Settings → Headless access and ask it to list its Creator Toolset tools.

## Run it for real

- **From this checkout:** `pnpm dev` while you work. `pnpm build` makes the production server, plug-ins included.
- **On your own server:** the Docker kit builds its image from the checkout, with the `plugins/` folder in it:
  `docker compose up -d --build` ([SELF_HOSTING.md](SELF_HOSTING.md)).
- **In the Mac app:** put the folder in the app's plug-ins folder and switch it on
  ([In the downloaded Mac app](#in-the-downloaded-mac-app)). Only the server the Mac app runs on that Mac reads a
  plug-ins folder; a server you host for other people takes plug-ins from its build alone.

## Keep it and share it

- **Updates:** `git pull`, `pnpm install`, `pnpm check`. Your folder is untouched. When the app changed something
  the plug-in imports, `pnpm check` names the line.
- **Sharing:** a plug-in is a folder. Put it in its own git repository. Someone else puts it in their Mac app's
  plug-ins folder and switches it on themselves, or clones it into `apps/captions/plugins/<id>` of their checkout.

## When no slot fits

Add the smallest slot to the app, and keep everything else in the plug-in:

1. One optional field on `ServerPlugin` or `WebPlugin`, with a comment saying what it does and where it is read.
2. One function next to it that the app calls at one place (`pluginEditFlags`, `itemActionsFor` and
   `replacementFor` are the pattern). With no plug-in setting the field, the app behaves exactly as before.
3. A test beside it, and a line in `describeServerPlugins` or `webPluginAdds` so Community lists what the plug-in
   adds.
4. Open a pull request with the slot alone. Once it is merged, the person carries no change to the app's own code.
