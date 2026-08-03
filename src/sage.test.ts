import { describe, expect, it, vi } from "vitest";
import {
  SageApiClient,
  SageAuthorizationError,
  buildSagePlaceholderCustomerPayload,
  SageReferenceFetchError,
  SageResponseShapeError,
  SageTokenExchangeError,
  createSageDraftInvoice,
  decryptTokenPair,
  encryptTokenPair,
  exchangeAuthorizationCode,
  expiryFromNow,
  formatSageBusinessHeader,
  fetchSageLedgerAccounts,
  fetchSageTaxRates,
  searchSageContacts,
  searchSageSalesInvoices,
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
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
    });
    const fetcher = fetchMock as unknown as typeof fetch;

    const client = new SageApiClient(store, config, fetcher);
    const response = await client.request("/businesses");

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("fetches direct-array ledger accounts and follows pagination headers", async () => {
    const store = new MemorySageStore(connectionRecord());
    await store.replaceTokens("access-token", "refresh-token");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      const item = url.includes("page=1")
        ? { id: "ledger-4010", nominal_code: "4010", displayed_as: "Sales - Services" }
        : { id: "ledger-4000", nominal_code: "4000", displayed_as: "Sales" };
      return jsonResponse([item], {
        headers: { "Content-Type": "application/json", "X-Pagination-TotalPages": "2", "X-Pagination-TotalItems": "2" },
      });
    });
    const fetcher = fetchMock as unknown as typeof fetch;

    const result = await fetchSageLedgerAccounts(new SageApiClient(store, config, fetcher));
    expect(result.items.map((item) => item.id)).toEqual(["ledger-4010", "ledger-4000"]);
    expect(result.diagnostics).toHaveLength(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("attributes=all");
    const requestHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(requestHeaders.get("X-Business")).toBe("business-1");
  });

  it("calls injected fetch with the global context required by Workers", async () => {
    const store = new MemorySageStore(connectionRecord());
    await store.replaceTokens("access-token", "refresh-token");
    const fetcher = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    await fetchSageTaxRates(new SageApiClient(store, config, fetcher));
  });

  it("rejects an unexpected reference response shape instead of returning an empty list", async () => {
    const store = new MemorySageStore(connectionRecord());
    await store.replaceTokens("access-token", "refresh-token");
    const fetcher = vi.fn(async () => jsonResponse({ result: "not-a-collection" })) as unknown as typeof fetch;

    await expect(fetchSageTaxRates(new SageApiClient(store, config, fetcher))).rejects.toThrow(SageResponseShapeError);
  });

  it("requires reconnection when Sage returns 401 after the one refresh retry", async () => {
    const store = new MemorySageStore(connectionRecord());
    await store.replaceTokens("old-access", "refresh-token");
    let requestCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/tax_rates")) {
        requestCount += 1;
        return new Response("unauthorized", { status: 401 });
      }
      return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    }) as unknown as typeof fetch;

    await expect(fetchSageTaxRates(new SageApiClient(store, config, fetcher))).rejects.toThrow(SageAuthorizationError);
    expect(requestCount).toBe(2);
  });

  it.each([403, 429])("returns a safe reference error for status %s", async (status) => {
    const store = new MemorySageStore(connectionRecord());
    await store.replaceTokens("access-token", "refresh-token");
    const fetcher = vi.fn(async () => new Response("unavailable", { status })) as unknown as typeof fetch;

    await expect(fetchSageTaxRates(new SageApiClient(store, config, fetcher))).rejects.toMatchObject({
      name: "SageReferenceFetchError",
      status,
    } satisfies Partial<SageReferenceFetchError>);
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

describe("Sage business request header", () => {
  it("formats compact UUID business IDs for the Sage request header", () => {
    expect(formatSageBusinessHeader("da248186f30e4dc2a34fb73dcdc03a44")).toBe("da248186-f30e-4dc2-a34f-b73dcdc03a44");
  });
});

describe("placeholder Sage customers", () => {
  it("uses the PDF customer name and clearly marked temporary address details", () => {
    expect(buildSagePlaceholderCustomerPayload("  Charlotte Walker  ")).toEqual({
      contact: {
        name: "Charlotte Walker",
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
          name: "Charlotte Walker",
          contact_person_type_ids: ["ACCOUNTS"],
          is_main_contact: true,
        },
      },
    });
  });

  it("rejects a blank customer name", () => {
    expect(() => buildSagePlaceholderCustomerPayload("   ")).toThrow("A customer name is required.");
  });
});

describe("Sage contact search", () => {
  it("accepts the direct-array response returned by Sage contacts", async () => {
    const store = new MemorySageStore(connectionRecord());
    await store.replaceTokens("access-token", "refresh-token");
    const fetcher = vi.fn(async () => jsonResponse([
      { id: "contact-1", displayed_as: "Charlotte Walker" },
    ])) as unknown as typeof fetch;

    await expect(searchSageContacts(new SageApiClient(store, config, fetcher), "Charlotte Walker")).resolves.toMatchObject({
      items: [{ id: "contact-1", displayed_as: "Charlotte Walker" }],
      diagnostics: [{ itemCount: 1, page: 1, status: 200 }],
    });
    const requestUrl = String(vi.mocked(fetcher).mock.calls[0][0]);
    expect(requestUrl).toContain("contact_type_id=CUSTOMER");
    expect(requestUrl).toContain("search=Charlotte+Walker");
    expect(requestUrl).toContain("attributes=all");
  });

  it("follows Sage's documented $next pagination even when Sage uses a smaller page size", async () => {
    const store = new MemorySageStore(connectionRecord());
    await store.replaceTokens("access-token", "refresh-token");
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const page = new URL(String(input)).searchParams.get("page");
      return page === "1"
        ? jsonResponse({
          $total: 2,
          $page: 1,
          $next: "/contacts?page=2&items_per_page=1",
          $itemsPerPage: 1,
          $items: [{ id: "contact-1", displayed_as: "Charlotte Walker" }],
        })
        : jsonResponse({
          $total: 2,
          $page: 2,
          $next: null,
          $itemsPerPage: 1,
          $items: [{ id: "contact-2", displayed_as: "Charlotte Walker Ltd" }],
        });
    }) as unknown as typeof fetch;

    const result = await searchSageContacts(new SageApiClient(store, config, fetcher), "Charlotte");
    expect(result.items.map((item) => item.id)).toEqual(["contact-1", "contact-2"]);
    expect(result.diagnostics).toHaveLength(2);
  });

  it("preserves Sage contact permission errors for the API handler", async () => {
    const store = new MemorySageStore(connectionRecord());
    await store.replaceTokens("access-token", "refresh-token");
    const fetcher = vi.fn(async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;

    await expect(searchSageContacts(new SageApiClient(store, config, fetcher), "Charlotte")).rejects.toMatchObject({
      name: "SageReferenceFetchError",
      endpoint: expect.stringContaining("/contacts?"),
      status: 403,
    });
  });
});

