# Self-host the Connect relay

The Connect relay is a small broker. It records which account owns which computer, creates a Cloudflare Tunnel and
a DNS name for each computer, issues short tickets that let a signed-in browser ask a computer for a session, and
enforces the computer limit. It never carries content. Your files, sessions and AI keys go from the browser to the
computer's own tunnel hostname, and never pass through the broker.

This guide runs your own broker on a Linux server, with your own Cloudflare zone and your own account. Follow it top
to bottom. Each step ends with a check. If a check fails, fix it before going on.

## 0. What you need

- A Linux server with a public address and Docker Engine, or Node.js 22.13 or newer if you run it
  without Docker. The broker is light: it keeps a SQLite file and makes a few Cloudflare calls per link.
- A domain on Cloudflare, with its DNS managed by Cloudflare, for the broker (`example.com` below), and a second
  zone on Cloudflare used only for the computers' names (`example-tunnels.com` below).
- A public HTTPS name for the broker, for example `connect.example.com`, reaching the server on port 443. A reverse
  proxy such as Caddy does the certificate.
- A site that signs your users in (see §4). The broker has no sign-in page of its own.

**Check the terms first.** Cloudflare's self-serve terms limit how much video and photo traffic may use its network.
Computers send their traffic through Cloudflare Tunnel, so read those terms for your use before you rely on the
broker for video. This guide does not give that answer; you must check it for your own use.

## 1. Cloudflare: zone, tunnel hostnames and a token

Each computer gets its own name under a tunnel domain in your zone, such as `<computer-id>.example-tunnels.com`. The
broker creates that name when a computer links and deletes it when the computer unlinks. It adds and removes only
those per-computer records.

1. Pick the tunnel domain: a zone of its own on Cloudflare, for example `example-tunnels.com`. Cloudflare's free
   certificate covers its first-level names, which is what each computer gets (see §4).
2. Copy the **Account ID** (Cloudflare dashboard, right sidebar of any account page) and the **Zone ID** of
   `example-tunnels.com` (Overview page of the zone).
3. Create an API token at **My Profile → API Tokens → Create Token → Custom token** with two permissions:
   - **Account → Cloudflare Tunnel → Edit**, for your account.
   - **Zone → DNS → Edit**, limited to the zone `example-tunnels.com` only.

   Do not reuse a token that has other access. This one can create tunnels and DNS records and nothing more.

Check: `curl -s -H "Authorization: Bearer <token>" https://api.cloudflare.com/client/v4/user/tokens/verify` returns
`"status": "active"`.

## 2. Get the code and write the settings

On the server:

```sh
git clone <this repository> creator-toolset
cd creator-toolset
cp apps/relay/.env.example apps/relay/.env
chmod 600 apps/relay/.env
```

Fill in `apps/relay/.env`:

| Setting | What to put |
|---|---|
| `RELAY_ACCOUNT_SECRET` | 32 or more random bytes, for example `openssl rand -base64 48`. Your sign-in site uses the same value (§4) |
| `RELAY_PUBLIC_URL` | `https://connect.example.com`. The approve page is `<this>/connect` |
| `RELAY_TUNNEL_DOMAIN` | `example-tunnels.com` |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN` | from §1 |
| `RELAY_SIGNING_KEY` | leave empty: the broker makes an Ed25519 key on first start and keeps it in the data folder |
| `RELAY_FREE_LIMIT` | computers linked per account; the default is 3 |
| `RELAY_REAP_DRY_RUN` | keep `1` for now (see §6) |

Never commit `.env`. `apps/relay/.gitignore` already lists it.

**Running in Docker:** the image sets `RELAY_DATA_DIR=/data` and `RELAY_LISTEN_HOST=0.0.0.0` itself. Delete the
`RELAY_DATA_DIR` and `RELAY_LISTEN_HOST` lines from `.env` before the next step. If they stay, the container uses
the `.env` values instead: a `./data` folder that does not exist in the image, and a listen address the port mapping
cannot reach.

Check: `grep -c '^CLOUDFLARE_API_TOKEN=.' apps/relay/.env` prints `1`, and the file is not in `git status`.

## 3. Start the broker

With Docker, from the repository root:

```sh
docker build -f apps/relay/Dockerfile -t creatortoolset-relay .
docker run -d --name creatortoolset-relay --restart unless-stopped \
  --env-file apps/relay/.env \
  -v relay-data:/data \
  -p 127.0.0.1:44610:44610 \
  creatortoolset-relay
