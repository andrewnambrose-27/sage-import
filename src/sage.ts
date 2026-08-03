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

export const sageReadOnlyPaths = {
  ledgerAccounts: "/ledger_accounts",
  taxRates: "/tax_rates",
  contacts: "/contacts",
};

export const sageContactPaths = {
  contacts: "/contacts",
};

export const sageDraftInvoicePaths = {
  salesInvoices: "/sales_invoices",
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

export class SageReferenceFetchError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    message = "Sage reference data could not be read.",
  ) {
    super(message);
    this.name = "SageReferenceFetchError";
  }
}

export class SageResponseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SageResponseShapeError";
  }
}

export interface SageReferenceDiagnostics {
  businessId: string;
  endpoint: string;
  status: number;
  contentType: string | null;
  topLevelKeys: string[];
  itemCount: number;
  page: number;
  totalPages: number | null;
  totalItems: number | null;
}

export interface SageReferenceFetchResult {
  items: Record<string, unknown>[];
  diagnostics: SageReferenceDiagnostics[];
}

export interface SageTaxRateReference {
  id: string;
  name: string;
  displayName: string;
  percentage: number | null;
  active: boolean;
  usableForSales: boolean | null;
}

export interface SageLedgerAccountReference {
  id: string;
  code: string;
  name: string;
  displayName: string;
  accountType: string | null;
  accountGroup: string | null;
  visible: boolean | null;
  active: boolean | null;
  defaultTaxRateId: string | null;
}

export interface SagePlaceholderCustomerPayload {
  contact: {
    name: string;
    contact_type_ids: ["CUSTOMER"];
    notes: string;
    main_address: {
      name: "TEST";
      address_line_1: "TEST";
      address_line_2: "TEST";
      city: "TEST";
      region: "TEST";
      postal_code: "TEST";
      is_main_address: true;
    };
    main_contact_person: {
      name: string;
      contact_person_type_ids: ["ACCOUNTS"];
      is_main_contact: true;
    };
  };
}

