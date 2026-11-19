// Phone connection contract types (api/connect/contract.md has the rules and the words).

/** What a client session may do: `read` = GET/HEAD, `write` = every other method, `access` = links, sessions, connect. */
export type Scope = "read" | "write" | "access";
export const SCOPES: readonly Scope[] = ["read", "write", "access"];
export const READ_ONLY: readonly Scope[] = ["read"];
export const STANDARD: readonly Scope[] = ["read", "write", "access"];

export type DeviceType = "desktop" | "mobile" | "tablet" | "bot" | "unknown";
export type SessionMethod = "bearer-access-token" | "dpop-access-token";

/** GET /.well-known/creator-toolset/server */
export interface ServerDescriptor {
  serverId: string;
  label: string;
  platform: "mac" | "linux" | "hosted";
  version: string;
  protocol: 1;
  capabilities: { pairing: boolean; dpop: boolean; connect: boolean };
}

export interface PairingLinkUrl {
  kind: "public" | "lan" | "tailnet";
  url: string; // https://host/#token=XXXXXXXXXXXX
}

/** A pending pairing link as listed: never the credential. */
export interface PairingLink {
  id: string;
  subject: string;
  label?: string;
  scopes: Scope[];
  createdAt: string;
  expiresAt: string;
}

/** POST /api/auth/pairing-links: the only place the credential appears. */
export interface CreatedPairingLink extends PairingLink {
  credential: string;
  urls: PairingLinkUrl[];
}

export interface CreatePairingLinkInput {
  label?: string;
  scopes?: Scope[];
}

export interface ClientMetadata {
  label?: string;
  deviceType: DeviceType;
  os?: string;
  model?: string;
  appVersion?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface ClientSession {
  sessionId: string;
  subject: string;
  label?: string;
  scopes: Scope[];
  method: SessionMethod;
  client: ClientMetadata;
  issuedAt: string;
  expiresAt: string;
  lastConnectedAt: string | null;
  connected: boolean;
  current: boolean;
}

/** GET /api/auth/access */
export interface AccessSnapshot {
  pairingLinks: PairingLink[];
  clientSessions: ClientSession[];
}

/** GET /api/auth/access/events: each SSE event's data. */
export type AccessEvent = { version: 1; revision: number } & (
  | { type: "snapshot"; payload: AccessSnapshot }
  | { type: "pairingLinkUpserted"; payload: PairingLink }
  | { type: "pairingLinkRemoved"; payload: { id: string } }
  | { type: "clientUpserted"; payload: ClientSession }
  | { type: "clientRemoved"; payload: { sessionId: string } }
);

export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
export const BOOTSTRAP_TOKEN_TYPE = "urn:creatortoolset:params:oauth:token-type:server-bootstrap";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** POST /oauth/token answer. */
export interface AccessTokenResult {
  access_token: string;
  issued_token_type: typeof ACCESS_TOKEN_TYPE;
  token_type: "Bearer" | "DPoP";
  expires_in: number;
  scope: string;
}

export type TokenError = "unsupported_grant_type" | "invalid_request" | "invalid_dpop_proof" | "invalid_grant" | "invalid_scope";

/** 401 codes on /api/* for a token that doesn't work. */
export type SessionErrorCode = "INVALID_TOKEN" | "SESSION_EXPIRED" | "SESSION_REVOKED" | "INVALID_DPOP";

/** GET /api/auth/session */
export interface SessionState {
  authenticated: boolean;
  scopes: Scope[];
  method: "browser-cookie" | SessionMethod | null;
  expiresAt: string | null;
  user: { username: string; name: string; role: string } | null;
}

/** GET /api/server/endpoints */
export interface ServerEndpoint {
  kind: "lan" | "tailnet";
  httpBaseUrl: string;
}

/** POST /api/connect/health, /api/connect/mint: the connect service's signed request. */
export interface ConnectRequest {
  proof: string;
}

export interface HealthProofPayload {
  iss: string;
  aud: string; // ct-computer:<serverId>
  sub: string; // the linked owner account id
  jti: string;
  iat: number;
  exp: number;
  nonce: string;
  scope: ["status"];
}

export interface MintProofPayload {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  nonce: string;
  clientProofKeyThumbprint: string;
  cnf: { jkt: string };
  deviceId?: string;
  scope: ["connect"];
}

export interface HealthAnswer {
  serverId: string;
  status: "online";
  checkedAt: string;
  descriptor: ServerDescriptor;
  proof: string;
}

export interface MintAnswer {
  credential: string;
  expiresAt: string;
  proof: string;
}

/** POST /api/connect/link-proof */
export interface LinkProofInput {
  challenge: string;
  relayUrl: string;
}
export interface LinkProofAnswer {
  proof: string;
  computerId: string;
  publicKey: string; // base64 SPKI DER
  origin: string;
  name: string;
}

/** POST /api/connect/relay-config */
export interface RelayConfigInput {
  brokerUrl: string;
  owner: string;
  computerId: string;
  hostname: string;
  tunnelToken: string;
  brokerKey: string; // base64 SPKI DER, Ed25519
  brokerKid?: string;
}
