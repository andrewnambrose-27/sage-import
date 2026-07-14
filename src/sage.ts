const encoder = new TextEncoder();
const decoder = new TextDecoder();
const refreshLeadTimeMs = 5 * 60 * 1000;

export const sageOAuthEndpoints = {
  authorizationUrl: "https://www.sageone.com/oauth2/auth/central",
  tokenUrl: "https://oauth.accounting.sage.com/token",
  apiBaseUrl: "https://api.accounting.sage.com/v3.1",
  scope: "full_access",
  filter: "apiv3.1",
};

export interface SageConnectionConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenEncryptionKey: string;
}

export interface SageTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
}

export interface SageBusiness {
  id: string;
  displayName: string;
}

export interface EncryptedTokens {
  encryptedAccessToken: string;
  accessTokenNonce: string;
  encryptedRefreshToken: string;
  refreshTokenNonce: string;
}

export interface SageConnectionRecord {
  id: string;
  sage_business_id: string;
  sage_business_name: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  encryption_nonce: string;
  access_token_nonce: string;
  refresh_token_nonce: string;
  access_token_expires_at: string;
  last_refreshed_at: string | null;
  connected_at: string;
  disconnected_at: string | null;
}

export interface SafeSageStatus {
  connected: boolean;
  business_display_name: string | null;
  connected_at: string | null;
  last_refreshed_at: string | null;
  reauthorization_required: boolean;
}

export type OAuthCallbackValidation =
  | { ok: true; code: string }
  | { ok: false; status: number; error: string };

export interface SageConnectionStore {
  getActiveConnection(): Promise<SageConnectionRecord | null>;
  saveConnection(input: SaveSageConnectionInput): Promise<SageConnectionRecord>;
  updateTokens(connectionId: string, input: UpdateSageTokensInput): Promise<void>;
  disconnectActive(now: string): Promise<void>;
}

export interface SaveSageConnectionInput {
  business: SageBusiness;
  encryptedTokens: EncryptedTokens;
  accessTokenExpiresAt: string;
  connectedAt: string;
}

export interface UpdateSageTokensInput {
  encryptedTokens: EncryptedTokens;
  accessTokenExpiresAt: string;
  lastRefreshedAt: string;
}

export class SageAuthorizationError extends Error {
  constructor(message = "Sage authorization has expired or been revoked.") {
    super(message);
    this.name = "SageAuthorizationError";
  }
}

export class SageTokenExchangeError extends Error {
  constructor(message = "Sage token exchange failed.") {
    super(message);
    this.name = "SageTokenExchangeError";
  }
}

export class SageBusinessLookupError extends Error {
  constructor(message = "Sage business details could not be read.") {
    super(message);
    this.name = "SageBusinessLookupError";
  }
}