export interface SageCreatedContact {
  id: string;
  displayName: string;
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
  const response = await invokeFetch(fetcher, sageOAuthEndpoints.tokenUrl, {
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
  const response = await invokeFetch(fetcher, `${sageOAuthEndpoints.apiBaseUrl}/businesses`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new SageBusinessLookupError();
  }

  const data = await response.json() as unknown;
  const items = extractSageItems(data, "Sage businesses");
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

  async activeBusinessId(): Promise<string> {
    const connection = await this.store.getActiveConnection();
    if (!connection) {
      throw new SageAuthorizationError("Sage is not connected.");
    }
    return connection.sage_business_id;
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
    headers.set("X-Business", formatSageBusinessHeader(current.sage_business_id));
    headers.set("Accept", "application/json");

    return {
      connection: current,
      response: await invokeFetch(this.fetcher, `${sageOAuthEndpoints.apiBaseUrl}${path}`, {
        ...init,
        headers,
      }),
    };
  }

  private async refreshConnection(connection: SageConnectionRecord): Promise<SageConnectionRecord> {
    const { refreshToken } = await decryptTokenPair(connection, this.config.tokenEncryptionKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await invokeFetch(this.fetcher, sageOAuthEndpoints.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: controller.signal,
        body: formBody({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new SageAuthorizationError("Sage token refresh took too long. Reconnect Sage and try again.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

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

export async function fetchSageLedgerAccounts(client: SageApiClient): Promise<SageReferenceFetchResult> {
  return fetchSageReferenceCollection(client, sageReadOnlyPaths.ledgerAccounts, "Sage ledger accounts");
}

export async function fetchSageTaxRates(client: SageApiClient): Promise<SageReferenceFetchResult> {
  return fetchSageReferenceCollection(client, sageReadOnlyPaths.taxRates, "Sage tax rates");
}

export function normalizeSageTaxRate(item: Record<string, unknown>): SageTaxRateReference {
  const name = stringValue(item, "name") || stringValue(item, "displayed_as") || stringValue(item, "display_name");
  return {
    id: stringValue(item, "id"),
    name,
    displayName: stringValue(item, "displayed_as") || stringValue(item, "display_name") || name,
    percentage: firstNumber(item, ["percentage", "rate", "tax_rate_percentage"]),
    active: activeValue(item) ?? true,
    usableForSales: booleanValue(item, ["usable_for_sales", "sales_usable", "is_sales"]),
  };
}

export function normalizeSageLedgerAccount(item: Record<string, unknown>): SageLedgerAccountReference {
  const name = stringValue(item, "name") || stringValue(item, "displayed_as") || stringValue(item, "display_name");
  return {
    id: stringValue(item, "id"),
    code: stringValue(item, "nominal_code") || stringValue(item, "ledger_account_code") || stringValue(item, "code"),
    name,
    displayName: stringValue(item, "displayed_as") || stringValue(item, "display_name") || name,
    accountType: stringValue(item, "ledger_account_type") || stringValue(item, "account_type") || null,
    accountGroup: stringValue(item, "ledger_account_group") || stringValue(item, "account_group") || null,
    visible: booleanValue(item, ["visible", "is_visible"]),
    active: activeValue(item),
    defaultTaxRateId: stringValue(item, "tax_rate_id") || stringValue(item, "default_tax_rate_id") || null,
  };
}

export async function searchSageContacts(client: SageApiClient, search: string): Promise<SageReferenceFetchResult> {
  const params = new URLSearchParams();
  if (search.trim()) params.set("search", search);
  params.set("contact_type_id", "CUSTOMER");
  return fetchSageReferenceCollection(
    client,
    `${sageReadOnlyPaths.contacts}?${params.toString()}`,
    "Sage contacts",
  );
}

export function buildSagePlaceholderCustomerPayload(customerName: string): SagePlaceholderCustomerPayload {
  const name = customerName.trim();
  if (!name) {
    throw new SageContactRequestError(400, "A customer name is required.");
  }

  return {
    contact: {
      name,
      contact_type_ids: ["CUSTOMER"],
      notes: "Created by Sage Import Checker. Placeholder address details must be completed in Sage before the invoice is sent.",
      main_address: {
        name: "TEST",
        address_line_1: "TEST",
        address_line_2: "TEST",
        city: "TEST",
        region: "TEST",
        postal_code: "TEST",
        is_main_address: true,
      },
      main_contact_person: {
        name,
        contact_person_type_ids: ["ACCOUNTS"],
        is_main_contact: true,
      },
    },
  };
}

export async function createSagePlaceholderCustomer(client: SageApiClient, customerName: string): Promise<SageCreatedContact> {
  const response = await sageRequestWithTimeout(client, sageContactPaths.contacts, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildSagePlaceholderCustomerPayload(customerName)),
  }, 15_000);

  if (!response.ok) {
    throw new SageContactRequestError(response.status);
  }

  const data = await response.json();
  if (!isRecord(data)) {
    throw new SageContactRequestError(502, "Sage created the customer but returned an unexpected response.");
  }
  const id = stringValue(data, "id");
  const displayName = stringValue(data, "displayed_as") || stringValue(data, "name") || customerName.trim();
  if (!id) {
    throw new SageContactRequestError(502, "Sage did not return the new customer ID.");
  }

  return { id, displayName };
}

export async function searchSageSalesInvoices(client: SageApiClient, search: string): Promise<SageReferenceFetchResult> {
  const params = new URLSearchParams();
  params.set("search", search);
  params.set("attributes", "reference");
  return fetchSageReferenceCollection(
    client,
    `${sageDraftInvoicePaths.salesInvoices}?${params.toString()}`,
    "Sage sales invoices",
  );
}

export async function createSageDraftInvoice(client: SageApiClient, payload: unknown): Promise<unknown> {
  const response = await sageRequestWithTimeout(client, sageDraftInvoicePaths.salesInvoices, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, 20_000, () => new SageUncertainResultError());

  if (!response.ok) {
    const status = response.status;
    if (status >= 500) {
      throw new SageUncertainResultError();
    }
    throw new SageDraftInvoiceRequestError(status);
  }
  return response.json();
}

export class SageUncertainResultError extends Error {
  constructor(message = "Sage did not return a reliable result. Check Sage before trying again.") {
    super(message);
    this.name = "SageUncertainResultError";
  }
}

export class SageDraftInvoiceRequestError extends Error {
  constructor(public readonly status: number) {
    super("Sage rejected the draft invoice.");
    this.name = "SageDraftInvoiceRequestError";
  }
}

export class SageContactRequestError extends Error {
  constructor(public readonly status: number, message = "Sage could not create the customer.") {
    super(message);
    this.name = "SageContactRequestError";
  }
}

export function expiryFromNow(expiresInSeconds: number): string {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

export function formatSageBusinessHeader(value: string): string {
  const compact = value.replace(/-/g, "");
  if (/^[0-9a-f]{32}$/i.test(compact)) {
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  }
  return value;
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

function invokeFetch(fetcher: typeof fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetcher.call(globalThis, input, init);
}

async function sageRequestWithTimeout(
  client: SageApiClient,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutError: () => Error = () => new SageBusinessLookupError("Sage took too long to respond."),
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await client.request(path, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw timeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function extractSageItems(data: unknown, resourceName: string): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }

  if (!isRecord(data)) {
    throw new SageResponseShapeError(`${resourceName} returned an unexpected response structure.`);
  }

  const direct = data.$items ?? data.items;
  if (Array.isArray(direct)) {
    return direct.filter(isRecord);
  }

  if (isRecord(data.data)) {
    const nested = data.data.$items ?? data.data.items;
    if (Array.isArray(nested)) {
      return nested.filter(isRecord);
    }
  }

  throw new SageResponseShapeError(`${resourceName} returned an unexpected response structure.`);
}

async function fetchSageReferenceCollection(
  client: SageApiClient,
  path: string,
  resourceName: string,
): Promise<SageReferenceFetchResult> {
  const perPage = 200;
  const maxPages = 100;
  const items: Record<string, unknown>[] = [];
  const diagnostics: SageReferenceDiagnostics[] = [];
  const businessId = await client.activeBusinessId();
  const seenPages = new Set<number>();
  let page = 1;
  let totalPages: number | null = null;

  while (page <= maxPages) {
    if (seenPages.has(page)) {
      throw new SageResponseShapeError(`${resourceName} pagination repeated a page.`);
    }
    seenPages.add(page);

    const requestPath = withPagination(path, page, perPage);
    const response = await sageRequestWithTimeout(client, requestPath, {}, 10_000);
    const contentType = response.headers.get("content-type");
    if (!response.ok) {
      logSageReferenceDiagnostic({
        businessId,
        endpoint: path,
        status: response.status,
        contentType,
        topLevelKeys: [],
        itemCount: 0,
        page,
        totalPages: null,
        totalItems: null,
      });
      throw new SageReferenceFetchError(path, response.status, safeSageResponseMessage(response.status));
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new SageResponseShapeError(`${resourceName} returned a non-JSON response.`);
    }
    const pageItems = extractSageItems(data, resourceName);
    const metadata = paginationMetadata(response, data);
    totalPages = metadata.totalPages ?? totalPages;
    const diagnostic: SageReferenceDiagnostics = {
      businessId,
      endpoint: path,
      status: response.status,
      contentType,
      topLevelKeys: Array.isArray(data) ? ["array"] : isRecord(data) ? Object.keys(data).slice(0, 20) : [],
      itemCount: pageItems.length,
      page,
      totalPages: metadata.totalPages,
      totalItems: metadata.totalItems,
    };
    diagnostics.push(diagnostic);
    logSageReferenceDiagnostic(diagnostic);
    items.push(...pageItems);

    if (metadata.hasNext === false) {
      break;
    }

    if (metadata.totalPages !== null) {
      if (page >= metadata.totalPages) {
        break;
      }
      page += 1;
      continue;
    }

    if (pageItems.length < perPage) {
      break;
    }
    page += 1;
  }

  if (page > maxPages) {
    throw new SageResponseShapeError(`${resourceName} pagination exceeded the safety limit.`);
  }

  return { items: dedupeSageItems(items), diagnostics };
}

function withPagination(path: string, page: number, itemsPerPage: number): string {
  const url = new URL(path, "https://sage-import.invalid");
  url.searchParams.set("items_per_page", String(itemsPerPage));
  url.searchParams.set("page", String(page));
  if (!url.searchParams.has("attributes")) {
    url.searchParams.set("attributes", "all");
  }
  return `${url.pathname}${url.search}`;
}

function paginationMetadata(response: Response, data: unknown): { totalPages: number | null; totalItems: number | null; hasNext: boolean | null } {
  const headerNumber = (name: string): number | null => {
    const value = Number(response.headers.get(name));
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const object = isRecord(data) ? data : {};
  const nested = isRecord(object.pagination) ? object.pagination : {};
  const numberValue = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
  const totalItems = headerNumber("x-pagination-totalitems")
    ?? headerNumber("x-pagination-total-items")
    ?? numberValue(nested.total_items)
    ?? numberValue(object.total_items)
    ?? numberValue(object.$total);
  const currentPage = numberValue(object.$page);
  const itemsPerPage = numberValue(object.$itemsPerPage);
  const explicitTotalPages = headerNumber("x-pagination-totalpages")
    ?? headerNumber("x-pagination-total-pages")
    ?? numberValue(nested.total_pages)
    ?? numberValue(object.total_pages);
  const totalPages = explicitTotalPages
    ?? (totalItems !== null && itemsPerPage !== null && itemsPerPage > 0 ? Math.ceil(totalItems / itemsPerPage) : null);
  const next = object.$next ?? object.next;
  return {
    totalPages,
    totalItems,
    hasNext: typeof next === "string" ? next.length > 0 : next === null ? false : currentPage !== null && totalPages !== null ? currentPage < totalPages : null,
  };
}

function dedupeSageItems(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return items.filter((item, index) => {
    const id = stringValue(item, "id");
    const key = id || `page-item-${index}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function safeSageResponseMessage(status: number): string {
  if (status === 401) return "Sage authorization needs to be reconnected.";
  if (status === 403) return "Sage denied access to this reference data.";
  if (status === 429) return "Sage is temporarily rate limiting reference requests.";
  return "Sage reference data could not be read.";
}

function logSageReferenceDiagnostic(diagnostic: SageReferenceDiagnostics): void {
  console.info("Sage reference refresh diagnostic", diagnostic);
}

function firstNumber(item: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = typeof item[key] === "number" ? item[key] : Number(item[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function booleanValue(item: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    if (typeof item[key] === "boolean") return item[key];
  }
  return null;
}

function activeValue(item: Record<string, unknown>): boolean | null {
  if (typeof item.active === "boolean") return item.active;
  if (typeof item.is_active === "boolean") return item.is_active;
  if (typeof item.inactive === "boolean") return !item.inactive;
  return null;
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
