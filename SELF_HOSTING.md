# Self-hosting Creator Toolset

This guide sets up one Creator Toolset server for you and your team: the app in Docker, HTTPS on your own
domain, your admin account, optional storage in an S3-compatible bucket, and the Mac app on your Mac for AI.
It is written to be followed top to bottom, by you or by an AI agent working for you. Each step ends with a
check. If a check fails, fix that before going on.

Ground rules for whoever runs it:

- Secrets (`APP_SECRET`, API keys, bucket keys) go into `.env` on the server, never into chat, a commit, a
  ticket or a screenshot. Generate `APP_SECRET` on the server. Ask the person to paste their own provider keys
  into `.env` themselves.
- Commands run on the server unless a step says "on your Mac".
- Ask before deleting anything. Deleting a Docker volume deletes the projects, the accounts and the videos in it.

## 0. What you get

- The web app and its server, in one container, behind Caddy, which obtains and renews the HTTPS certificate
  for your domain.
- Your accounts: one admin (you) and as many members as you invite.
- Your data on the server's disk, or in a private S3-compatible bucket you own.
- AI from your own subscription: you install Claude Code (or Codex) on your own Mac and sign in with your own
  subscription; the Mac app relays only your own requests to it. Each member does the same on their own Mac.
  You can also add your own API key on the server.
- The web app works on phones: open it in the phone's browser and add it to the home screen.

This repository does not include an iPhone app.

## 1. Choose the server and the domain

Requirements:

- **Linux on x86_64 (amd64).** The Docker image installs a pinned x86_64 FFmpeg build and refuses to build
  elsewhere. Check with `uname -m`, which must print `x86_64`.
- **Resources.** Exports, enhancement and transcoding are CPU and memory heavy. Start with 4 vCPU and 8 GB of
  RAM, and add disk for your videos (or use a bucket, step 5).
- **Public address and open ports.** Ports 80 and 443 must reach the server. Port 80 is needed for the
  certificate.
- **A domain you control.** Use a name such as `tools.example.com`.
- **Docker Engine** with **Docker Compose v2.24 or newer** (`docker compose version`).

Create a DNS **A record** for the name, pointing at the server's public IPv4 address. Wait for it to resolve:

```sh
dig +short tools.example.com        # must print the server's address
```

Caddy cannot get a certificate until this matches. Allow a few minutes after you change DNS.

Check: the address printed is the server's, and `uname -m` prints `x86_64`.

## 2. Install Docker and get the code

On Debian or Ubuntu, follow Docker's own instructions for the Engine and the Compose plugin
(docs.docker.com/engine/install). Then:

```sh
docker --version && docker compose version
sudo mkdir -p /opt && sudo chown "$USER" /opt
git clone <this repository> /opt/creator-toolset
cd /opt/creator-toolset/apps/captions
```

Check: both version commands print, and the last command leaves you in `apps/captions`. Every later step runs
from that folder.

## 3. Write `.env`

```sh
cp .env.example .env
chmod 600 .env
```

Set these in `.env` (edit the file, or use `sed`):

- `DOMAIN`: the name from step 1, e.g. `tools.example.com`. No `https://`.
- `APP_SECRET`: a long random value, generated on the server. It is the sign-in secret, and the first admin's
  password. Changing it signs everyone out. Generate and write it without printing it:

  ```sh
  sed -i "s|^APP_SECRET=.*|APP_SECRET=$(openssl rand -base64 32)|" .env
  ```

- `ADMIN_USERNAME`: optional. Leave it empty for `admin`.

Optional, now or later (see step 4 and `.env.example` for every variable):

- `ANTHROPIC_API_KEY`: an API key for the team's API budget (step 8).
- `DEEPGRAM_API_KEY`: cloud transcription.
- `ELEVENLABS_API_KEY`, `NVIDIA_API_KEY`: the Audio Enhancer's engines.
- `PERPLEXITY_API_KEY`: the Content Workshop's accuracy check.
- `OBJECT_STORAGE_*`: a private bucket for uploads (step 5).
- `COOKIE_DOMAIN`: only if several subdomains of one server share the sign-in, e.g. `.example.com`. Empty = the exact host.

Leave everything else empty. An empty value switches that feature off.

Check: `grep -c '^APP_SECRET=.\{16,\}' .env` prints `1`, and `DOMAIN` is set. Do not print the file in full:
it contains secrets.