describe("Sage draft invoices", () => {
  it("requests the invoice reference needed for duplicate protection", async () => {
    const store = new MemorySageStore(connectionRecord());
    await store.replaceTokens("access-token", "refresh-token");
    const fetcher = vi.fn(async () => jsonResponse([
      { id: "invoice-1", displayed_as: "SI-1", reference: "RM inv no.4632" },
    ])) as unknown as typeof fetch;

    const result = await searchSageSalesInvoices(new SageApiClient(store, config, fetcher), "RM inv no.4632");

    expect(result.items).toEqual([
      { id: "invoice-1", displayed_as: "SI-1", reference: "RM inv no.4632" },
    ]);
    const requestUrl = new URL(String(vi.mocked(fetcher).mock.calls[0][0]));
    expect(requestUrl.searchParams.get("search")).toBe("RM inv no.4632");
    expect(requestUrl.searchParams.get("attributes")).toBe("reference");
    expect(requestUrl.searchParams.get("items_per_page")).toBe("200");
  });

  it("posts the official sales_invoice wrapper and returns the created draft", async () => {
    const store = new MemorySageStore(connectionRecord());
    await store.replaceTokens("access-token", "refresh-token");
    const fetcher = vi.fn(async () => jsonResponse({ id: "invoice-1", displayed_as: "SI-1" }, { status: 201 })) as unknown as typeof fetch;
    const payload = {
      sales_invoice: {
        contact_id: "contact-1",
        date: "2026-08-01",
        due_date: "2026-08-31",
        reference: "RM inv no.4632",
        invoice_lines: [{
          description: "Removal service",
          quantity: 1,
          unit_price: 100,
          tax_amount: 20,
          ledger_account_id: "ledger-4010",
          tax_rate_id: "tax-20",
          eu_goods_services_type_id: "2",
        }],
      },
    };

    await expect(createSageDraftInvoice(new SageApiClient(store, config, fetcher), payload)).resolves.toEqual({
      id: "invoice-1",
      displayed_as: "SI-1",
    });
    const request = vi.mocked(fetcher).mock.calls[0];
    expect(String(request[0])).toBe("https://api.accounting.sage.com/v3.1/sales_invoices");
    expect(request[1]?.method).toBe("POST");
    expect(JSON.parse(String(request[1]?.body))).toEqual(payload);
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
