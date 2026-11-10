# Plug-ins

A plug-in changes Creator Toolset for one install without touching the app's own code. It is a folder,
`apps/captions/plugins/<id>/`, that the build finds and compiles in. Git ignores that folder, so `git pull` never
conflicts with it, while an edit to one of the app's own files conflicts with every update from then on.

This page is for a coding AI working in a checkout of this repository for the person who uses the app, and for
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

## Make one

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

- **It is code with the whole server's access**: every account's data and keys on that install. Install a plug-in
  only from someone you trust, and read it first, or have your AI read it.
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
- **In the Mac app:** the downloaded app runs the server it was released with, which has no plug-ins, and one
  can't be added to it. Run your server from this checkout and add its address (`http://localhost:43127`) in the
  app's Servers list. That server has its own data folder (`~/.caption-studio`, or `DATA_DIR`), not the downloaded
  app's, so it starts without the projects made there.

## Keep it and share it

- **Updates:** `git pull`, `pnpm install`, `pnpm check`. Your folder is untouched. When the app changed something
  the plug-in imports, `pnpm check` names the line.
- **Sharing:** a plug-in is a folder. Put it in its own git repository, and someone else clones it into
  `apps/captions/plugins/<id>` of their checkout.

## When no slot fits

Add the smallest slot to the app, and keep everything else in the plug-in:

1. One optional field on `ServerPlugin` or `WebPlugin`, with a comment saying what it does and where it is read.
2. One function next to it that the app calls at one place (`pluginEditFlags`, `itemActionsFor` and
   `replacementFor` are the pattern). With no plug-in setting the field, the app behaves exactly as before.
3. A test beside it, and a line in `describeServerPlugins` or `webPluginAdds` so Community lists what the plug-in
   adds.
4. Open a pull request with the slot alone. Once it is merged, the person carries no change to the app's own code.
