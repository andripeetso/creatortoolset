# Packs

A pack is one JSON file (`*.ctpack.json`) that adds things to someone's account: storytelling frameworks, caption
styles, and instructions that go on top of the app's own AI prompts. People make them in Settings → Packs → Share
as pack, or by hand, and install them from a file in Settings → Packs → Install from file.

Code: `contracts/packs.ts` (format, checks), `api/lib/packs.ts` (install, update, remove, instructions),
`api/packs.ts` (`/api/packs`). Official packs live in `packs/`.

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
- `version`: `x.y.z`. Installing a newer file of the same pack updates it.
- `license` is required. The pack must be yours to share: no quoted books, no fonts, sounds or images you
  don't have the rights to.
- Everything else is optional, but a pack needs at least one of instructions, frameworks or caption styles.
- The format also has `designSystems` and an `editor.cards` slot, for apps that draw animated cards. This app
  accepts files that have them and leaves those parts out.

Check a file before you share it: `pnpm --filter @creator-toolset/captions pack:check my-pack.ctpack.json`.

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

The checks refuse instruction text with links, or text that tries to replace the app's instructions or asks for
keys and passwords. Nobody reviews a pack file: install packs only from people you trust.

## Install, update, remove

- Install copies the pack's frameworks and caption styles into your account, each marked with the pack and
  version. Your edits to a copy are never overwritten.
- A framework or style you already have by the same name stays yours, and the pack's copy is skipped.
- Update (installing a newer file of the same pack) replaces the copies you haven't touched, and leaves the ones
  you edited.
- Remove deletes the copies you haven't touched and keeps the ones you edited.
- Instructions can be switched off everywhere, or for one project.
