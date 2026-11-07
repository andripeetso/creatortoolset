# Creator Toolset

Open-source tools for people who make video and content for a living. Caption a video, clean up and compare
cuts, get client review on a link, split a long recording into stories, record walkthroughs, write guides,
study which Instagram posts work and draft new content from them. One web app, one sign-in, and it runs on
your own machine or your own server.

Licensed under the [MIT License](LICENSE).

## The tools

| Tool | Route | What it does |
|---|---|---|
| **Caption Studio** | `/captions` | Transcribe a video, style the captions, and export transparent caption overlays (ProRes 4444, VP9 WebM or PNG sequence) plus SRT, WebVTT and ASS files. |
| **Audio Enhancer** | `/enhance` | Clean up the sound of an audio or video recording, with a before and after player. |
| **Review** | `/review` | Frame-accurate review of video cuts. Share one link; reviewers comment on exact frames, approve or ask for changes, with no account needed. Versions stack per video. |
| **Video Cleaner** | `/clean` | Edit and compare videos, measure visual similarity (PDQ, TMK, SSCD), inspect and remove metadata, and export in batches. |
| **Story Splitter** | `/stories` | Cut a video into stories of about 20 seconds and download them as one zip. |
| **Video Notes** | `/video-notes` | A library of screen and camera recordings, or uploads. With cloud transcription on, each one gets a transcript and a title. |
| **Guide Builder** | `/guides` | Put recordings and caption projects in order, have AI draft an editable page, and publish it as an unlisted link. |
| **Content Analyzer** | `/analyzer` | A private library of Instagram accounts and posts, with captions, transcripts, comments and stats, and search across all of it. |
| **Content Workshop** | `/workshop` | Turn the analyzer's library into new content: reel scripts, carousels and ad copy, written with AI in your voice and checked for accuracy against the web. |

Around the tools:

- **Team**: accounts, invite links, roles (owner, admin, member) and per-tool access. Settings → Team.
- **AI providers**: which AI each account uses. Settings → AI providers.
- **Mac app**: a native window around the same web app, with the local AI runner in the menu bar.
  See [apps/mac/README.md](apps/mac/README.md).
- **Phone app**: an iPhone app that signs in to a server of this kind exists separately; it is not in this repository.

## Your own AI

Several tools use AI: the caption timing pass, the script check, Instagram frame reading, the Workshop's
writing, and the accuracy check. Creator Toolset never comes with an AI account of its own. You bring one, in
one of two ways:

1. **Your own subscription, on your own Mac.** You install Claude Code (or Codex) on your own Mac and sign in
   to it with your own Claude (or ChatGPT) subscription. Then you install the Mac app and turn on "Use this Mac
   for my AI". The Mac app relays only your own requests, from your own account, to that tool. Nothing routes
   one person's subscription for anyone else: everyone else on the server brings their own Mac and their own
   sign-in. Settings → AI providers walks you through the install and the sign-in.
2. **Your own API key.** Add your Anthropic key in Settings → My API keys. Anthropic bills you for what you use,
   and the key answers only your own account.

There is no fallback. With no provider and no key of your own, a tool that needs AI says so; the Content Workshop
always needs your own Claude Code or Codex, and when that Mac is off or a run fails it says so too.

## Whose keys pay

Every paid service (AI, cloud transcription, audio engines, research, Apify) runs on the key of the person who
uses it: each account adds its own in **Settings → My API keys** (Apify in **Settings → Connectors**), and that
provider bills them directly. One resolver, `keyFor` in `apps/captions/api/my-keys.ts`, decides which key a call
runs on. The server's own keys (in `.env` or Settings → API keys) serve only:

- the platform admin's own work, except AI: the server's Anthropic key is never the admin's AI;
- members whose workspace the platform admin owns and who were given a monthly API budget (AI and transcripts,
  billed to that budget);
- guests and the demo account, only when an admin switches that on.

Accounts made with open sign-up (`ALLOW_SIGNUP=1`) get their own workspace and never use the server's keys.
Instagram is read only through the official logins (your own posts and their numbers) and, for other creators,
your own Apify key: the app never reads Instagram's web pages.

Without any AI, everything else still works. Captions transcribe on the device in the browser, and Review,
Video Cleaner and the rest need no AI at all.

## Run it on your machine

You need Node.js 22 or newer, [pnpm](https://pnpm.io) 10 (`corepack enable` gives you the right version), and
`ffmpeg` and `zip` on your PATH (`brew install ffmpeg zip`, or `apt install ffmpeg zip`).

```sh
git clone <this repository> creator-toolset
cd creator-toolset
pnpm install
pnpm --filter @creator-toolset/captions dev
```

Open http://localhost:43127. With no `.env` file, sign-in is off and you are the local admin. Your projects
are kept in `~/.caption-studio` (change it with `DATA_DIR`).

To run the test suites and the checks: `pnpm test` and `pnpm check`. [AGENTS.md](AGENTS.md) lists every command.

## Host it for other people

[SELF_HOSTING.md](SELF_HOSTING.md) is written for you and for an AI agent to follow: pick a server and a
domain, set the environment, start the Docker kit (the app plus Caddy for HTTPS), create the first admin
account, connect the Mac app, back up and update. `pnpm run doctor` checks a running install and tells you
what is missing.

Every setting the server reads is listed, with an explanation, in
[apps/captions/.env.example](apps/captions/.env.example).

## Repository

| Path | What |
|---|---|
| `apps/captions/` | The web app and its server (React, Vite, Hono, tRPC, TypeScript). See [its README](apps/captions/README.md). |
| `apps/mac/` | The Mac app (SwiftUI). See [its README](apps/mac/README.md). |
| `SELF_HOSTING.md` | Running a server for other people. |
| `AGENTS.md` | Rules and commands for contributors and their coding agents. |

## Contributing

Read [AGENTS.md](AGENTS.md) first. Enable the repository hooks once per clone with
`git config core.hooksPath .githooks`: they block a commit that contains a secret or a private name.

## License

[MIT](LICENSE). Copyright (c) 2026 Andri Peetso. The fonts bundled in `apps/captions/public/fonts/` are Google Fonts under the SIL Open Font License 1.1 (see `OFL.txt` there). Other third-party parts, including the GPL FFmpeg build the Docker image downloads, are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
