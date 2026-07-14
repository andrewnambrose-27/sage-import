import { describe, expect, it, vi } from "vitest";
import {
  SageApiClient,
  SageAuthorizationError,
  SageTokenExchangeError,
  decryptTokenPair,
  encryptTokenPair,
  exchangeAuthorizationCode,
  expiryFromNow,
  safeStatusFromConnection,
  validateOAuthCallbackInput,
  type SageConnectionConfig,
  type SageConnectionRecord,
  type SageConnectionStore,
  type UpdateSageTokensInput,
} from "./sage";

const config: SageConnectionConfig = {
  clientId: "sage-client-id",
  clientSecret: "sage-client-secret",
  redirectUri: "https://sage-import.27tools.co/api/sage/callback",
  tokenEncryptionKey: "local-test-encryption-secret",
};

describe("OAuth callback validation", () => {
  it("rejects invalid OAuth state", () => {
    expect(validateOAuthCallbackInput("expected", "wrong", "code")).toEqual({
      ok: false,
      status: 400,
      error: "Invalid Sage authorization state.",
    });
  });

  it("rejects a missing authorization code", () => {
    expect(validateOAuthCallbackInput("state", "state", null)).toEqual({
      ok: false,
      status: 400,
      error: "Missing Sage authorization code.",
    });
  });
});

describe("token exchange", () => {
  it("throws a safe error when token exchange fails", async () => {
    const fetcher = vi.fn(async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    await expect(exchangeAuthorizationCode(config, "code", fetcher)).rejects.toThrow(SageTokenExchangeError);
  });
});

describe("token encryption", () => {
  it("round trips encrypted tokens without exposing plaintext in stored values", async () => {
    const encrypted = await encryptTokenPair({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
    }, config.tokenEncryptionKey);
    const record = connectionRecord({
      encrypted_access_token: encrypted.encryptedAccessToken,
      encrypted_refresh_token: encrypted.encryptedRefreshToken,
      access_token_nonce: encrypted.accessTokenNonce,
      refresh_token_nonce: encrypted.refreshTokenNonce,
    });

    expect(JSON.stringify(encrypted)).not.toContain("access-secret");
    expect(JSON.stringify(encrypted)).not.toContain("refresh-secret");
    await expect(decryptTokenPair(record, config.tokenEncryptionKey)).resolves.toEqual({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
    });
  });
});

describe("SageApiClient", () => {
  it("refreshes an expired access token and saves encrypted replacements", async () => {
    const store = new MemorySageStore(connectionRecord({
      access_token_expires_at: "2020-01-01T00:00:00.000Z",
    }));
    await store.replaceTokens("expired-access", "refresh-token");
    const fetcher = vi.fn(async () => jsonResponse({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    })) as unknown as typeof fetch;

    const client = new SageApiClient(store, config, fetcher);
    await client.refreshIfNeeded();

    expect(store.lastTokenUpdate).toBeTruthy();
    const decrypted = await decryptTokenPair(store.connection!, config.tokenEncryptionKey);
    expect(decrypted).toEqual({ accessToken: "new-access", refreshToken: "new-refresh" });
  });

  it("requires reconnection when the refresh token has expired or been revoked", async () => {
    const store = new MemorySageStore(connectionRecord({
      access_token_expires_at: "2020-01-01T00:00:00.000Z",
    }));
    await store.replaceTokens("expired-access", "revoked-refresh");
    const fetcher = vi.fn(async () => new Response("revoked", { status: 401 })) as unknown as typeof fetch;

    const client = new SageApiClient(store, config, fetcher);
    await expect(client.refreshIfNeeded()).rejects.toThrow(SageAuthorizationError);
  });

  it("retries one request after a successful token refresh", async () => {
    const store = new MemorySageStore(connectionRecord({
      access_token_expires_at: expiryFromNow(3600),
    }));
    await store.replaceTokens("old-access", "refresh-token");
    let businessRequestCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/businesses")) {
        businessRequestCount += 1;
        return businessRequestCount === 1
          ? new Response("unauthorized", { status: 401 })
          : jsonResponse({ $items: [] });
      }

      return jsonResponse({
        access_token: "retry-access",
        refresh_token: "retry-refresh",
        expires_in: 3600,
      });
    }) as unknown as typeof fetch;

    const client = new SageApiClient(store, config, fetcher);
    const response = await client.request("/businesses");

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("safe status", () => {
  it("never includes token material in client-safe status", () => {
    const status = safeStatusFromConnection(connectionRecord({
      encrypted_access_token: "encrypted-access",
      encrypted_refresh_token: "encrypted-refresh",
    }));
    const serialized = JSON.stringify(status);

    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("encrypted-access");
    expect(serialized).not.toContain("encrypted-refresh");
    expect(status).toEqual({
      connected: true,
      business_display_name: "Example Removals",
      connected_at: "2026-07-14T12:00:00.000Z",
      last_refreshed_at: null,
      reauthorization_required: false,
    });
  });
});

class MemorySageStore implements SageConnectionStore {
  lastTokenUpdate: UpdateSageTokensInput | null = null;

  constructor(public connection: SageConnectionRecord | null) {}

  async getActiveConnection(): Promise<SageConnectionRecord | null> {
    return this.connection;
  }

  async saveConnection(): Promise<SageConnectionRecord> {
    throw new Error("Not needed in this test");
  }

  async updateTokens(connectionId: string, input: UpdateSageTokensInput): Promise<void> {
    this.lastTokenUpdate = input;
    this.connection = {
      ...this.connection!,
      id: connectionId,
      encrypted_access_token: input.encryptedTokens.encryptedAccessToken,
      encrypted_refresh_token: input.encryptedTokens.encryptedRefreshToken,
      access_token_nonce: input.encryptedTokens.accessTokenNonce,
      refresh_token_nonce: input.encryptedTokens.refreshTokenNonce,
      access_token_expires_at: input.accessTokenExpiresAt,
      last_refreshed_at: input.lastRefreshedAt,
    };
  }

  async disconnectActive(now: string): Promise<void> {
    if (this.connection) {
      this.connection = { ...this.connection, disconnected_at: now };
    }
  }

  async replaceTokens(accessToken: string, refreshToken: string): Promise<void> {
    const encrypted = await encryptTokenPair({
      access_token: accessToken,
      refresh_token: refreshToken,
    }, config.tokenEncryptionKey);
    this.connection = {
      ...this.connection!,
      encrypted_access_token: encrypted.encryptedAccessToken,
      encrypted_refresh_token: encrypted.encryptedRefreshToken,
      access_token_nonce: encrypted.accessTokenNonce,
      refresh_token_nonce: encrypted.refreshTokenNonce,
    };
  }
}

function connectionRecord(overrides: Partial<SageConnectionRecord> = {}): SageConnectionRecord {
  return {
    id: "connection-1",
    sage_business_id: "business-1",
    sage_business_name: "Example Removals",
    encrypted_access_token: "encrypted-access",
    encrypted_refresh_token: "encrypted-refresh",
    encryption_nonce: "",
    access_token_nonce: "access-nonce",
    refresh_token_nonce: "refresh-nonce",
    access_token_expires_at: expiryFromNow(3600),
    last_refreshed_at: null,
    connected_at: "2026-07-14T12:00:00.000Z",
    disconnected_at: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}