```

The port is published on `127.0.0.1` only. The proxy in front of it is the only way in.

Without Docker, from `apps/relay`, with the variables exported from `.env` (for example `set -a; . ./.env; set +a`):

```sh
node --experimental-strip-types --no-warnings src/main.ts
```

Without Docker, leave `RELAY_DATA_DIR` as a folder you own, such as `./data`, and keep `RELAY_LISTEN_HOST=127.0.0.1`.

The HTTPS name goes through a reverse proxy. With Caddy:

```
connect.example.com {
	reverse_proxy 127.0.0.1:44610
}
```

Check on the server, then from your own computer:

```sh
curl -fsS http://127.0.0.1:44610/healthz                 # ok
curl -fsS https://connect.example.com/healthz            # ok
curl -fsS https://connect.example.com/v1/keys            # JSON with the broker's public key
```

The `kid` and `publicKey` are the broker's public key. Computers pin it when they link.

## 4. Sign-in and the approve page

The broker trusts two things it does not make itself. Build them in a small site on `RELAY_PUBLIC_URL`, or in the
site you already run there:

1. **Account tokens.** Every account call sends `Authorization: Bearer <token>`. A token is the base64url body
   `{"sub":"<account id>","exp":<unix seconds>}`, a dot, then the base64url HMAC-SHA256 of that body with
   `RELAY_ACCOUNT_SECRET`. The format is in `apps/relay/src/tickets.ts` (`mintAccountToken`). Tokens last one hour.
   Your site mints them after it has signed the user in. The `sub` is that user's account id, and the broker treats
   it as the owner of every computer that account links.
2. **The approve page at `/connect`.** When a computer asks to link, it shows the user a short code and a link to
   `<RELAY_PUBLIC_URL>/connect`. Your page signs the user in, shows the code and asks "Connect this computer to your
   account?". On Approve it calls:

   ```sh
   curl -X POST https://connect.example.com/oauth/device/approve \
     -H "Authorization: Bearer <account token>" \
     -H "Content-Type: application/json" \
     -d '{"user_code":"ABCD-EFGH","approve":true}'
   ```

   The reply is 204. An unknown or expired code is 404; a bad or missing token is 401.

3. **A token for the Mac app.** The Mac app lists the account's other computers. To do that it calls
   `POST /api/account/relay-token` on its account server with its own sign-in (`Authorization: Bearer <its token>`),
   and expects `{"token":"<account token>"}` back. Its own sign-in token never goes to the broker. Without this
   route, the computers list in the Mac app stays empty.
4. **Use a tunnel domain whose certificate covers `<id>.<RELAY_TUNNEL_DOMAIN>`.** Cloudflare's free certificate covers
   a zone's root and its first-level names only. So `tunnels.example.com` as the tunnel domain needs Cloudflare's paid
   Advanced Certificate Manager. A zone of its own used as the tunnel domain (`example-tunnels.com`) works on the free
   plan. Keep that zone apart from your main site, so nobody's computer answers under your site's own name.

Choose your own sign-in methods. The rules that matter are these: the account token is minted only after sign-in,
and `RELAY_ACCOUNT_SECRET` never reaches a browser or a computer.

Check the refusal paths: `POST /v1/computers` with no token returns 401, and with a token signed by another secret
also 401.

## 5. Link a computer

On each computer that should join the account, the server runs the connect flow:

1. Set `CT_CONNECT_URL=https://connect.example.com` in that server's `.env` and apply it (`docker compose up -d` in
   the Docker kit).
2. On that computer, run the connect command with your broker's address:
   `docker compose exec app node dist/cli.js connect --broker https://connect.example.com` in the Docker kit, or
   `node dist/cli.js connect --broker https://connect.example.com` in the folder you run `node dist/boot.js` from.
   It prints the approve link and a short code, then waits. Without `--broker`, and with the variable not applied,
   the command uses the address built into the app, not yours.
