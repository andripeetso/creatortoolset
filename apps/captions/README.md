# Creator Toolset: the web app

The web app and server behind [Creator Toolset](../../README.md). One React single-page app and one Hono
server, so every tool shares a sign-in and a data folder. Each tool has its own route and its own API module.

| Route | Tool | API module |
|---|---|---|
| `/captions` | Caption Studio | `api/projects.ts`, `api/exports.ts`, `api/transcribe.ts`, `api/caption-layout.ts` |
| `/enhance` | Audio Enhancer | `api/enhance.ts` |
| `/review` | Review | `api/review.ts` |
| `/clean` | Video Cleaner | `api/clean.ts` (guide: `docs/video-cleaner/README.md`) |
| `/stories` | Story Splitter | `api/stories.ts` |
| `/video-notes` | Video Notes | `api/clips.ts` |
| `/guides` | Guide Builder | `api/documents.ts` |
| `/analyzer` | Content Analyzer | `api/instagram.ts` |
| `/workshop` | Content Workshop | `api/workshop.ts` |
| `/editor` | AI Editor | `api/editor/` |
| Settings → AI providers | AI providers | `api/providers.ts`, `api/devices.ts` |

`api/boot.ts` mounts the routes, applies the sign-in gate and the per-account tool switches, and serves the
built app. Feature notes are in `docs/features/`; the design notes for each tool are in `docs/`.

## Run it locally

Requirements: Node.js 22 or newer, pnpm 10 (from the repository root, `corepack enable`), and `ffmpeg` and `zip`
on your PATH.

```sh
pnpm install                                   # from the repository root
pnpm --filter @creator-toolset/captions dev    # http://localhost:43127
```

No `.env` is needed. With `APP_SECRET` unset, sign-in is off and everything runs as the local admin. Projects
are kept in `~/.caption-studio` (override with `DATA_DIR`).

Transcription runs on the device by default (Whisper in the browser). Add `DEEPGRAM_API_KEY` for cloud
transcription, and the AI keys for the AI-backed tools. The full list, with explanations, is in
[`.env.example`](.env.example). Copy it to `.env` and fill in only what you use.

## Run it on a server

[SELF_HOSTING.md](../../SELF_HOSTING.md) covers the whole process: the domain, the environment, the Docker kit
([`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml) and [`Caddyfile`](Caddyfile), which serves
HTTPS), the first admin account, backups and updates. Once it is running:

```sh
docker compose exec app node scripts/doctor.mjs     # checks the install and says what is missing
```

Outside Docker, the same check is `pnpm run doctor -- --url https://your.site` from this folder. (Plain
`pnpm doctor` runs pnpm's own command of that name, so use `pnpm run doctor`.)

## Accounts

Set `APP_SECRET` and the server asks for a sign-in. The owner account (`admin`, or `ADMIN_USERNAME`) is created
on first start, with `APP_SECRET` as its password; change it in Settings → Account. It is one person's server:
there is no sign-up, no invites and no user management. Production refuses to start without `APP_SECRET`.

Accounts are kept in `users.json` under `DATA_DIR`. There is no database to run.

## Scripts

```sh
pnpm dev          # dev server with hot reload (port 43127)
pnpm build        # production build: dist/public (the app) and dist/boot.js (the server)
pnpm start        # run the production build (needs APP_SECRET set for a public server)
pnpm check        # TypeScript
pnpm test         # vitest: the unit and API tests
pnpm lint         # eslint
pnpm run doctor   # check a running install (--url to choose the address)
```

`scripts/` also holds the install scripts for the native tools that the Docker image does not build
(video fingerprints, see `docs/video-fingerprints.md`), and the evaluation and benchmark scripts for the
caption and Workshop writing.

## Layout

- `src/`: the React app. `src/App.tsx` lists the routes.
- `api/`: the Hono server. `api/lib/` holds the logic shared by the routes.
- `contracts/`: types shared by the client and the server.
- `db/`: schema and seed data for the optional database tooling (not needed to run the tools).
- `public/`: static files (fonts, icons, the web app manifest, the service worker).