export function createSageAuthorizationUrl(config: Pick<SageConnectionConfig, "clientId" | "redirectUri">, state: string): string {
  const url = new URL(sageOAuthEndpoints.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", sageOAuthEndpoints.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("filter", sageOAuthEndpoints.filter);
  return url.toString();
}

export function validateOAuthCallbackInput(
  expectedState: string | null,
  returnedState: string | null,
  code: string | null,
  compareState: (left: string, right: string) => boolean = (left, right) => left === right,
): OAuthCallbackValidation {
  if (!expectedState || !returnedState || !compareState(expectedState, returnedState)) {
    return { ok: false, status: 400, error: "Invalid Sage authorization state." };
  }

  if (!code) {
    return { ok: false, status: 400, error: "Missing Sage authorization code." };
  }

  return { ok: true, code };
}

export async function exchangeAuthorizationCode(
  config: SageConnectionConfig,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<SageTokenResponse> {
  const response = await fetcher(sageOAuthEndpoints.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });

  if (!response.ok) {
    throw new SageTokenExchangeError();
  }

  return parseTokenResponse(await response.json());
}

export async function fetchConnectedBusiness(accessToken: string, fetcher: typeof fetch = fetch): Promise<SageBusiness> {
  const response = await fetcher(`${sageOAuthEndpoints.apiBaseUrl}/businesses`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new SageBusinessLookupError();
  }

  const data = await response.json() as unknown;
  const items = extractItems(data);
  const business = items[0];
  const id = stringValue(business, "id");
  const displayName = stringValue(business, "displayed_as") || stringValue(business, "name");

  if (!id || !displayName) {
    throw new SageBusinessLookupError();
  }

  return { id, displayName };
}

export async function encryptTokenPair(
  tokens: Pick<SageTokenResponse, "access_token" | "refresh_token">,
  encryptionSecret: string,
): Promise<EncryptedTokens> {
  const [access, refresh] = await Promise.all([
    encryptToken(tokens.access_token, encryptionSecret),
    encryptToken(tokens.refresh_token, encryptionSecret),
  ]);

  return {
    encryptedAccessToken: access.ciphertext,
    accessTokenNonce: access.nonce,
    encryptedRefreshToken: refresh.ciphertext,
    refreshTokenNonce: refresh.nonce,
  };
}

export async function decryptTokenPair(record: SageConnectionRecord, encryptionSecret: string): Promise<{ accessToken: string; refreshToken: string }> {
  if (!record.access_token_nonce || !record.refresh_token_nonce) {
    throw new SageAuthorizationError("Sage tokens need to be reconnected before use.");
  }

  const [accessToken, refreshToken] = await Promise.all([
    decryptToken(record.encrypted_access_token, record.access_token_nonce, encryptionSecret),
    decryptToken(record.encrypted_refresh_token, record.refresh_token_nonce, encryptionSecret),
  ]);

  return { accessToken, refreshToken };
}

export function safeStatusFromConnection(record: SageConnectionRecord | null): SafeSageStatus {
  if (!record || record.disconnected_at) {
    return {
      connected: false,
      business_display_name: null,
      connected_at: null,
      last_refreshed_at: null,
      reauthorization_required: false,
    };
  }

  return {
    connected: true,
    business_display_name: record.sage_business_name,
    connected_at: record.connected_at,
    last_refreshed_at: record.last_refreshed_at,
    reauthorization_required: !record.encrypted_refresh_token || !record.refresh_token_nonce,
  };
}

export class D1SageConnectionStore implements SageConnectionStore {
  constructor(private readonly db: D1Database) {}

  async getActiveConnection(): Promise<SageConnectionRecord | null> {
    const result = await this.db.prepare(
      `SELECT * FROM sage_connections
       WHERE disconnected_at IS NULL
       ORDER BY connected_at DESC
       LIMIT 1`,
    ).first<SageConnectionRecord>();
    return result ?? null;
  }

  async saveConnection(input: SaveSageConnectionInput): Promise<SageConnectionRecord> {
    const id = crypto.randomUUID();
    await this.disconnectActive(input.connectedAt);

    const record: SageConnectionRecord = {
      id,
      sage_business_id: input.business.id,
      sage_business_name: input.business.displayName,
      encrypted_access_token: input.encryptedTokens.encryptedAccessToken,
      encrypted_refresh_token: input.encryptedTokens.encryptedRefreshToken,
      encryption_nonce: "",
      access_token_nonce: input.encryptedTokens.accessTokenNonce,
      refresh_token_nonce: input.encryptedTokens.refreshTokenNonce,
      access_token_expires_at: input.accessTokenExpiresAt,
      last_refreshed_at: null,
      connected_at: input.connectedAt,
      disconnected_at: null,
    };

    await this.db.prepare(
      `INSERT INTO sage_connections (
        id, sage_business_id, sage_business_name, encrypted_access_token, encrypted_refresh_token,
        encryption_nonce, access_token_nonce, refresh_token_nonce, access_token_expires_at,
        last_refreshed_at, connected_at, disconnected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      record.id,
      record.sage_business_id,
      record.sage_business_name,
      record.encrypted_access_token,
      record.encrypted_refresh_token,
      record.encryption_nonce,
      record.access_token_nonce,
      record.refresh_token_nonce,
      record.access_token_expires_at,
      record.last_refreshed_at,
      record.connected_at,
      record.disconnected_at,
    ).run();

    return record;
  }

  async updateTokens(connectionId: string, input: UpdateSageTokensInput): Promise<void> {
    await this.db.prepare(
      `UPDATE sage_connections
       SET encrypted_access_token = ?,
           encrypted_refresh_token = ?,
           encryption_nonce = '',
           access_token_nonce = ?,
           refresh_token_nonce = ?,
           access_token_expires_at = ?,
           last_refreshed_at = ?
       WHERE id = ? AND disconnected_at IS NULL`,
    ).bind(
      input.encryptedTokens.encryptedAccessToken,
      input.encryptedTokens.encryptedRefreshToken,
      input.encryptedTokens.accessTokenNonce,
      input.encryptedTokens.refreshTokenNonce,
      input.accessTokenExpiresAt,
      input.lastRefreshedAt,
      connectionId,
    ).run();
  }

  async disconnectActive(now: string): Promise<void> {
    await this.db.prepare(
      `UPDATE sage_connections
       SET encrypted_access_token = '',
           encrypted_refresh_token = '',
           encryption_nonce = '',
           access_token_nonce = '',
           refresh_token_nonce = '',
           disconnected_at = ?
       WHERE disconnected_at IS NULL`,
    ).bind(now).run();
  }
}

export class SageApiClient {
  constructor(
    private readonly store: SageConnectionStore,
    private readonly config: SageConnectionConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const first = await this.requestWithCurrentToken(path, init);
    if (first.response.status !== 401) {
      return first.response;
    }

    await this.refreshConnection(first.connection);
    const second = await this.requestWithCurrentToken(path, init);
    if (second.response.status === 401) {
      throw new SageAuthorizationError();
    }

    return second.response;
  }

  async refreshIfNeeded(): Promise<void> {
    const connection = await this.store.getActiveConnection();
    if (!connection) {
      throw new SageAuthorizationError("Sage is not connected.");
    }

    if (needsRefresh(connection.access_token_expires_at)) {
      await this.refreshConnection(connection);
    }
  }

  private async requestWithCurrentToken(path: string, init: RequestInit): Promise<{ response: Response; connection: SageConnectionRecord }> {
    const connection = await this.store.getActiveConnection();
    if (!connection) {
      throw new SageAuthorizationError("Sage is not connected.");
    }

    const current = needsRefresh(connection.access_token_expires_at)
      ? await this.refreshConnection(connection)
      : connection;
    const { accessToken } = await decryptTokenPair(current, this.config.tokenEncryptionKey);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);

    return {
      connection: current,
      response: await this.fetcher(`${sageOAuthEndpoints.apiBaseUrl}${path}`, {
        ...init,
        headers,
      }),
    };
  }

  private async refreshConnection(connection: SageConnectionRecord): Promise<SageConnectionRecord> {
    const { refreshToken } = await decryptTokenPair(connection, this.config.tokenEncryptionKey);
    const response = await this.fetcher(sageOAuthEndpoints.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    });

    if (!response.ok) {
      throw new SageAuthorizationError();
    }

    const tokens = parseTokenResponse(await response.json());
    const now = new Date().toISOString();
    const encryptedTokens = await encryptTokenPair(tokens, this.config.tokenEncryptionKey);
    const updated: SageConnectionRecord = {
      ...connection,
      encrypted_access_token: encryptedTokens.encryptedAccessToken,
      encrypted_refresh_token: encryptedTokens.encryptedRefreshToken,
      access_token_nonce: encryptedTokens.accessTokenNonce,
      refresh_token_nonce: encryptedTokens.refreshTokenNonce,
      access_token_expires_at: expiryFromNow(tokens.expires_in),
      last_refreshed_at: now,
    };

    await this.store.updateTokens(connection.id, {
      encryptedTokens,
      accessTokenExpiresAt: updated.access_token_expires_at,
      lastRefreshedAt: now,
    });

    return updated;
  }
}

export function expiryFromNow(expiresInSeconds: number): string {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

function needsRefresh(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() - Date.now() <= refreshLeadTimeMs;
}

function parseTokenResponse(data: unknown): SageTokenResponse {
  if (!isRecord(data)) {
    throw new SageTokenExchangeError();
  }

  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : Number(data.expires_in);

  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn)) {
    throw new SageTokenExchangeError();
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    token_type: typeof data.token_type === "string" ? data.token_type : undefined,
  };
}

async function encryptToken(token: string, encryptionSecret: string): Promise<{ ciphertext: string; nonce: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(encryptionSecret);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, encoder.encode(token));
  return {
    ciphertext: base64UrlFromBytes(new Uint8Array(ciphertext)),
    nonce: base64UrlFromBytes(nonce),
  };
}

async function decryptToken(ciphertext: string, nonce: string, encryptionSecret: string): Promise<string> {
  const key = await aesKey(encryptionSecret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(arrayBufferFromBase64Url(nonce)) },
    key,
    arrayBufferFromBase64Url(ciphertext),
  );
  return decoder.decode(plaintext);
}

async function aesKey(encryptionSecret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(encryptionSecret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function formBody(values: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    body.set(key, value);
  }
  return body;
}

function extractItems(data: unknown): Record<string, unknown>[] {
  if (!isRecord(data)) {
    return [];
  }

  const value = data.$items ?? data.items;
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function arrayBufferFromBase64Url(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
