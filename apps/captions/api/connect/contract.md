# Phone connection contract (server side)

Every phone, tablet or other app signed in to a server holds a **client session** the server issued itself. The server
makes pairing links, swaps a link's code for a session at `/oauth/token`, lists and revokes sessions, and answers the
connect service's signed health and mint requests. No computer password is needed for any of it. The TypeScript shapes
are in `api/lib/clients.ts` (exported types); this page is the words and the rules.

Times are ISO 8601 strings unless marked "unix seconds". All JSON. "Signed-in" = the browser cookie, or
`Authorization: Bearer cts_…`, or `Authorization: DPoP cts_…` + `DPoP: <proof>`.

## Scopes

| Scope | Allows |
|---|---|
| `read` | `GET`/`HEAD` on every `/api` route the account may use |
| `write` | every other method |
| `access` | pairing links, client sessions, `/api/connect/*` (the computer's connect settings) |

Presets: **Read only** = `["read"]`. **Standard** = `["read", "write", "access"]` (the default, and always the scope of
a connect grant). A browser cookie has all three. In OAuth fields scopes are space-separated (`"read write access"`).

## Token formats

| What | Format | Life | Kept by the server as |
|---|---|---|---|
| Pairing credential | 12 characters of `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, case-insensitive (the server upper-cases) | 5 min, once | sha256 |
| Connect credential (from `/api/connect/mint`) | same 12-character format | 2 min, once, bound to the phone key's `jkt` | sha256 |
| Access token | `cts_` + 43 base64url characters (32 random bytes) | Bearer: 30 days fixed; DPoP: 1 h; never extended | sha256 |
| DPoP proof | compact JWS, ES256 (P-256), header `{typ: "dpop+jwt", alg: "ES256", jwk}` | one request | its `jti`, 10 min |
| Connect-service request proof | compact JWS, EdDSA (Ed25519, the broker key pinned at link) | ≤ 300 s, `jti` and `nonce` once | `jti:`/`nonce:` in `connect.json` `usedJti` |
| Computer answer proof | compact JWS, EdDSA (this computer's key, `connect-key.der`) | = the credential's expiry (mint), 60 s (health) | — |

Server id = the computer key id: the first 32 hex characters of the SHA-256 of the Ed25519 public key's SPKI DER. Every
server makes its key at boot, so every server has an id, linked or not.

## Routes

### `GET /.well-known/creator-toolset/server` (public, no sign-in)

```json
{ "serverId": "3f…32 hex", "label": "Studio Mac", "platform": "mac" | "linux" | "hosted",
  "version": "0.15.70", "protocol": 1, "capabilities": { "pairing": true, "dpop": true, "connect": true } }
```

`capabilities.connect`: the computer is linked to the connect service. The phone reads this on every route before it
sends a credential (wrong machine, already saved, unsupported `protocol`).

### `POST /api/auth/pairing-links` (signed-in, needs `access` and every scope it delegates)

Request `{ "label"?: string (≤ 80 chars), "scopes"?: ("read"|"write"|"access")[] }` (default Standard).
Response 200:

```json
{ "id": "pl_…", "credential": "<12 characters>", "label": "Living room iPad", "scopes": ["read"],
  "createdAt": "…", "expiresAt": "…",
  "urls": [{ "kind": "public" | "lan" | "tailnet", "url": "https://host/#token=<credential>" }] }
```

`urls` lists the addresses a phone can reach this server on (the tunnel hostname or the public origin first, then LAN,
then the tailnet address; never loopback). It may be empty: the code still works when typed on a reachable address. The raw
`credential` appears only in this response. The pairing signs in **as the account that made the link**.
Errors: 401 `"Sign in first"`; 403 `{code: "SCOPE"}` (see below); 400 `"Unknown scope"`.

### Pairing link shapes (what scans, opens and is typed)

- **Link**: `<origin>/#token=<credential>` (the root page, the code in the fragment so no server log sees it). A phone
  also accepts `?token=` on the root page, and a code typed with an address.
- **App link**: `creatortoolset://pair?pairingUrl=<the link, URL-encoded>`. The browser landing's "Open in the app"
  opens it; the phone reads the link out of it and pairs as if it were scanned.
- **Opened in a browser**: the web app takes the code off the address bar before anything else runs and shows a landing
  ("Open in the app", "Get the app on the App Store"). It never sends the code anywhere, so the link still works once
  in the app.
- **Universal link**: `GET /.well-known/apple-app-site-association` (public) lets the iPhone app claim
  `/` with fragment `token=*`, for the app ids in `IOS_APP_IDS` (comma-separated `<team id>.<bundle id>`; default the
  public app `8DB5KKMAS3.com.creatortoolset.ios`). Apple only honours it on an HTTPS domain the app lists under
  Associated Domains (`applinks:`); a LAN or VPN address opens the browser landing instead.

### `GET /api/auth/access` (needs `access`)

`{ "pairingLinks": PairingLink[], "clientSessions": ClientSession[] }`. An admin sees every account's; anyone else sees
their own. Never a credential or token.

```
PairingLink   { id, subject, label?, scopes, createdAt, expiresAt }
ClientSession { sessionId, subject, label?, scopes, method: "bearer-access-token" | "dpop-access-token",
                client: { label?, deviceType: "desktop"|"mobile"|"tablet"|"bot"|"unknown", os?, model?,
                          appVersion?, ipAddress?, userAgent? },
                issuedAt, expiresAt, lastConnectedAt: string | null, connected: boolean, current: boolean }
```

Expired links are left out. Expired sessions are left out unless `connected` (an open change stream). `current` is true
for the session making the call.

### `GET /api/auth/access/events` (needs `access`; SSE)

Each event's `event:` is the type; its `data:` is `{ version: 1, revision: number, type, payload }`:
`snapshot` (payload = the `/api/auth/access` body, always first), `pairingLinkUpserted` (PairingLink),
`pairingLinkRemoved` (`{id}`), `clientUpserted` (ClientSession; `current` is from this stream's caller),
`clientRemoved` (`{sessionId}`). A `ping` every 15 s. The stream ends at once when its own session is revoked.

### `POST /api/auth/pairing-links/revoke` `{ id }` · `POST /api/auth/clients/revoke` `{ sessionId }` · `POST /api/auth/clients/revoke-others`

Need `access`. 200 `{ "ok": true }` (revoke-others: `{ "ok": true, "revoked": n }`: every session of the caller's
account but the caller's own; for an admin, every session on the server but its own). 404 `"Not found"` for an id the
caller may not see. Revoking a session ends its open change streams (`/api/sync/events`, `/api/auth/access/events`) at
once; every later request with its token is 401 `SESSION_REVOKED`.

### `POST /oauth/token` (form-encoded, no sign-in)

```
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<pairing or connect credential>
subject_token_type=urn:creatortoolset:params:oauth:token-type:server-bootstrap
requested_token_type=urn:ietf:params:oauth:token-type:access_token
scope?            space-separated, intersected with the grant's
client_label?     e.g. the device name ("Sam's iPhone"; it has no authority)
client_device_type? desktop|mobile|tablet|bot|unknown
client_os?        "iOS 26"
client_model?     "iPhone17,1"
app_version?      "1.4.0"
[header DPoP: <proof for POST and this URL>]
```

200 `{ "access_token": "cts_…", "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
"token_type": "Bearer" | "DPoP", "expires_in": seconds, "scope": "read write access" }`, `Cache-Control: no-store`.

Rules: a `DPoP` header that fails any check is an error, never a fall back to Bearer. With a valid proof the session is
DPoP-bound to its key for 1 h; without, Bearer for 30 days. A connect credential needs a proof by the key it was minted
for. The code is spent by a redeem that gets as far as issuing; it is **not** spent by: a bad DPoP proof, a proof by
the wrong key, or a `scope` with nothing in common with the grant (each answered before spending). An expired code is
dropped.

Errors (400, `{ error, error_description }`):

| `error` | When | `error_description` |
|---|---|---|
| `unsupported_grant_type` | wrong `grant_type` | "Only token exchange is supported." |
| `invalid_request` | wrong token types, missing `subject_token`, bad `client_device_type` | "The request is missing a field or has a wrong one." |
| `invalid_dpop_proof` | the DPoP header fails a check | "This device's signature didn't match. Try again." |
| `invalid_grant` | unknown, used, expired code; or a connect code without its key's proof | "That code is used or expired. Make a new one on the computer." |
| `invalid_scope` | none of the requested scopes is in the grant, or an unknown scope | "That code doesn't allow what this device asked for." |

### Using a session on `/api/*`

- Bearer: `Authorization: Bearer cts_…`.
- DPoP: `Authorization: DPoP cts_…` and `DPoP: <proof>` with `htm` = the method, `htu` = the request URL without query
  or fragment (`https://` when the request came through a proxy that sets `X-Forwarded-Proto: https`), `iat` within
  ±300 s of the server's clock, a fresh `jti` (each `jti` is accepted once), and `ath` = base64url(SHA-256(token)).
- The gate reads these **before** the cookie. A request that carries a token never falls back to the cookie.
- 401 `{ error, code }` + `WWW-Authenticate: Bearer error="invalid_token"` (or `DPoP …`):

| `code` | `error` (the words to show) |
|---|---|
| `INVALID_TOKEN` | "This computer doesn't know this device any more. Pair it again." |
| `SESSION_EXPIRED` | "This device's sign-in to the computer ran out. Pair it again." |
| `SESSION_REVOKED` | "This device was signed out on the computer. Pair it again." |
| `INVALID_DPOP` | "This device's signature didn't match. Try again." |

- 403 `{ error: "This device can look but not change things.", code: "SCOPE", requiredScope: "write" }` (or
  `"access"`, error "This device can't manage who has access.").
- `lastConnectedAt` is written at most once a minute per session. `connected` is true while a change stream of that
  session is open.

### `GET /api/auth/session` (no sign-in needed; reads the token or the cookie)

`{ "authenticated": boolean, "scopes": Scope[], "method": "browser-cookie" | "bearer-access-token" |
"dpop-access-token" | null, "expiresAt": string | null, "user": { username, name, role } | null }`.
With a bad token: 401 as above.

### `GET /api/server/endpoints` (signed-in)

`[{ "kind": "lan" | "tailnet", "httpBaseUrl": "http://192.0.2.10:43128" }]`. LAN: the default route's address, when the
server listens on every interface (`HOST` unset, `0.0.0.0` or `::`). Tailnet: an interface address in 100.64.0.0/10, same condition. Never
loopback. The phone learns these after each connect; addresses it stops seeing are dropped.

### `POST /api/connect/health` (connect service, through the tunnel; no sign-in)

Request `{ "proof": "<JWS>" }`. Proof header `{ alg: "EdDSA", typ: "ct-connect-health+jwt" }`, payload
`{ iss: <brokerUrl origin>, aud: "ct-computer:<serverId>", sub: <owner account id>, jti, iat, exp, nonce,
scope: ["status"] }`.
200 `{ "serverId", "status": "online", "checkedAt", "descriptor": <the well-known body>, "proof": "<JWS>" }`, the answer
proof signed by this computer: header `{ alg: "EdDSA", typ: "ct-connect-health-answer+jwt" }`, payload
`{ iss: "ct-computer:<serverId>", aud: <brokerUrl origin>, sub: <serverId>, jti, iat, exp: iat + 60,
requestNonce, status: "online", checkedAt, descriptor }`.

### `POST /api/connect/mint` (connect service, through the tunnel; no sign-in)

Request `{ "proof": "<JWS>" }`. Header `{ alg: "EdDSA", typ: "ct-connect-mint+jwt" }`, payload `{ iss, aud:
"ct-computer:<serverId>", sub: <owner account id>, jti, iat, exp, nonce, clientProofKeyThumbprint, cnf: { jkt },
deviceId?, scope: ["connect"] }`.
200 `{ "credential": "12 chars", "expiresAt", "proof": "<JWS>" }`; answer header `{ alg: "EdDSA", typ:
"ct-connect-mint-answer+jwt" }`, payload `{ iss: "ct-computer:<serverId>", aud: <brokerUrl origin>, sub: <serverId>,
jti, iat, exp: <credential expiry>, requestNonce, clientProofKeyThumbprint, credential }`.
The credential is a one-time grant: Standard, 2 min, bound to `cnf.jkt`, signing in as the computer's `localUser`.

Checks on both (each failure: 401 `{ error: "proof_rejected" }`, a reused `jti`/`nonce`: 409 `{ error: "proof_replayed" }`,
not linked: 404 `{ error: "not_linked" }`, wrong address: 421 `{ error: "wrong_host" }`):
the signature with the **pinned** broker key; `alg`/`typ` as above; `iss` = the linked broker URL's origin; `aud`;
`sub` = the linked owner; `exp > iat`, `exp − iat ≤ 300`, `iat ≤ now + 60`, `exp > now`; `scope` exactly `["status"]` /
`["connect"]`; mint: `cnf.jkt` = `clientProofKeyThumbprint`; `jti` and `nonce` burned. The request's Host must be the
tunnel hostname and it must carry no `X-Forwarded-Host`.

### `POST /api/connect/link-proof` (the owner's signed-in session on this computer)

Request `{ "challenge": string, "relayUrl": "https://connect.example" }`. The request must be addressed to loopback
(`127.0.0.1`, `localhost`, `[::1]`) and carry no `X-Forwarded-Host`/`X-Forwarded-Proto`. Response
`{ "proof": "<JWS>", "computerId", "publicKey": "<base64 SPKI DER>", "origin": "http://127.0.0.1:<port>", "name" }`.
Proof header `{ alg: "EdDSA", typ: "ct-link-proof+jwt" }`, payload `{ iss: "ct-computer:<id>", aud: <relayUrl origin>,
sub: <id>, jti, iat, exp: iat + 300, challenge, publicKey, origin, name }`.
Errors: 400 `"Bad request"`; 403 `"Only from this computer"`.

### `POST /api/connect/relay-config` · `DELETE /api/connect/relay-config` (the owner's signed-in session)

Request `{ brokerUrl, owner, computerId, hostname, tunnelToken, brokerKey: "<base64 SPKI DER Ed25519>",
brokerKid? }` (what the connect service's link answer carries). `computerId` must be this computer's id. Stores
`connect.json` (`localUser` = the caller), starts the tunnel. 200 `{ ok: true, hostname }`. 400 `"Bad request"` /
`"That link is for another computer"`. `DELETE`: stops the tunnel and forgets the link, 200 `{ ok: true }`.

## Kept

`/api/auth/login`, `/api/auth/app`, `/api/auth/password` and the cookie stay. Username/password sign-in keeps the
own-computer rule (the `APP_SECRET` password signs in from this Mac only).

## Deprecated (work until the phone and connect service switch, then removed)

- `POST /api/auth/link`, `GET /api/auth/link/:code`: use `/api/auth/pairing-links` + `/oauth/token`.
- `POST /api/auth/ticket`: use `/api/connect/mint` + `/oauth/token` with DPoP.

## Network

When the server listens on every interface (`HOST` = `0.0.0.0` or `::`) and is not hosted, it closes any connection
whose peer is not loopback, private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16, fe80::/10) or
100.64.0.0/10.
