# Packs

A pack is one JSON file (`*.ctpack.json`) that adds things to someone's account: storytelling frameworks, caption
styles, instructions that go on top of the app's own AI prompts, and a Home layout. People make them with Publish to
Community on one of their own frameworks or caption styles, or on Settings → Tools, or by hand, and install them from Community (the account menu, top
right). A pack file installs through the API (`POST /api/packs/install`).

Code: `contracts/packs.ts` (format, checks), `api/lib/packs.ts` (install, update, remove, instructions, default
packs), `api/packs.ts` (`/api/packs`), `api/pack-catalog.ts` (`/api/pack-catalog`, the community catalog's read
side). Official packs live in `packs/`.

## The file

```json
{
  "format": 1,
  "id": "punchy-hooks",
  "name": "Punchy Hooks",
  "version": "1.0.0",
  "author": "Tiny Acrobatics",
  "license": "CC-BY-4.0",
  "description": "Short hooks for fitness reels.",
  "niche": "fitness",
  "instructions": { "workshop.write": "Open on the result, then show the work." },
  "frameworks": [
    { "name": "Result First", "role": "narrative", "summary": "Show the end, then how.",
      "steps": ["The result", "How you got there"], "whenToUse": "Transformations." }
  ],
  "captionStyles": [{ "name": "Gym Bold", "kind": "caption", "style": { "fontSize": 72 } }]
}
```

- `id`: lowercase letters, digits, dashes.
- `version`: `x.y.z`. Installing a newer file of the same pack updates it, and Installed offers the update when the
  catalog lists a newer version.
- `license` is required. The pack must be yours to share: no quoted books, no fonts, sounds or images you
  don't have the rights to.
- Everything else is optional, but a pack needs at least one of instructions, frameworks, caption styles, a Home
  layout or editor items.
- A caption style's values are plain: text of one line, numbers, on/off.
- The format also has `designSystems` and an `editor.cards` slot, for apps that draw animated cards. This app
  accepts files that have them and leaves those parts out.

Check a file before you share it: `pnpm --filter @creator-toolset/captions pack:check my-pack.ctpack.json`.

## Home layout

`"home": { "hidden": ["clean", "stories"] }`: the tiles switched off under Settings → Tools, by the app's own ids
(`HOME_TILES` in `contracts/tools.ts`); every other tile shows. It is a list of choices from that list and nothing
else: an id the app doesn't have is dropped, and it can't add a tile, name a page or change who may open a tool.
Installing or updating a pack never changes Home. The installed pack has a **Use on Home** button; pressing it sets
the person's own switches, which stay theirs to change.

## Editor items

A pack can carry items the AI editor uses. All are data only (level 0):

- `grades`: ASC CDL colour grades (`slope`, `offset`, `power`, `saturation`), one per name.
- `voiceMixes`: loudness targets for the voice (`voiceLufs`, and `bedLufs` for a music bed under it) and the
  enhancer (`off`, `nvidia` or `elevenlabs`, run with the person's own key).
- `sfxSets`: a sound library listed by id, category and title. Each set needs its `license`. The files are not in
  the pack.
- `resolve`: a DaVinci Resolve bridge a device may switch on. Recorded only for now.
- `editorDefaults`: per slot (`designSystem`, `grade`, `voiceMix`, `sfxSet`), the name of one item in this pack that
  the editor uses when the person chooses nothing.
- `permissions`: what the items need (`grade`, `voice`, `sfx`, `resolve`, `motion-kit`). It is worked out from the
  items; a list you write must include each one the pack uses.

## Instructions and slots

A pack's instructions are added to one prompt, named by its slot:

| Slot | Where |
|---|---|
| `workshop.write` | Content Workshop: writing and editing pieces |
| `workshop.review` | Content Workshop: the follower read and the fact check |
| `analyzer.ideas` | Content Analyzer: ideas and tags from posts |
| `captions.lines` | Caption Studio: where captions break into lines |
| `editor.script` | AI Editor: the script |

They go after the app's own prompt and before the person's own rules and notes, labelled with the pack's name.
Where they disagree, the person wins. Each slot takes up to 2,000 characters. Safety checks and access are never
slots, and a pack can't give the AI a tool, a key or a permission.

A pack can also carry up to 8 `skills`, each `{ "slot", "name", "when"?, "text" }` with up to 4,000 characters of
text, for `workshop.review`, `analyzer.ideas`, `captions.lines` or `editor.script`. Never the assistant and never
`workshop.write`: those take only the person's own skills. Each shows in Community → Skills under its place with its
own switch; an `editor.script` skill reaches an edit only when the edit's editing style names it.

The checks refuse instruction and skill text with links, or text that tries to replace the app's instructions or asks for
keys and passwords. Nobody reviews a pack file: install packs only from people you trust. Packs in the community
catalog were reviewed before they were listed.

## Install, update, remove

- Install copies the pack's frameworks and caption styles into your account, each marked with the pack and
  version. Your edits to a copy are never overwritten.
- A framework or style you already have by the same name stays yours, and the pack's copy is skipped.
- Update (installing a newer file of the same pack) replaces the copies you haven't touched, and leaves the ones
  you edited.
- Remove deletes the copies you haven't touched and keeps the ones you edited.
- Instructions can be switched off everywhere, or for one project.
- A pack reaches every project, or only the projects you tick (Community → Installed, or when installing).

## Default packs

Five of the team's packs are installed for every account: Writing basics, Editing basics, Analyzer basics,
Caption styles and Storytelling frameworks. The last one copies nothing: it only links the Workshop's starter
frameworks you already have. Accounts made before packs existed get them switched off, so nothing changes for them
unasked.
Switch a default off, or remove it, to use a community pack instead. A removed default doesn't come back.

## The community catalog

Community reads the shared catalog at `PACK_CATALOG_URL` (https://creatortoolset.com unless set),
like a plugin directory: Explore, a section per place a pack works (writing frameworks, writing guides, caption
styles, editing styles, analyzer guides), search, a page per pack with what it adds, install it. Installed packs get update notices from it, and
a pack the catalog pulls is flagged and its instructions stop being used. This server keeps no catalog of its
own. Set `PACK_CATALOG_URL` to an empty value to turn the catalog off.

What people share in Community has no code. A pack from the catalog that carries drawing code (a design system's
motion kit) is refused on install, whatever the catalog lists (`api/pack-catalog.ts`).

## What may go in a pack

- Your own words. Name a framework's originator, but write the summary, steps and example yourself.
- Nothing from books, courses or other people's posts, and nothing from your Knowledge.
- Trademarked names only as a description, never as the pack's id or author.
- No fonts, images or sound files yet. Those need a licence check per file. A sound set names its sounds and licence only.

## Publishing

Publish to Community sits on each of your own Workshop frameworks and caption styles, and on Settings → Tools for
your Home layout. Once you've ticked that it's
yours to share, the app builds the pack and checks it, then points you to the catalog's site: download the file and
send it there. It runs the same checks, then waits for a person to review
it. Once approved, it's listed.