3. Open `https://connect.example.com/connect` on any device, sign in, check the code and approve.
4. Restart the server: its tunnel runs while the server runs.

The command saves the computer's tunnel. After the restart the server starts `cloudflared` (pinned, checked against
its SHA-256 before it runs) and the computer appears on the account. Check on the broker:

```sh
curl -fsS -H "Authorization: Bearer <account token>" https://connect.example.com/v1/computers
```

The reply lists the computer with `"status": "healthy"` once its tunnel is up.

A computer's tunnel points only at its own local server, `http://127.0.0.1:<port>`. The broker refuses any other
origin.

## 6. Limits, cleanup and the first real sweep

- **Computer limit.** `RELAY_FREE_LIMIT` is the number of computers one account may link. Past it, the link is
  refused. The broker counts linked computers, not devices. Paid tiers are for your own code to decide: the public
  broker only knows the one number.
- **Idle tunnels.** Every 5 minutes the broker checks each tunnel. A tunnel that is down or inactive for
  `RELAY_REAP_AFTER` seconds (default 1800), or that Cloudflare no longer has, is released: the Cloudflare tunnel
  is deleted, and the computer stays on its account with its DNS name. Its server asks for its tunnel every 5 minutes
  and gets a new one on the same name, so a computer that slept is back within about 5 minutes of waking. Only
  computers that have asked are released: an older app cannot get a tunnel back, so its tunnel is kept. A degraded
  tunnel still serves and counts as up. The one thing removed is a link cut short before its tunnel was saved, after
  the same window.
- **Dry run first.** `RELAY_REAP_DRY_RUN=1` only logs what it would release or remove. Read the logs for a day:

  ```sh
  docker logs creatortoolset-relay | grep 'reap'
  ```

  When the list looks right, set `RELAY_REAP_DRY_RUN=0` in `.env` and restart the container.

## 7. What to keep, and what to back up

The broker keeps account ids, computer ids and public keys, computer names and local ports, hostnames, Cloudflare
tunnel and DNS ids, the short device codes, and a hash of each device secret. It keeps no content and no sessions.

Back up the `relay-data` volume (`/data` in the container): `relay.sqlite` and the signing key file. Use
`sqlite3 relay.sqlite ".backup backup.sqlite"` for a consistent copy while it runs. Keep the copy somewhere that is
not the broker's own disk.

Do not lose the signing key. A computer checks each ticket against the key it pinned when it linked. A new key
means those computers refuse every ticket until they link again.

Changing `RELAY_ACCOUNT_SECRET` signs out every account at once: existing tokens fail their check.

Keep these secret, in `.env` or a secret store, never in a repository, chat or screenshot: `RELAY_ACCOUNT_SECRET`,
the Cloudflare token, the signing key.

## 8. Troubleshooting

| You see | Usually means |
|---|---|
| `CLOUDFLARE_API_TOKEN is not set` at start | `.env` is missing or not loaded (Docker: `--env-file` path) |
| `RELAY_ACCOUNT_SECRET must be at least 32 bytes` | the secret is shorter than 32 bytes |
| `the relay signing key must be Ed25519` | `RELAY_SIGNING_KEY` holds another key type |
| Link refused with `limit_reached` (403) | the account already has `RELAY_FREE_LIMIT` computers; unlink one first |
| `bad_signature` (401) on link | the computer signed with a key other than the one in its link request |
| A computer shows `down` after it was off a while | its tunnel was released; it gets a new one within 5 minutes of its server running again |
| Tickets rejected by a computer after a broker restart | the signing key was regenerated; restore the old key file (§7) |

A computer does not need an inbound port, and nothing on your router needs to change.

## 9. Test before you trust it

The broker's own tests use a fake Cloudflare and need no account:

```sh
cd apps/relay && node --experimental-strip-types --no-warnings --test test/*.test.ts
```

They cover the device grant (approve, deny, expired), link refusals (bad signature, replayed and expired challenges,
a challenge spent by another account, a non-loopback origin), the computer limit, ticket lifetime and single use,
unlink, rollback when Cloudflare fails, and the reaper (release, renew on the same hostname, older apps left alone), including its dry run.