## 4. Decide where the videos live

Pick one.

**A. The server's disk (the default).** Projects, Review videos and exports go to the Docker volume
`creator-toolset_caption-data`. Make sure the disk has room for your footage and the copies the app keeps.

**B. A private S3-compatible bucket.** Works with AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO and
similar. The browser uploads straight to the bucket, so the server never carries the video bytes. In the
provider's console:

1. Create a bucket that is **private** (no public access).
2. Create a key that can read and write only that bucket.
3. Set the bucket's CORS rules to allow `PUT`, `GET` and `HEAD` from `https://tools.example.com` (your exact
   address), and to expose the `ETag` response header. Uploads are multipart and need it.
4. In `.env`, set `OBJECT_STORAGE_ENDPOINT` (the provider's S3 endpoint URL), `OBJECT_STORAGE_REGION` (if the
   provider names one), `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ACCESS_KEY` and `OBJECT_STORAGE_SECRET_KEY`.
   Set `OBJECT_STORAGE_FORCE_PATH_STYLE=true` only if the provider requires path-style URLs (MinIO often does).

Set all four required values, or none. The doctor (step 6) tests the bucket with a small file and removes it.

**Media Library buckets.** Each library keeps its files on the server's disk unless its owner picks a bucket in the
library's storage settings: the library's own (its endpoint, bucket and keys are typed there) or one the server
offers. To offer one, set `LIBRARY_S3_BUCKET` (plus `LIBRARY_S3_ENDPOINT` and `LIBRARY_S3_REGION` as above) in `.env`,
and its two keys there or in Settings → API keys. Videos play from a 15-minute signed link, so the bucket's CORS rules
need `GET` from your address. The settings show how much each bucket library holds, day by day.

## 5. Start it

```sh
docker compose up -d --build
docker compose ps
```

The first build takes a long time: it downloads Chromium and FFmpeg and installs the dependencies. Later
builds are faster. Wait until `app` and `caddy` both show `running`.

```sh
docker compose logs --tail=50 app
curl -fsS https://tools.example.com/api/health
```

The health call must print `{"ok":true,...}`. If it does not, read the logs of `caddy` (certificate problems)
and `app` (startup problems: a missing `APP_SECRET` stops the app on purpose).

## 6. Check the install

```sh
docker compose exec app node scripts/doctor.mjs
```

The doctor checks, in order: the server answers, sign-in is on, the data folder is writable, FFmpeg runs,
storage works (if you set a bucket), and each AI key you set is accepted. It prints `ok`, `warn`, `skip` or
`FAIL` for each. Fix every `FAIL`. A `warn` is worth reading. A `skip` means the feature is off, or the check
cannot run from the server (AI on a Mac is checked in the app).

Run it again after each change to `.env`: `docker compose up -d` applies the change.

## 7. Create your admin account

1. Open `https://tools.example.com` in a browser.
2. Sign in as `admin` (or your `ADMIN_USERNAME`), with `APP_SECRET` as the password. The account was created on
   first start.
3. Open **Users** in the header and set a new password for this account. The password is then no longer the
   secret that signs the sign-in cookies.
4. Keep `APP_SECRET` in a password manager. You need it to run the server.

Invite members from **Settings → Team**. An invite link makes a new account, or joins the account that is
signed in there. Give each member the tools they need in the Users panel: switch off the ones they should not
use.

To let anyone create an account from the sign-in screen, set `ALLOW_SIGNUP=1` in `.env` (off by default). Each
new account gets a free workspace of its own and a short setup: a first project, then their own AI, their own
Instagram login and Apify key, and their own API keys. Your server's keys never serve these accounts.
Sign-ups are limited to 5 per address an hour. Behind your own proxy (not the Docker kit, which sets it), set
`TRUST_PROXY=1` so the limit counts the caller's address rather than the proxy's.

## 8. Connect AI

Creator Toolset never sends AI work to an account it does not belong to. There are two kinds of AI:

**Your own subscription, on your own Mac (recommended).** Each person installs Claude Code (or Codex) on their
own Mac and signs in with their own Claude (or ChatGPT) subscription. The Mac app relays only that person's own
requests to it; nothing routes one person's subscription for another person.

On your Mac:

1. Build or install the Mac app. From a checkout of this repository: `pnpm build:mac`, then open
   `apps/mac/build/Creator Toolset.app`. A build you make yourself runs only on your Mac. For other Macs,
   see `apps/mac/README.md` on signing and notarizing.
2. Point it at your server: **Mac settings…** in the menu bar, then the site address `https://tools.example.com`.
   Or, in Terminal: `defaults write com.creatortoolset.mac siteAddress https://tools.example.com`, then reopen the app.
3. Sign in to the site in the app's window.
4. Turn on **Use this Mac for my AI**. This pairs the Mac with your account once.
5. In the site: **Settings → AI providers → Set up your AI** shows the install and sign-in commands for Claude
   Code and Codex. Run them once in Terminal on that Mac, then press **check**.

**Your own API key on the server (for your work, and a budget you choose to give).** Set `ANTHROPIC_API_KEY` in `.env` and run
`docker compose up -d`. Members who have no AI of their own can then use a monthly budget. In
**Settings → Team** you set each member's AI route (their own Mac, or the budget) and the budget in dollars.
A budget only works when the key is set.

Check: **Settings → AI providers** shows your Mac as online with a tool installed, and a test call passes. The
doctor's `Anthropic` line is `ok` when the key is accepted.

Rules to keep:

- A person's Mac and login serve that person. Do not share one Mac or one subscription with another person.
- Do not put a subscription login in a shared place. Use a budget for members.

## 9. Backups

Two things need backing up: the server's data volume, and (if you use one) your bucket.

The data volume holds the account file, the team settings, the projects, the exports and, with option A in
step 4, the videos. Back it up while the app is stopped, so the files are consistent:

```sh
cd /opt/creator-toolset/apps/captions
mkdir -p /opt/backups
docker compose stop app
docker run --rm \
  -v creator-toolset_caption-data:/data:ro \
  -v /opt/backups:/backup \
  alpine tar czf "/backup/data-$(date +%F).tgz" -C /data .
docker compose start app
```

Then copy the archive off the server (another machine, or a backup service): a backup on the same disk is lost
with the disk. Keep a copy of `.env` too, somewhere secure. It holds `APP_SECRET`.

Restore (stop the app first, and only into an empty volume you mean to replace):

```sh
docker compose stop app
docker run --rm -v creator-toolset_caption-data:/data -v /opt/backups:/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/data-YYYY-MM-DD.tgz -C /data'
docker compose start app
```

For a bucket, use the provider's own versioning or backup feature.

Check the backup: `tar tzf /opt/backups/data-*.tgz | head` lists files, and the doctor passes after a restore.

## 10. Update

```sh
cd /opt/creator-toolset
git pull
cd apps/captions
docker compose up -d --build
docker compose exec app node scripts/doctor.mjs
```

Read what is coming before you update: `git fetch && git log --oneline HEAD..origin/main` lists the new commits.
Back up first (step 9). To go back, check out the previous commit and run the same `up -d --build`.

## 11. When something is wrong

- **The certificate does not appear, or the browser warns.** DNS must point at the server, and ports 80 and 443
  must be open to the internet. `docker compose logs caddy` says why.
- **`APP_SECRET is required in production`.** `.env` is missing the value, or the file is not in
  `apps/captions`. Compose reads `.env` from the folder that holds `docker-compose.yml`.
- **Uploads fail or stall.** With a bucket: check the CORS rules (step 4) and the doctor's storage line. Without
  one: check the disk's free space.
- **Exports fail.** Read `docker compose logs app` around the failure. Exports need memory and `/dev/shm`
  (the compose file sets 1 GB) and the FFmpeg the image installs.
- **The Mac says it cannot reach the site.** Check the address in the Mac settings, and that the site opens in a
  browser on that Mac. The Mac app's own log is in `~/Library/Logs/Creator Toolset.log` (menu bar: Open app log).
- **Something else.** Run the doctor and send its output with `docker compose logs --tail=200 app` to whoever
  maintains the server. Remove secrets from the output first.

## 12. Limits and what is not in the kit

- The Docker image is for x86_64 Linux only.
- The native video fingerprint tools (Video Cleaner's PDQ, TMK and SSCD) are not built into the image.
  See `docs/video-fingerprints.md` in `apps/captions`.
- There is no database server to run. Accounts and team settings are files under the data volume.
- Keep the server patched (`apt upgrade`, Docker updates), and keep SSH on keys only.
