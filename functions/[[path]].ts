import { classifyTransactions } from "../src/classification";
import { DuplicateSourceInvoiceError, createImportDatabase, normalizeCustomerName } from "../src/db";
import { parseMonthlyInvoiceReportText } from "../src/monthlyReportParser";
import { reconcileTransactionsWithPdf } from "../src/reconciliation";
import { parseRemovalsCsv, type TransactionType } from "../src/removalsParser";
import {
  D1SageConnectionStore,
  SageApiClient,
  SageAuthorizationError,
  SageTokenExchangeError,
  createSageAuthorizationUrl,
  encryptTokenPair,
  exchangeAuthorizationCode,
  expiryFromNow,
  fetchConnectedBusiness,
  fetchSageLedgerAccounts,
  fetchSageTaxRates,
  searchSageContacts,
  safeStatusFromConnection,
  validateOAuthCallbackInput,
  type SageConnectionConfig,
} from "../src/sage";
import {
  activeReferenceEntries,
  contactMatchStatus,
  distinctLedgerCodes,
  distinctTaxCodes,
  parseSageContactItems,
  parseSageReferenceItems,
  readinessForInvoice,
  type SageReferenceType,
} from "../src/sageMappings";

interface Env {
  APP_ACCESS_PASSWORD?: string;
  SAGE_CLIENT_ID?: string;
  SAGE_CLIENT_SECRET?: string;
  SAGE_REDIRECT_URI?: string;
  SAGE_TOKEN_ENCRYPTION_KEY?: string;
  DB?: D1Database;
}

const SESSION_COOKIE = "sage_import_session";
const SAGE_OAUTH_STATE_COOKIE = "sage_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const SAGE_STATE_TTL_SECONDS = 10 * 60;
const encoder = new TextEncoder();

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  try {
    const url = new URL(request.url);

      if (url.pathname === "/assets/styles.css") {
        return textResponse(stylesCss, "text/css; charset=utf-8");
      }

      if (url.pathname === "/assets/app.js") {
        return textResponse(appJs, "text/javascript; charset=utf-8");
      }

      if ((url.pathname === "/live" || url.pathname === "/live.html") && request.method === "GET") {
        return htmlResponse(liveCheckPage());
      }

    if ((url.pathname === "/" || url.pathname === "/index.html") && request.method === "GET") {
      return context.next();
    }

      if (url.pathname === "/login" && request.method === "GET") {
        if (await isAuthenticated(request, env)) {
          return redirect("/upload");
        }
        return htmlResponse(loginPage());
      }

      if (url.pathname === "/login" && request.method === "POST") {
        return handleLogin(request, env);
      }

      if (url.pathname === "/logout" && request.method === "POST") {
        return redirect("/login", {
          "Set-Cookie": clearSessionCookie(url.protocol === "https:"),
        });
      }

      if (!(await isAuthenticated(request, env))) {
        return redirect("/login");
      }

      if (url.pathname === "/api/parse-csv" && request.method === "POST") {
        return handleCsvParse(request);
      }

      if (url.pathname === "/api/import-batches" && request.method === "POST") {
        return handleImportBatchSave(request, env);
      }

      if (url.pathname === "/api/sage/connect" && request.method === "GET") {
        return handleSageConnect(request, env);
      }

      if (url.pathname === "/api/sage/callback" && request.method === "GET") {
        return handleSageCallback(request, env);
      }

      if (url.pathname === "/api/sage/disconnect" && request.method === "POST") {
        return handleSageDisconnect(env);
      }

      if (url.pathname === "/api/sage/status" && request.method === "GET") {
        return handleSageStatus(env);
      }

      if (url.pathname === "/api/sage/references" && request.method === "GET") {
        return handleSageReferences(env);
      }

      if (url.pathname === "/api/sage/references/refresh" && request.method === "POST") {
        return handleSageReferenceRefresh(env);
      }

      if (url.pathname === "/api/sage/reference-mappings" && request.method === "POST") {
        return handleSageReferenceMappingSave(request, env);
      }

      if (url.pathname === "/api/sage/contacts/search" && request.method === "POST") {
        return handleSageContactSearch(request, env);
      }

      if (url.pathname === "/api/sage/customer-mappings" && request.method === "POST") {
        return handleSageCustomerMappingSave(request, env);
      }

      if (url.pathname === "/api/sage/readiness" && request.method === "POST") {
        return handleSageReadiness(request, env);
      }

      if ((url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/upload") && request.method === "GET") {
        return htmlResponse(uploadPage());
      }

    return context.next();
  } catch (error) {
    console.error(error);
    return htmlResponse(errorPage(), 500);
  }
};

async function handleCsvParse(request: Request): Promise<Response> {
  const form = await request.formData();
  const files = [
    { formName: "removalInvoices", transactionType: "removal" },
    { formName: "removalDeposits", transactionType: "deposit" },
    { formName: "adHocInvoices", transactionType: "ad_hoc" },
    { formName: "creditNotes", transactionType: "credit_note" },
  ] satisfies Array<{ formName: string; transactionType: TransactionType }>;

  const parsedFiles = [];
  const rows = [];
  const monthlyReportText = String(form.get("monthlyReportText") ?? "");

  for (const config of files) {
    const file = form.get(config.formName);

    if (!(file instanceof File) || file.size === 0) {
      continue;
    }

    if (!file.name.toLowerCase().endsWith(".csv")) {
      parsedFiles.push({
        field: config.formName,
        file_name: file.name,
        transaction_type: config.transactionType,
        rows: 0,
        warnings: [`${file.name} was skipped because it is not a CSV file.`],
      });
      continue;
    }

    const text = await file.text();
    const parsedRows = parseRemovalsCsv(text, {
      transactionType: config.transactionType,
      sourceFile: file.name,
    });

    parsedFiles.push({
      field: config.formName,
      file_name: file.name,
      transaction_type: config.transactionType,
      rows: parsedRows.length,
      warnings: [],
    });
    rows.push(...parsedRows);
  }

  const pdfRows = monthlyReportText ? parseMonthlyInvoiceReportText(monthlyReportText) : [];
  const reconciliationResult = pdfRows.length > 0
    ? reconcileTransactionsWithPdf(rows, pdfRows)
    : { transactions: rows, pdf_rows: [], reconciliation: [] };
  const classificationResult = classifyTransactions(
    reconciliationResult.transactions,
    reconciliationResult.reconciliation,
  );

  return jsonResponse({
    files: parsedFiles,
    rows: classificationResult.transactions,
    pdf_rows: reconciliationResult.pdf_rows,
    reconciliation: reconciliationResult.reconciliation,
    classification_summary: classificationResult.summary,
    totals: {
      files: parsedFiles.length,
      rows: classificationResult.transactions.length,
      rows_with_warnings: classificationResult.transactions.filter((row) => row.warnings.length > 0).length,
      pdf_rows: reconciliationResult.pdf_rows.length,
      reconciliation_rows: reconciliationResult.reconciliation.length,
    },
  });
}

async function handleImportBatchSave(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({
      ok: false,
      error: "D1 database is not configured yet. Add the DB binding before saving reviewed batches.",
    }, 503);
  }

  const body = await request.json() as {
    reporting_month?: string | null;
    original_file_names?: string[];
    rows?: [];
  };
  const rows = Array.isArray(body.rows) ? body.rows : [];

  if (rows.length === 0) {
    return jsonResponse({ ok: false, error: "There are no reviewed transactions to save." }, 400);
  }

  const database = createImportDatabase(env.DB);
  const createdBy = await sessionIdentifier(request);

  try {
    const result = await database.saveReviewedBatch({
      reportingMonth: body.reporting_month ?? null,
      createdBy,
      originalFileNames: Array.isArray(body.original_file_names) ? body.original_file_names : [],
      rows,
    });

    return jsonResponse({
      ok: true,
      import_batch_id: result.batch.id,
      invoice_count: result.batch.invoice_count,
      duplicate_blocked: false,
    });
  } catch (error) {
    if (error instanceof DuplicateSourceInvoiceError) {
      return jsonResponse({
        ok: false,
        duplicate_blocked: true,
        error: "One or more of these source invoices has already been saved.",
      }, 409);
    }

    console.error("Failed to save import batch", error);
    return jsonResponse({ ok: false, error: "The reviewed batch could not be saved." }, 500);
  }
}

async function handleSageConnect(request: Request, env: Env): Promise<Response> {
  const config = sageConfigFromEnv(env);
  if (!config.ok) {
    return jsonResponse({ ok: false, error: config.error }, 503);
  }

  const url = new URL(request.url);
  const state = base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  return redirect(createSageAuthorizationUrl(config.value, state), {
    "Set-Cookie": createSageStateCookie(state, url.protocol === "https:"),
  });
}

async function handleSageCallback(request: Request, env: Env): Promise<Response> {
  const config = sageConfigFromEnv(env);
  const url = new URL(request.url);
  const secure = url.protocol === "https:";

  if (!config.ok) {
    return jsonResponse({ ok: false, error: config.error }, 503, {
      "Set-Cookie": clearCookie(SAGE_OAUTH_STATE_COOKIE, secure),
    });
  }

  if (!env.DB) {
    return jsonResponse({ ok: false, error: "D1 database is not configured yet." }, 503, {
      "Set-Cookie": clearCookie(SAGE_OAUTH_STATE_COOKIE, secure),
    });
  }

  const expectedState = getCookie(request.headers.get("Cookie") ?? "", SAGE_OAUTH_STATE_COOKIE);
  const returnedState = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const validation = validateOAuthCallbackInput(expectedState, returnedState, code, constantTimeEqual);
  if (!validation.ok) {
    return jsonResponse({ ok: false, error: validation.error }, validation.status, {
      "Set-Cookie": clearCookie(SAGE_OAUTH_STATE_COOKIE, secure),
    });
  }

  try {
    const tokens = await exchangeAuthorizationCode(config.value, validation.code);
    const business = await fetchConnectedBusiness(tokens.access_token);
    const encryptedTokens = await encryptTokenPair(tokens, config.value.tokenEncryptionKey);
    const store = new D1SageConnectionStore(env.DB);
    await store.saveConnection({
      business,
      encryptedTokens,
      accessTokenExpiresAt: expiryFromNow(tokens.expires_in),
      connectedAt: new Date().toISOString(),
    });

    return redirect("/upload?sage=connected", {
      "Set-Cookie": clearCookie(SAGE_OAUTH_STATE_COOKIE, secure),
    });
  } catch (error) {
    if (error instanceof SageTokenExchangeError) {
      return jsonResponse({ ok: false, error: "Sage token exchange failed." }, 502, {
        "Set-Cookie": clearCookie(SAGE_OAUTH_STATE_COOKIE, secure),
      });
    }

    console.error("Sage OAuth callback failed", safeError(error));
    return jsonResponse({ ok: false, error: "Sage could not be connected." }, 502, {
      "Set-Cookie": clearCookie(SAGE_OAUTH_STATE_COOKIE, secure),
    });
  }
}

async function handleSageDisconnect(env: Env): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({ ok: false, error: "D1 database is not configured yet." }, 503);
  }

  const store = new D1SageConnectionStore(env.DB);
  await store.disconnectActive(new Date().toISOString());
  return jsonResponse({ ok: true, connected: false });
}

async function handleSageStatus(env: Env): Promise<Response> {
  if (!env.DB) {
    return jsonResponse({
      connected: false,
      business_display_name: null,
      connected_at: null,
      last_refreshed_at: null,
      reauthorization_required: false,
      storage_configured: false,
    });
  }

  const store = new D1SageConnectionStore(env.DB);
  const status = safeStatusFromConnection(await store.getActiveConnection());
  return jsonResponse({ ...status, storage_configured: true });
}

async function handleSageReferences(env: Env): Promise<Response> {
  const database = databaseFromEnv(env);
  if (!database.ok) {
    return jsonResponse(database.body, database.status);
  }

  const [taxRates, ledgerAccounts, taxMappings, ledgerMappings, customerMappings] = await Promise.all([
    database.value.listSageReferenceCache("tax_rate"),
    database.value.listSageReferenceCache("ledger_account"),
    database.value.listReferenceMappings("tax_rate"),
    database.value.listReferenceMappings("ledger_account"),
    database.value.listCustomerMappings(),
  ]);

  return jsonResponse({
    tax_rates: taxRates,
    ledger_accounts: ledgerAccounts,
    active_tax_rates: activeReferenceEntries(taxRates),
    active_ledger_accounts: activeReferenceEntries(ledgerAccounts),
    tax_mappings: taxMappings,
    ledger_mappings: ledgerMappings,
    customer_mappings: customerMappings,
  });
}

async function handleSageReferenceRefresh(env: Env): Promise<Response> {
  const database = databaseFromEnv(env);
  if (!database.ok) {
    return jsonResponse(database.body, database.status);
  }

  const client = sageClientFromEnv(env);
  if (!client.ok) {
    return jsonResponse(client.body, client.status);
  }

  try {
    const [ledgerData, taxData] = await Promise.all([
      fetchSageLedgerAccounts(client.value),
      fetchSageTaxRates(client.value),
    ]);
    const ledgerAccounts = parseSageReferenceItems(ledgerData, "ledger_account");
    const taxRates = parseSageReferenceItems(taxData, "tax_rate");
    const now = new Date().toISOString();

    await Promise.all([
      database.value.replaceSageReferenceCache("ledger_account", ledgerAccounts, now),
      database.value.replaceSageReferenceCache("tax_rate", taxRates, now),
    ]);

    return jsonResponse({
      ok: true,
      ledger_accounts: ledgerAccounts.length,
      tax_rates: taxRates.length,
      refreshed_at: now,
    });
  } catch (error) {
    if (error instanceof SageAuthorizationError) {
      return jsonResponse({ ok: false, error: "Reconnect Sage before refreshing reference data." }, 401);
    }
    console.error("Sage reference refresh failed", safeError(error));
    return jsonResponse({ ok: false, error: "Sage reference data could not be refreshed." }, 502);
  }
}

async function handleSageReferenceMappingSave(request: Request, env: Env): Promise<Response> {
  const database = databaseFromEnv(env);
  if (!database.ok) {
    return jsonResponse(database.body, database.status);
  }

  const body = await request.json() as {
    mapping_type?: SageReferenceType;
    source_code?: string;
    source_context?: string;
    sage_entity_id?: string;
    sage_display_name?: string;
  };

  if ((body.mapping_type !== "tax_rate" && body.mapping_type !== "ledger_account") || !body.source_code || !body.sage_entity_id || !body.sage_display_name) {
    return jsonResponse({ ok: false, error: "Mapping details are incomplete." }, 400);
  }

  await database.value.saveReferenceMapping({
    mapping_type: body.mapping_type,
    source_code: body.source_code,
    source_context: body.mapping_type === "ledger_account" ? String(body.source_context ?? "") : "",
    sage_entity_id: body.sage_entity_id,
    sage_display_name: body.sage_display_name,
    manually_confirmed: true,
  });

  return jsonResponse({ ok: true });
}

async function handleSageContactSearch(request: Request, env: Env): Promise<Response> {
  const database = databaseFromEnv(env);
  if (!database.ok) {
    return jsonResponse(database.body, database.status);
  }

  const client = sageClientFromEnv(env);
  if (!client.ok) {
    return jsonResponse(client.body, client.status);
  }

  const body = await request.json() as { customer_name?: string; normalized_customer_name?: string };
  const customerName = String(body.customer_name ?? "").trim();
  const normalizedCustomerName = String(body.normalized_customer_name ?? "").trim();
  const searchTerm = customerName || normalizedCustomerName;

  if (!searchTerm) {
    return jsonResponse({ ok: false, error: "Customer name is required." }, 400);
  }

  try {
    const [exactData, normalizedData, savedMappings] = await Promise.all([
      searchSageContacts(client.value, customerName || normalizedCustomerName),
      normalizedCustomerName && normalizedCustomerName !== customerName ? searchSageContacts(client.value, normalizedCustomerName) : Promise.resolve({ $items: [] }),
      database.value.listCustomerMappings(),
    ]);
    const matchesById = new Map([
      ...parseSageContactItems(exactData),
      ...parseSageContactItems(normalizedData),
    ].map((match) => [match.sage_contact_id, match]));
    const matches = [...matchesById.values()];
    const normalized = normalizedCustomerName || normalizeForClient(customerName);

    return jsonResponse({
      ok: true,
      customer_name: customerName,
      normalized_customer_name: normalized,
      matches,
      match_status: contactMatchStatus(normalized, matches),
      saved_mapping: savedMappings.find((mapping) => mapping.normalized_customer_name === normalized) ?? null,
      missing_contact_message: matches.length === 0 ? "Create or complete this customer in Sage, then refresh contacts." : null,
    });
  } catch (error) {
    if (error instanceof SageAuthorizationError) {
      return jsonResponse({ ok: false, error: "Reconnect Sage before searching contacts." }, 401);
    }
    console.error("Sage contact search failed", safeError(error));
    return jsonResponse({ ok: false, error: "Sage contacts could not be searched." }, 502);
  }
}

async function handleSageCustomerMappingSave(request: Request, env: Env): Promise<Response> {
  const database = databaseFromEnv(env);
  if (!database.ok) {
    return jsonResponse(database.body, database.status);
  }

  const body = await request.json() as {
    normalized_customer_name?: string;
    customer_email?: string | null;
    postcode?: string | null;
    sage_contact_id?: string;
    sage_contact_display_name?: string;
  };

  if (!body.normalized_customer_name || !body.sage_contact_id || !body.sage_contact_display_name) {
    return jsonResponse({ ok: false, error: "Customer mapping details are incomplete." }, 400);
  }

  await database.value.saveCustomerMapping({
    normalized_customer_name: body.normalized_customer_name,
    customer_email: body.customer_email ?? null,
    postcode: body.postcode ?? null,
    sage_contact_id: body.sage_contact_id,
    sage_contact_display_name: body.sage_contact_display_name,
    manually_confirmed: true,
  });

  return jsonResponse({ ok: true });
}

async function handleSageReadiness(request: Request, env: Env): Promise<Response> {
  const database = databaseFromEnv(env);
  if (!database.ok) {
    return jsonResponse(database.body, database.status);
  }

  const body = await request.json() as { rows?: Array<Record<string, unknown>> };
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const [customerMappings, taxMappings, ledgerMappings, importedIds] = await Promise.all([
    database.value.listCustomerMappings(),
    database.value.listReferenceMappings("tax_rate"),
    database.value.listReferenceMappings("ledger_account"),
    database.value.importedSourceInvoiceIds(rows.map((row) => String(row.source_invoice_id ?? "")).filter(Boolean)),
  ]);

  const context = {
    customerMappings,
    taxMappings,
    ledgerMappings,
    importedSourceInvoiceIds: importedIds,
  };

  return jsonResponse({
    ok: true,
    readiness: rows.map((row, index) => ({
      review_id: row.review_id ?? String(index),
      status: readinessForInvoice(row as never, context),
    })),
    distinct_tax_codes: distinctTaxCodes(rows as never),
    distinct_ledger_codes: distinctLedgerCodes(rows as never),
  });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const configuredPassword = env.APP_ACCESS_PASSWORD;
  const url = new URL(request.url);

  if (!configuredPassword) {
    return htmlResponse(loginPage("APP_ACCESS_PASSWORD is not configured for this environment."), 500);
  }

  const form = await request.formData();
  const password = String(form.get("password") ?? "");

  if (!constantTimeEqual(password, configuredPassword)) {
    return htmlResponse(loginPage("That password was not recognised."), 401);
  }

  const cookie = await createSessionCookie(configuredPassword, url.protocol === "https:");
  return redirect("/upload", {
    "Set-Cookie": cookie,
  });
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const configuredPassword = env.APP_ACCESS_PASSWORD;

  if (!configuredPassword) {
    return false;
  }

  const cookie = getCookie(request.headers.get("Cookie") ?? "", SESSION_COOKIE);
  if (!cookie) {
    return false;
  }

  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) {
    return false;
  }

  const expectedSignature = await sign(payload, configuredPassword);
  if (!constantTimeEqual(signature, expectedSignature)) {
    return false;
  }

  try {
    const session = JSON.parse(atobUrl(payload)) as { exp?: number };
    return typeof session.exp === "number" && session.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function createSessionCookie(secret: string, secure: boolean): Promise<string> {
  const payload = btoaUrl(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      nonce: crypto.randomUUID(),
    }),
  );
  const signature = await sign(payload, secret);
  const attributes = [
    `${SESSION_COOKIE}=${payload}.${signature}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

function clearSessionCookie(secure: boolean): string {
  return clearCookie(SESSION_COOKIE, secure);
}

function clearCookie(name: string, secure: boolean): string {
  const attributes = [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

function createSageStateCookie(state: string, secure: boolean): string {
  const attributes = [
    `${SAGE_OAUTH_STATE_COOKIE}=${state}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SAGE_STATE_TTL_SECONDS}`,
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

function sageConfigFromEnv(env: Env): { ok: true; value: SageConnectionConfig } | { ok: false; error: string } {
  const clientId = env.SAGE_CLIENT_ID;
  const clientSecret = env.SAGE_CLIENT_SECRET;
  const redirectUri = env.SAGE_REDIRECT_URI;
  const tokenEncryptionKey = env.SAGE_TOKEN_ENCRYPTION_KEY;

  if (!clientId || !clientSecret || !redirectUri || !tokenEncryptionKey) {
    return {
      ok: false,
      error: "Sage OAuth is not configured. Set SAGE_CLIENT_ID, SAGE_REDIRECT_URI, SAGE_CLIENT_SECRET and SAGE_TOKEN_ENCRYPTION_KEY.",
    };
  }

  return {
    ok: true,
    value: {
      clientId,
      clientSecret,
      redirectUri,
      tokenEncryptionKey,
    },
  };
}

function databaseFromEnv(env: Env): { ok: true; value: ReturnType<typeof createImportDatabase> } | { ok: false; status: number; body: { ok: false; error: string } } {
  if (!env.DB) {
    return {
      ok: false,
      status: 503,
      body: { ok: false, error: "D1 database is not configured yet." },
    };
  }

  return { ok: true, value: createImportDatabase(env.DB) };
}

function sageClientFromEnv(env: Env): { ok: true; value: SageApiClient } | { ok: false; status: number; body: { ok: false; error: string } } {
  if (!env.DB) {
    return {
      ok: false,
      status: 503,
      body: { ok: false, error: "D1 database is not configured yet." },
    };
  }

  const config = sageConfigFromEnv(env);
  if (!config.ok) {
    return {
      ok: false,
      status: 503,
      body: { ok: false, error: config.error },
    };
  }

  return {
    ok: true,
    value: new SageApiClient(new D1SageConnectionStore(env.DB), config.value),
  };
}

function safeError(error: unknown): Record<string, string> {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "Unknown error",
  };
}

function normalizeForClient(value: string): string {
  return normalizeCustomerName(value);
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlFromBytes(new Uint8Array(signature));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}

function getCookie(header: string, name: string): string | null {
  const cookies = header.split(";").map((part) => part.trim());

  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator === -1) {
      continue;
    }

    if (cookie.slice(0, separator) === name) {
      return cookie.slice(separator + 1);
    }
  }

  return null;
}

async function sessionIdentifier(request: Request): Promise<string> {
  const cookie = getCookie(request.headers.get("Cookie") ?? "", SESSION_COOKIE) ?? "unknown-session";
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(cookie));
  return `session:${base64UrlFromBytes(new Uint8Array(digest)).slice(0, 24)}`;
}

function btoaUrl(value: string): string {
  return base64UrlFromBytes(encoder.encode(value));
}

function atobUrl(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      ...headers,
    },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...securityHeaders,
    },
  });
}

function textResponse(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      ...securityHeaders,
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...securityHeaders,
      ...headers,
    },
  });
}

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function loginPage(error?: string): string {
  return layout(
    "Login",
    `
      <main class="login-shell">
        <section class="login-card" aria-labelledby="login-title">
          <div class="brand-mark" aria-hidden="true">SI</div>
          <p class="eyebrow">Private import checker</p>
          <h1 id="login-title">Sage Import Checker</h1>
          <p class="lede">Sign in to review Removals Manager exports before preparing them for Sage.</p>
          ${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ""}
          <form method="post" action="/login" class="login-form">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
            <button type="submit">Sign in</button>
          </form>
        </section>
      </main>
    `,
  );
}

function liveCheckPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sage Import Live Check</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #1d2528;
        --muted: #647174;
        --line: #d9e0df;
        --sage: #0f6b5b;
        --canvas: #f4f7f6;
      }

      * {
        box-sizing: border-box;
      }

      body {
        display: grid;
        min-height: 100vh;
        margin: 0;
        place-items: center;
        background: linear-gradient(135deg, rgba(15, 107, 91, 0.12), transparent 34rem), var(--canvas);
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      main {
        width: min(92vw, 620px);
        padding: 34px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #ffffff;
        box-shadow: 0 18px 50px rgba(31, 49, 54, 0.12);
      }

      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }

      .eyebrow {
        margin-bottom: 10px;
        color: var(--sage);
        font-size: 0.78rem;
        font-weight: 800;
        text-transform: uppercase;
      }

      h1 {
        margin: 0 0 14px;
        font-size: clamp(2rem, 5vw, 3rem);
        line-height: 1;
      }

      .status {
        display: inline-flex;
        margin-top: 22px;
        padding: 9px 12px;
        border-radius: 999px;
        background: rgba(15, 107, 91, 0.1);
        color: var(--sage);
        font-weight: 800;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Sage Import Checker</p>
      <h1>Tool is live.</h1>
      <p>If you can see this at sage-import.27tools.co, the custom domain is reaching the Cloudflare Worker.</p>
      <p class="status">Live check page loaded</p>
    </main>
  </body>
</html>`;
}

function uploadPage(): string {
  return layout(
    "Upload files",
    `
      <header class="topbar">
        <div>
          <p class="eyebrow">Removals Manager to Sage</p>
          <h1>Sage Import Checker</h1>
        </div>
        <form method="post" action="/logout">
          <button class="secondary-button" type="submit">Logout</button>
        </form>
      </header>

      <main class="dashboard-shell">
        <section class="hero-panel">
          <div>
            <p class="eyebrow">Upload check</p>
            <h2>Add the export files you have available.</h2>
            <p>CSV files are parsed in memory, and the monthly report PDF can be used to match customer names, service types, totals and VAT. Nothing is stored permanently.</p>
          </div>
          <div class="status-stack" aria-label="Current safeguards">
            <span>Private login</span>
            <span>Optional files</span>
            <span>No file storage</span>
          </div>
        </section>

        <section class="sage-card" aria-labelledby="sage-title">
          <div>
            <p class="eyebrow">Sage connection</p>
            <h2 id="sage-title">Business Cloud Accounting</h2>
            <p id="sageStatusText">Checking Sage connection status...</p>
          </div>
          <div class="sage-actions">
            <a id="sageConnectLink" class="button-link" href="/api/sage/connect">Connect Sage</a>
            <button id="sageDisconnectButton" class="secondary-button" type="button" disabled>Disconnect Sage</button>
          </div>
          <p class="sage-note">Read-only connection stage. This app will not create contacts, invoices or credit notes yet.</p>
        </section>

        <section class="upload-workflow" aria-labelledby="upload-title">
          <div class="section-heading">
            <div>
              <h2 id="upload-title">File upload</h2>
              <p>Each file is optional for now. Add whichever Removals Manager exports you can get, then check the files before moving on.</p>
            </div>
            <div class="button-row">
              <button id="checkButton" type="button">Check files</button>
              <button id="clearButton" class="secondary-button" type="button" disabled>Clear</button>
            </div>
          </div>

          <form id="uploadForm" class="upload-grid">
            <article class="file-card" data-slot="removalInvoices">
              <div>
                <h3>Removal invoices CSV</h3>
                <p>Use the main removals invoice export from Removals Manager.</p>
              </div>
              <label for="removalInvoices">Choose CSV</label>
              <input id="removalInvoices" type="file" accept=".csv,text/csv">
              <p class="field-message" id="removalInvoicesMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="removalDeposits">
              <div>
                <h3>Removal deposits CSV</h3>
                <p>Use this if deposits are exported separately from invoices.</p>
              </div>
              <label for="removalDeposits">Choose CSV</label>
              <input id="removalDeposits" type="file" accept=".csv,text/csv">
              <p class="field-message" id="removalDepositsMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="adHocInvoices">
              <div>
                <h3>Ad Hoc invoices CSV</h3>
                <p>Use the ad hoc invoice export if Removals Manager provides one.</p>
              </div>
              <label for="adHocInvoices">Choose CSV</label>
              <input id="adHocInvoices" type="file" accept=".csv,text/csv">
              <p class="field-message" id="adHocInvoicesMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="creditNotes">
              <div>
                <h3>Credit notes CSV</h3>
                <p>Add credit notes here if Removals Manager can export them.</p>
              </div>
              <label for="creditNotes">Choose CSV</label>
              <input id="creditNotes" type="file" accept=".csv,text/csv">
              <p class="field-message" id="creditNotesMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="monthlyReport">
              <div>
                <h3>Monthly invoice report PDF</h3>
                <p>Add the monthly invoice report PDF if it is available for checking later.</p>
              </div>
              <label for="monthlyReport">Choose PDF</label>
              <input id="monthlyReport" type="file" accept=".pdf,application/pdf">
              <p class="field-message" id="monthlyReportMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="invoicePdfs">
              <div>
                <h3>Individual invoice PDFs</h3>
                <p>Add a batch of invoice PDFs if you have them. Multiple files are allowed.</p>
              </div>
              <label for="invoicePdfs">Choose PDFs</label>
              <input id="invoicePdfs" type="file" accept=".pdf,application/pdf" multiple>
              <p class="field-message" id="invoicePdfsMessage">No files selected yet. This is optional.</p>
            </article>
          </form>
        </section>

        <section class="results-panel" aria-live="polite">
          <div class="section-heading">
            <div>
              <h2>Parsed preview</h2>
              <p id="resultsIntro">Choose any files you have, then select Check files.</p>
            </div>
          </div>
          <div id="summaryNotice" class="notice"></div>
          <div id="classificationSummary" class="summary-cards compact">
            <article><strong>0</strong><span>Total rows</span></article>
            <article><strong>0</strong><span>Import candidates</span></article>
            <article><strong>0</strong><span>Excluded storage</span></article>
            <article><strong>0</strong><span>Needs review</span></article>
            <article><strong>0</strong><span>Duplicate warnings</span></article>
            <article><strong>0.00</strong><span>Candidate value</span></article>
            <article><strong>0.00</strong><span>Excluded value</span></article>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Row</th>
                  <th>Type</th>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Customer</th>
                  <th>Service</th>
                  <th>Amount</th>
                  <th>VAT</th>
                  <th>Classification</th>
                  <th>Default export</th>
                  <th>Warnings</th>
                </tr>
              </thead>
              <tbody id="summaryBody">
                <tr><td colspan="13" class="empty-state">No files checked yet.</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="results-panel" aria-live="polite">
          <div class="section-heading">
            <div>
              <h2>Reconciliation</h2>
              <p id="reconciliationIntro">Upload CSV exports and the monthly invoice report PDF to compare invoice-level totals.</p>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Status</th>
                  <th>Customer</th>
                  <th>Service</th>
                  <th>CSV total</th>
                  <th>PDF total</th>
                  <th>CSV VAT</th>
                  <th>PDF VAT</th>
                  <th>Warnings</th>
                </tr>
              </thead>
              <tbody id="reconciliationBody">
                <tr><td colspan="9" class="empty-state">No reconciliation run yet.</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="results-panel review-panel" aria-live="polite">
          <div class="section-heading">
            <div>
              <h2>Review transactions</h2>
              <p id="reviewIntro">This is a checking stage only. Nothing here is sent to Sage, and the report is for review before any future export.</p>
            </div>
            <div class="button-row">
              <button id="saveBatchButton" type="button" disabled>Save reviewed batch</button>
              <button id="exportReviewButton" class="secondary-button" type="button" disabled>Export review CSV</button>
            </div>
          </div>
          <div id="reviewSaveNotice" class="notice"></div>
          <div id="reviewFilters" class="filter-row" aria-label="Review filters">
            <button type="button" class="filter-button active" data-filter="all">All</button>
            <button type="button" class="filter-button" data-filter="import_candidates">Import candidates</button>
            <button type="button" class="filter-button" data-filter="excluded_storage">Excluded storage</button>
            <button type="button" class="filter-button" data-filter="needs_review">Needs review</button>
            <button type="button" class="filter-button" data-filter="mismatches">Mismatches</button>
            <button type="button" class="filter-button" data-filter="missing_customer">Missing customer</button>
          </div>
          <div id="reviewTotals" class="summary-cards review-totals">
            <article><strong>0</strong><span>Included rows</span></article>
            <article><strong>0.00</strong><span>Included net</span></article>
            <article><strong>0.00</strong><span>Included VAT</span></article>
            <article><strong>0.00</strong><span>Included gross</span></article>
            <article><strong>0</strong><span>Review needed</span></article>
            <article><strong>0</strong><span>Excluded rows</span></article>
          </div>
          <div class="table-wrap">
            <table class="review-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Source file type</th>
                  <th>Service</th>
                  <th>Description</th>
                  <th>Net</th>
                  <th>VAT</th>
                  <th>Gross</th>
                  <th>Classification</th>
                  <th>Warnings</th>
                  <th>Sage readiness</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="reviewBody">
                <tr><td colspan="13" class="empty-state">No transactions ready for review yet.</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="results-panel mapping-panel" aria-live="polite">
          <div class="section-heading">
            <div>
              <h2>Sage mappings</h2>
              <p id="mappingIntro">Map Removals Manager tax codes, nominal codes and customers to existing Sage records before any future Sage export.</p>
            </div>
            <div class="button-row">
              <button id="refreshSageReferencesButton" class="secondary-button" type="button">Refresh Sage references</button>
            </div>
          </div>
          <div id="mappingNotice" class="notice"></div>
          <div class="mapping-grid">
            <article>
              <h3>Tax mappings</h3>
              <p>Do not assume an old Removals Manager tax code matches a Sage tax rate. Choose and save each one.</p>
              <div id="taxMappingBody" class="mapping-list">
                <p class="empty-state">No uploaded tax codes yet.</p>
              </div>
            </article>
            <article>
              <h3>Ledger mappings</h3>
              <p>Map each nominal code separately for removals, deposits, ad hoc invoices and credit notes.</p>
              <div id="ledgerMappingBody" class="mapping-list">
                <p class="empty-state">No uploaded nominal codes yet.</p>
              </div>
            </article>
            <article>
              <h3>Customer matching</h3>
              <p>Search Sage contacts and manually confirm the right match. Fuzzy matches are never accepted automatically.</p>
              <div id="customerMappingBody" class="mapping-list">
                <p class="empty-state">No customers found in the reviewed rows yet.</p>
              </div>
            </article>
          </div>
        </section>
      </main>
      <script src="/assets/app.js" defer></script>
    `,
  );
}

function notFoundPage(): string {
  return layout("Not found", `<main class="message-page"><h1>Page not found</h1><a href="/">Return to dashboard</a></main>`);
}

function errorPage(): string {
  return layout("Error", `<main class="message-page"><h1>Something went wrong</h1><p>Please retry the request.</p></main>`);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} | Sage Import Checker</title>
    <link rel="stylesheet" href="/assets/styles.css">
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const stylesCss = String.raw`
:root {
  color-scheme: light;
  --ink: #1d2528;
  --muted: #647174;
  --line: #d9e0df;
  --panel: #ffffff;
  --canvas: #f4f7f6;
  --sage: #0f6b5b;
  --sage-dark: #0a4a42;
  --sky: #dceff5;
  --warn: #a65319;
  --danger: #9b1c31;
  --shadow: 0 18px 50px rgba(31, 49, 54, 0.12);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background:
    linear-gradient(135deg, rgba(15, 107, 91, 0.09), transparent 32rem),
    var(--canvas);
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

button,
input {
  font: inherit;
}

button {
  border: 0;
  border-radius: 8px;
  background: var(--sage);
  color: #ffffff;
  cursor: pointer;
  font-weight: 700;
}

button:hover {
  background: var(--sage-dark);
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.login-shell {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 24px;
}

.login-card {
  width: min(100%, 430px);
  padding: 34px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: var(--shadow);
}

.brand-mark {
  display: grid;
  width: 48px;
  height: 48px;
  margin-bottom: 24px;
  place-items: center;
  border-radius: 8px;
  background: var(--sage);
  color: #ffffff;
  font-weight: 800;
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--sage);
  font-size: 0.76rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 10px;
  font-size: clamp(1.85rem, 4vw, 2.55rem);
  line-height: 1.05;
}

h2 {
  margin-bottom: 10px;
  font-size: 1.15rem;
}

.lede,
.hero-panel p,
.upload-workflow p,
.section-heading p {
  color: var(--muted);
  line-height: 1.55;
}

.alert {
  padding: 12px 14px;
  border: 1px solid rgba(155, 28, 49, 0.2);
  border-radius: 8px;
  background: rgba(155, 28, 49, 0.08);
  color: var(--danger);
  font-weight: 700;
}

.login-form {
  display: grid;
  gap: 12px;
  margin-top: 24px;
}

.login-form label {
  color: var(--muted);
  font-size: 0.92rem;
  font-weight: 700;
}

.login-form input {
  width: 100%;
  padding: 13px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #ffffff;
}

.login-form button {
  min-height: 46px;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 22px clamp(18px, 4vw, 48px);
  border-bottom: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(10px);
}

.topbar h1 {
  margin-bottom: 0;
  font-size: 1.35rem;
}

.secondary-button {
  min-height: 40px;
  padding: 0 15px;
  border: 1px solid var(--line);
  background: #ffffff;
  color: var(--ink);
}

.secondary-button:hover {
  background: #eef4f2;
}

.dashboard-shell {
  width: min(1180px, calc(100% - 32px));
  margin: 28px auto 56px;
}

.hero-panel,
.sage-card,
.upload-workflow,
.results-panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 12px 32px rgba(31, 49, 54, 0.08);
}

.hero-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 24px;
  align-items: center;
  padding: clamp(22px, 4vw, 34px);
  background:
    linear-gradient(120deg, rgba(15, 107, 91, 0.12), rgba(220, 239, 245, 0.55)),
    #ffffff;
}

.hero-panel h2 {
  max-width: 760px;
  font-size: clamp(1.55rem, 3vw, 2.35rem);
  line-height: 1.12;
}

.status-stack {
  display: grid;
  gap: 10px;
  min-width: 190px;
}

.status-stack span {
  padding: 10px 12px;
  border: 1px solid rgba(15, 107, 91, 0.18);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.75);
  color: var(--sage-dark);
  font-size: 0.9rem;
  font-weight: 800;
}

.upload-workflow,
.sage-card,
.results-panel {
  margin-top: 18px;
  padding: 22px;
}

.sage-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  align-items: center;
}

.sage-card p {
  margin-bottom: 0;
  color: var(--muted);
  line-height: 1.55;
}

.sage-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
}

.button-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: 0 15px;
  border-radius: 8px;
  background: var(--sage);
  color: #ffffff;
  font-weight: 800;
  text-decoration: none;
}

.button-link:hover {
  background: var(--sage-dark);
}

.sage-note {
  grid-column: 1 / -1;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  font-weight: 700;
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
}

.button-row button {
  min-height: 40px;
  padding: 0 16px;
}

.upload-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.file-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 14px;
  align-items: center;
  min-height: 158px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fbfa;
}

.file-card h3 {
  margin: 0 0 8px;
  font-size: 1rem;
}

.file-card p {
  margin-bottom: 0;
}

.file-card label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: 0 14px;
  border-radius: 8px;
  background: var(--sage);
  color: #ffffff;
  cursor: pointer;
  font-weight: 800;
  white-space: nowrap;
}

.file-card label:hover {
  background: var(--sage-dark);
}

.file-card input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.field-message {
  grid-column: 1 / -1;
  min-height: 22px;
  color: var(--muted);
  font-size: 0.88rem;
  font-weight: 650;
}

.field-message.error {
  color: var(--danger);
}

.field-message.success {
  color: var(--sage-dark);
}

.summary-cards {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 18px;
}

.review-totals {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}

.summary-cards article {
  min-height: 82px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fbfa;
}

.summary-cards strong {
  display: block;
  margin-bottom: 6px;
  font-size: 1.25rem;
}

.summary-cards span {
  color: var(--muted);
  font-size: 0.78rem;
  font-weight: 800;
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 18px;
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.filter-button {
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--line);
  background: #ffffff;
  color: var(--ink);
  font-size: 0.86rem;
}

.filter-button:hover,
.filter-button.active {
  border-color: rgba(15, 107, 91, 0.4);
  background: rgba(15, 107, 91, 0.1);
  color: var(--sage-dark);
}

.notice {
  display: none;
  margin-bottom: 18px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: #f8fbfa;
  color: var(--muted);
  font-weight: 700;
}

.notice.show {
  display: block;
}

.notice.error {
  border-color: rgba(155, 28, 49, 0.25);
  background: rgba(155, 28, 49, 0.08);
  color: var(--danger);
}

.notice.success {
  border-color: rgba(15, 107, 91, 0.22);
  background: rgba(15, 107, 91, 0.08);
  color: var(--sage-dark);
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
}

table {
  width: 100%;
  min-width: 900px;
  border-collapse: collapse;
  background: #ffffff;
}

.review-table {
  min-width: 1430px;
}

.mapping-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}

.mapping-grid article {
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fbfa;
}

.mapping-grid h3 {
  margin: 0 0 8px;
}

.mapping-list {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}

.mapping-row {
  display: grid;
  grid-template-columns: minmax(170px, 0.8fr) minmax(240px, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #ffffff;
}

.mapping-row strong,
.mapping-row small {
  display: block;
}

.mapping-row small {
  color: var(--muted);
  font-weight: 700;
}

.mapping-row select {
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #ffffff;
  color: var(--ink);
  font: inherit;
}

.mapping-row button {
  min-height: 40px;
  padding: 0 12px;
}

.contact-actions {
  display: grid;
  gap: 8px;
}

th,
td {
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
  font-size: 0.91rem;
}

th {
  background: #f1f6f5;
  color: #405054;
  font-size: 0.78rem;
  font-weight: 800;
  text-transform: uppercase;
}

tbody tr:last-child td {
  border-bottom: 0;
}

tr.risky-row {
  background: rgba(166, 83, 25, 0.05);
}

tr.risky-row.high-risk {
  background: rgba(155, 28, 49, 0.06);
}

.badge {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 4px 8px;
  border-radius: 999px;
  background: #e7f4ee;
  color: var(--sage-dark);
  font-size: 0.78rem;
  font-weight: 800;
}

.badge.warning {
  background: rgba(166, 83, 25, 0.12);
  color: var(--warn);
}

.badge.error {
  background: rgba(155, 28, 49, 0.12);
  color: var(--danger);
}

.badge.muted {
  background: #edf2f1;
  color: var(--muted);
}

.action-select {
  width: 100%;
  min-width: 150px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #ffffff;
  color: var(--ink);
  font: inherit;
  font-weight: 700;
}

.action-select:disabled {
  color: var(--muted);
  background: #edf2f1;
}

.cell-muted {
  color: var(--muted);
}

.empty-state {
  padding: 34px;
  color: var(--muted);
  text-align: center;
}

.message-page {
  display: grid;
  min-height: 100vh;
  place-content: center;
  padding: 24px;
  text-align: center;
}

.message-page a {
  color: var(--sage);
  font-weight: 800;
}

@media (max-width: 820px) {
  .topbar,
  .section-heading,
  .sage-card,
  .hero-panel {
    grid-template-columns: 1fr;
  }

  .topbar,
  .section-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .upload-grid {
    grid-template-columns: 1fr;
  }

  .summary-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .filter-row {
    display: grid;
    grid-template-columns: 1fr;
  }

  .mapping-row {
    grid-template-columns: 1fr;
  }

  .status-stack {
    min-width: 0;
  }

  .file-card {
    grid-template-columns: 1fr;
  }

  .file-card label,
  .sage-actions .button-link,
  .sage-actions button,
  .button-row button {
    width: 100%;
  }
}
`;

const appJs = String.raw`
const uploadForm = document.querySelector("#uploadForm");
const summaryBody = document.querySelector("#summaryBody");
const summaryNotice = document.querySelector("#summaryNotice");
const classificationSummary = document.querySelector("#classificationSummary");
const resultsIntro = document.querySelector("#resultsIntro");
const reconciliationBody = document.querySelector("#reconciliationBody");
const reconciliationIntro = document.querySelector("#reconciliationIntro");
const clearButton = document.querySelector("#clearButton");
const checkButton = document.querySelector("#checkButton");
const reviewBody = document.querySelector("#reviewBody");
const reviewIntro = document.querySelector("#reviewIntro");
const reviewFilters = document.querySelector("#reviewFilters");
const reviewTotals = document.querySelector("#reviewTotals");
const exportReviewButton = document.querySelector("#exportReviewButton");
const saveBatchButton = document.querySelector("#saveBatchButton");
const reviewSaveNotice = document.querySelector("#reviewSaveNotice");
const sageStatusText = document.querySelector("#sageStatusText");
const sageConnectLink = document.querySelector("#sageConnectLink");
const sageDisconnectButton = document.querySelector("#sageDisconnectButton");
const refreshSageReferencesButton = document.querySelector("#refreshSageReferencesButton");
const mappingNotice = document.querySelector("#mappingNotice");
const taxMappingBody = document.querySelector("#taxMappingBody");
const ledgerMappingBody = document.querySelector("#ledgerMappingBody");
const customerMappingBody = document.querySelector("#customerMappingBody");

const maxFileSizeBytes = 20 * 1024 * 1024;
let reviewRows = [];
let activeReviewFilter = "all";
let latestOriginalFileNames = [];
let sageReferences = emptySageReferences();
const uploadSlots = [
  {
    id: "removalInvoices",
    label: "Removal invoices CSV",
    kind: "CSV",
    multiple: false,
    extensions: [".csv"],
    mimeTypes: ["text/csv", "application/vnd.ms-excel"],
  },
  {
    id: "removalDeposits",
    label: "Removal deposits CSV",
    kind: "CSV",
    multiple: false,
    extensions: [".csv"],
    mimeTypes: ["text/csv", "application/vnd.ms-excel"],
  },
  {
    id: "adHocInvoices",
    label: "Ad Hoc invoices CSV",
    kind: "CSV",
    multiple: false,
    extensions: [".csv"],
    mimeTypes: ["text/csv", "application/vnd.ms-excel"],
  },
  {
    id: "creditNotes",
    label: "Credit notes CSV",
    kind: "CSV",
    multiple: false,
    extensions: [".csv"],
    mimeTypes: ["text/csv", "application/vnd.ms-excel"],
  },
  {
    id: "monthlyReport",
    label: "Monthly invoice report PDF",
    kind: "PDF",
    multiple: false,
    extensions: [".pdf"],
    mimeTypes: ["application/pdf"],
  },
  {
    id: "invoicePdfs",
    label: "Individual invoice PDFs",
    kind: "PDF",
    multiple: true,
    extensions: [".pdf"],
    mimeTypes: ["application/pdf"],
  },
];

for (const slot of uploadSlots) {
  const input = document.querySelector("#" + slot.id);
  input.addEventListener("change", () => updateFieldMessage(slot));
}

loadSageStatus();
loadSageReferences();

reviewFilters.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-filter]") : null;
  if (!button) {
    return;
  }

  activeReviewFilter = button.dataset.filter;
  for (const filterButton of reviewFilters.querySelectorAll("[data-filter]")) {
    filterButton.classList.toggle("active", filterButton === button);
  }
  renderReviewTable();
});

reviewBody.addEventListener("change", (event) => {
  const select = event.target instanceof Element ? event.target.closest("[data-review-action]") : null;
  if (!select) {
    return;
  }

  const row = reviewRows.find((item) => item.review_id === select.dataset.reviewAction);
  if (!row) {
    return;
  }

  row.review_decision = select.value;
  renderReviewTotals();
  refreshSageReadiness();
});

exportReviewButton.addEventListener("click", () => {
  if (reviewRows.length === 0) {
    return;
  }

  downloadReviewCsv();
});

saveBatchButton.addEventListener("click", async () => {
  if (reviewRows.length === 0) {
    return;
  }

  saveBatchButton.disabled = true;
  saveBatchButton.textContent = "Saving...";

  try {
    const response = await fetch("/api/import-batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reporting_month: inferReportingMonth(reviewRows),
        original_file_names: latestOriginalFileNames,
        rows: reviewRows,
      }),
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      renderReviewSaveNotice("error", result.error || "The reviewed batch could not be saved.");
      return;
    }

    renderReviewSaveNotice("success", "Saved reviewed batch " + result.import_batch_id + " with " + result.invoice_count + " transaction" + plural(result.invoice_count) + ".");
  } catch (error) {
    renderReviewSaveNotice("error", "The reviewed batch could not be saved.");
    console.error(error);
  } finally {
    saveBatchButton.disabled = reviewRows.length === 0;
    saveBatchButton.textContent = "Save reviewed batch";
  }
});

sageDisconnectButton.addEventListener("click", async () => {
  sageDisconnectButton.disabled = true;
  sageStatusText.textContent = "Disconnecting Sage...";

  try {
    const response = await fetch("/api/sage/disconnect", { method: "POST" });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      sageStatusText.textContent = result.error || "Sage could not be disconnected.";
      return;
    }

    await loadSageStatus();
  } catch (error) {
    sageStatusText.textContent = "Sage could not be disconnected.";
    console.error(error);
  }
});

refreshSageReferencesButton.addEventListener("click", async () => {
  refreshSageReferencesButton.disabled = true;
  refreshSageReferencesButton.textContent = "Refreshing...";

  try {
    const response = await fetch("/api/sage/references/refresh", { method: "POST" });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      renderMappingNotice("error", result.error || "Sage references could not be refreshed.");
      return;
    }

    renderMappingNotice("success", "Refreshed " + result.tax_rates + " tax rate" + plural(result.tax_rates) + " and " + result.ledger_accounts + " ledger account" + plural(result.ledger_accounts) + ".");
    await loadSageReferences();
    await refreshSageReadiness();
  } catch (error) {
    renderMappingNotice("error", "Sage references could not be refreshed.");
    console.error(error);
  } finally {
    refreshSageReferencesButton.disabled = false;
    refreshSageReferencesButton.textContent = "Refresh Sage references";
  }
});

taxMappingBody.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-save-tax]") : null;
  if (!button) {
    return;
  }

  await saveReferenceMapping("tax_rate", button.dataset.saveTax || "", "", taxMappingBody);
});

ledgerMappingBody.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-save-ledger]") : null;
  if (!button) {
    return;
  }

  await saveReferenceMapping("ledger_account", button.dataset.saveLedger || "", button.dataset.context || "", ledgerMappingBody);
});

customerMappingBody.addEventListener("click", async (event) => {
  const searchButton = event.target instanceof Element ? event.target.closest("[data-search-contact]") : null;
  const saveButton = event.target instanceof Element ? event.target.closest("[data-save-contact]") : null;

  if (searchButton) {
    await searchContact(searchButton.dataset.searchContact || "");
  }

  if (saveButton) {
    await saveCustomerMapping(saveButton.dataset.saveContact || "");
  }
});

checkButton.addEventListener("click", async () => {
  checkButton.disabled = true;
  checkButton.textContent = "Checking...";

  const summaries = uploadSlots.flatMap(validateSlot);
  const selectedItems = summaries.filter((item) => !item.missing);
  const failedItems = selectedItems.filter((item) => !item.passed);

  clearButton.disabled = selectedItems.length === 0;

  try {
    if (selectedItems.length === 0) {
      renderNotice("error", "No files selected. Add any exports or PDFs you have, then check again.");
      renderEmpty("No files checked yet.");
      renderReconciliationEmpty("No reconciliation run yet.");
      resetReviewScreen();
      resultsIntro.textContent = "Nothing has been selected yet.";
      reconciliationIntro.textContent = "Upload CSV exports and the monthly invoice report PDF to compare invoice-level totals.";
      return;
    }

    if (failedItems.length > 0) {
      renderNotice("error", failedItems.length + " selected file" + plural(failedItems.length) + " need" + (failedItems.length === 1 ? "s" : "") + " attention before parsing.");
      renderFileSummary(summaries);
      renderReconciliationEmpty("Fix file warnings before reconciliation.");
      resetReviewScreen();
      resultsIntro.textContent = "Fix the file type or size warnings before parsing CSV rows.";
      reconciliationIntro.textContent = "Reconciliation will run after the selected files pass basic checks.";
      return;
    }

    const csvSummaries = summaries.filter((item) => item.kind === "CSV" && !item.missing);
    const pdfSummaries = summaries.filter((item) => item.kind === "PDF" && !item.missing);

    if (csvSummaries.length === 0) {
      renderNotice("success", pdfSummaries.length + " PDF file" + plural(pdfSummaries.length) + " passed the basic checks. Add a CSV export when you are ready to parse rows.");
      renderFileSummary(summaries);
      renderReconciliationEmpty("Add a CSV export before reconciliation.");
      resetReviewScreen();
      resultsIntro.textContent = "PDFs are not parsed in this step.";
      reconciliationIntro.textContent = "Reconciliation needs at least one CSV export and the monthly invoice report PDF.";
      return;
    }

    const result = await parseCsvFiles();
    renderParsedRows(result, pdfSummaries);
  } catch (error) {
    renderNotice("error", "The CSV files could not be parsed. Please try again or check the exports.");
    renderEmpty("Parsing failed.");
    resetReviewScreen();
    console.error(error);
  } finally {
    checkButton.disabled = false;
    checkButton.textContent = "Check files";
  }
});

clearButton.addEventListener("click", () => {
  uploadForm.reset();
  for (const slot of uploadSlots) {
    setFieldMessage(slot.id, slot.multiple ? "No files selected yet. This is optional." : "No file selected yet. This is optional.", "");
  }
  summaryNotice.className = "notice";
  summaryNotice.textContent = "";
  renderClassificationSummary();
  renderEmpty("No files checked yet.");
  renderReconciliationEmpty("No reconciliation run yet.");
  resetReviewScreen();
  resultsIntro.textContent = "Choose any files you have, then select Check files.";
  reconciliationIntro.textContent = "Upload CSV exports and the monthly invoice report PDF to compare invoice-level totals.";
  clearButton.disabled = true;
});

function updateFieldMessage(slot) {
  const files = getFiles(slot);
  if (files.length === 0) {
    setFieldMessage(slot.id, slot.multiple ? "No files selected yet. This is optional." : "No file selected yet. This is optional.", "");
    return;
  }

  const invalidCount = files.filter((file) => validateFile(file, slot).length > 0).length;
  if (invalidCount > 0) {
    setFieldMessage(slot.id, invalidCount + " selected file" + plural(invalidCount) + " need" + (invalidCount === 1 ? "s" : "") + " attention.", "error");
  } else {
    setFieldMessage(slot.id, files.length + " file" + plural(files.length) + " ready to check.", "success");
  }
}

function validateSlot(slot) {
  const files = getFiles(slot);
  if (files.length === 0) {
    return [{
      slot: slot.label,
      fileName: "Not added",
      type: slot.kind,
      kind: slot.kind,
      size: "-",
      passed: true,
      missing: true,
      status: "Optional",
      message: "No file selected. You can add this later if available.",
    }];
  }

  return files.map((file) => {
    const errors = validateFile(file, slot);
    return {
      slot: slot.label,
      fileName: file.name,
      type: slot.kind,
      kind: slot.kind,
      size: formatFileSize(file.size),
      passed: errors.length === 0,
      missing: false,
      status: errors.length === 0 ? "Passed" : "Needs attention",
      message: errors.join(" "),
    };
  });
}

function validateFile(file, slot) {
  const errors = [];
  const lowerName = file.name.toLowerCase();
  const hasAllowedExtension = slot.extensions.some((extension) => lowerName.endsWith(extension));
  const hasAllowedMime = file.type === "" || slot.mimeTypes.includes(file.type);

  if (!hasAllowedExtension || !hasAllowedMime) {
    errors.push(slot.label + " must be a " + slot.kind + " file.");
  }

  if (file.size === 0) {
    errors.push("The file is empty.");
  }

  if (file.size > maxFileSizeBytes) {
    errors.push("The file is too large. The limit is " + formatFileSize(maxFileSizeBytes) + " per file.");
  }

  return errors;
}

function renderFileSummary(items) {
  renderClassificationSummary();
  resetReviewScreen();
  latestOriginalFileNames = items.filter((item) => !item.missing).map((item) => item.fileName);
  summaryBody.innerHTML = items.map((item) => {
    const badgeClass = item.missing ? " muted" : item.passed ? "" : " error";
    const statusText = item.missing ? item.status : item.status + (item.message ? ": " + item.message : "");
    return "<tr>" +
      tableCell(item.fileName) +
      tableCell("-") +
      tableCell(item.type) +
      tableCell("-") +
      tableCell("-") +
      tableCell(item.slot) +
      tableCell("-") +
      tableCell("-") +
      tableCell(item.size) +
      tableCell("-") +
      tableCell("-") +
      tableCell("-") +
      '<td><span class="badge' + badgeClass + '">' + escapeHtml(statusText) + "</span></td>" +
      "</tr>";
  }).join("");
}

async function parseCsvFiles() {
  const formData = new FormData();
  for (const slot of uploadSlots.filter((item) => item.kind === "CSV")) {
    const files = getFiles(slot);
    if (files[0]) {
      formData.append(slot.id, files[0]);
    }
  }

  const monthlyReport = getFiles(uploadSlots.find((item) => item.id === "monthlyReport"))[0];
  if (monthlyReport) {
    formData.append("monthlyReportText", await extractPdfText(monthlyReport));
  }

  const response = await fetch("/api/parse-csv", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error("CSV parsing failed");
  }

  return response.json();
}

function renderParsedRows(result, pdfSummaries) {
  const rows = result.rows || [];
  const warningCount = rows.filter((row) => row.warnings.length > 0).length;
  const pdfText = pdfSummaries.length > 0 ? " " + pdfSummaries.length + " PDF file" + plural(pdfSummaries.length) + " passed metadata checks." : "";
  latestOriginalFileNames = [
    ...(result.files || []).map((file) => file.file_name).filter(Boolean),
    ...pdfSummaries.map((file) => file.fileName).filter(Boolean),
  ];
  renderClassificationSummary(result.classification_summary);
  renderReconciliation(result.reconciliation || []);
  initialiseReviewRows(rows);

  if (rows.length === 0) {
    renderNotice("error", "No CSV rows were found to parse." + pdfText);
    renderEmpty("No CSV rows found.");
    resetReviewScreen();
    resultsIntro.textContent = "Bad or empty CSV files are not discarded, but there were no rows to show.";
    return;
  }

  if (warningCount > 0) {
    renderNotice("error", rows.length + " CSV row" + plural(rows.length) + " parsed, with " + warningCount + " row" + plural(warningCount) + " needing review." + pdfText);
    resultsIntro.textContent = "Rows with warnings are kept in the preview so they can be fixed or investigated.";
  } else {
    renderNotice("success", rows.length + " CSV row" + plural(rows.length) + " parsed successfully." + pdfText);
    resultsIntro.textContent = "Amounts and VAT are normalised as numbers, and dates are normalised internally to ISO format.";
  }

  summaryBody.innerHTML = rows.slice(0, 100).map((row) => {
    const warnings = row.warnings.length > 0 ? row.warnings.join(" ") : "OK";
    const badgeClass = row.warnings.length > 0 ? " warning" : "";
    return "<tr>" +
      tableCell(row.source_file) +
      tableCell(row.row_number) +
      tableCell(formatTransactionType(row.transaction_type)) +
      tableCell(row.invoice_number || "-") +
      tableCell(row.date || "-") +
      tableCell(row.description || "-") +
      tableCell(row.customer_name || "-") +
      tableCell(row.service_type || "-") +
      tableCell(formatMoney(row.amount)) +
      tableCell(formatMoney(row.vat_amount)) +
      '<td><span class="badge ' + badgeClassForClassification(row.classification) + '">' + escapeHtml(formatStatus(row.classification || "needs_review")) + "</span></td>" +
      tableCell(row.export_allowed_by_default ? "Included" : "Not included") +
      '<td><span class="badge' + badgeClass + '">' + escapeHtml(warnings) + "</span></td>" +
      "</tr>";
  }).join("");

  if (rows.length > 100) {
    summaryBody.insertAdjacentHTML("beforeend", '<tr><td colspan="13" class="empty-state">Showing first 100 rows only.</td></tr>');
  }
}

function initialiseReviewRows(rows) {
  reviewRows = rows.map((row, index) => {
    const classification = row.classification || "needs_review";
    return {
      ...row,
      review_id: [
        row.source_file || "file",
        row.row_number || index + 1,
        row.invoice_number || "no-invoice",
        index,
      ].join("::"),
      review_decision: defaultReviewDecision(classification),
    };
  });

  activeReviewFilter = "all";
  for (const filterButton of reviewFilters.querySelectorAll("[data-filter]")) {
    filterButton.classList.toggle("active", filterButton.dataset.filter === "all");
  }

  exportReviewButton.disabled = reviewRows.length === 0;
  saveBatchButton.disabled = reviewRows.length === 0;
  reviewSaveNotice.className = "notice";
  reviewSaveNotice.textContent = "";
  reviewIntro.textContent = reviewRows.length === 0
    ? "This is a checking stage only. Nothing here is sent to Sage, and the report is for review before any future export."
    : reviewRows.length + " transaction" + plural(reviewRows.length) + " ready for review. Import candidates are included by default; storage and review rows are not.";
  renderReviewTable();
  renderMappingScreens();
  refreshSageReadiness();
}

function resetReviewScreen() {
  reviewRows = [];
  activeReviewFilter = "all";
  for (const filterButton of reviewFilters.querySelectorAll("[data-filter]")) {
    filterButton.classList.toggle("active", filterButton.dataset.filter === "all");
  }
  exportReviewButton.disabled = true;
  saveBatchButton.disabled = true;
  latestOriginalFileNames = [];
  reviewSaveNotice.className = "notice";
  reviewSaveNotice.textContent = "";
  reviewIntro.textContent = "This is a checking stage only. Nothing here is sent to Sage, and the report is for review before any future export.";
  renderReviewTotals();
  renderMappingScreens();
  reviewBody.innerHTML = '<tr><td colspan="13" class="empty-state">No transactions ready for review yet.</td></tr>';
}

function renderReviewTable() {
  renderReviewTotals();

  if (reviewRows.length === 0) {
    reviewBody.innerHTML = '<tr><td colspan="13" class="empty-state">No transactions ready for review yet.</td></tr>';
    return;
  }

  const rows = reviewRows.filter(matchesActiveReviewFilter);
  if (rows.length === 0) {
    reviewBody.innerHTML = '<tr><td colspan="13" class="empty-state">No transactions match this filter.</td></tr>';
    return;
  }

  reviewBody.innerHTML = rows.map((row) => {
    const warnings = row.warnings.length > 0 ? row.warnings.join(" ") : "OK";
    const riskClass = reviewRiskClass(row);
    return '<tr class="' + riskClass + '">' +
      tableCell(row.invoice_number || "-") +
      tableCell(row.date || "-") +
      tableCell(row.customer_name || "-") +
      tableCell(formatTransactionType(row.transaction_type)) +
      tableCell(row.service_type || "-") +
      tableCell(row.description || "-") +
      tableCell(formatMoney(row.amount)) +
      tableCell(formatMoney(row.vat_amount)) +
      tableCell(formatMoney(grossAmount(row))) +
      '<td><span class="badge ' + badgeClassForClassification(row.classification) + '">' + escapeHtml(formatStatus(row.classification || "needs_review")) + "</span></td>" +
      '<td><span class="badge' + (row.warnings.length > 0 ? " warning" : "") + '">' + escapeHtml(warnings) + "</span></td>" +
      '<td><span class="badge ' + badgeClassForReadiness(row.sage_readiness) + '">' + escapeHtml(formatStatus(row.sage_readiness || "not_checked")) + "</span></td>" +
      '<td>' + reviewActionSelect(row) + '</td>' +
      "</tr>";
  }).join("");
}

function renderReviewTotals() {
  const included = reviewRows.filter((row) => row.review_decision === "include");
  const includedNet = included.reduce((sum, row) => sum + numericAmount(row.amount), 0);
  const includedVat = included.reduce((sum, row) => sum + numericAmount(row.vat_amount), 0);
  const reviewNeeded = reviewRows.filter((row) => row.review_decision === "review").length;
  const excluded = reviewRows.filter((row) => row.review_decision === "exclude").length;

  reviewTotals.innerHTML = [
    ["Included rows", included.length],
    ["Included net", formatMoney(includedNet)],
    ["Included VAT", formatMoney(includedVat)],
    ["Included gross", formatMoney(includedNet + includedVat)],
    ["Review needed", reviewNeeded],
    ["Excluded rows", excluded],
  ].map(([label, value]) => "<article><strong>" + escapeHtml(String(value)) + "</strong><span>" + escapeHtml(label) + "</span></article>").join("");
}

function renderMappingScreens() {
  renderTaxMappings();
  renderLedgerMappings();
  renderCustomerMappings();
}

function renderTaxMappings() {
  const codes = distinctBy(reviewRows.map((row) => row.tax_code).filter(Boolean));
  const options = sageReferences.active_tax_rates || [];

  if (codes.length === 0) {
    taxMappingBody.innerHTML = '<p class="empty-state">No uploaded tax codes yet.</p>';
    return;
  }

  taxMappingBody.innerHTML = codes.map((code) => {
    const saved = sageReferences.tax_mappings.find((mapping) => mapping.source_code === code);
    return '<div class="mapping-row">' +
      '<div><strong>' + escapeHtml(code) + '</strong><small>Removals Manager tax code</small>' + savedBadge(saved) + '</div>' +
      sageReferenceSelect("tax-" + slug(code), options, saved?.sage_entity_id) +
      '<button type="button" data-save-tax="' + escapeHtml(code) + '">Save mapping</button>' +
      '</div>';
  }).join("");
}

function renderLedgerMappings() {
  const entries = distinctLedgerEntries();
  const options = sageReferences.active_ledger_accounts || [];

  if (entries.length === 0) {
    ledgerMappingBody.innerHTML = '<p class="empty-state">No uploaded nominal codes yet.</p>';
    return;
  }

  ledgerMappingBody.innerHTML = entries.map((entry) => {
    const saved = sageReferences.ledger_mappings.find((mapping) => mapping.source_code === entry.source_code && mapping.source_context === entry.source_context);
    return '<div class="mapping-row">' +
      '<div><strong>' + escapeHtml(entry.source_code) + '</strong><small>' + escapeHtml(formatTransactionType(entry.source_context)) + '</small>' + savedBadge(saved) + '</div>' +
      sageReferenceSelect("ledger-" + slug(entry.source_context + "-" + entry.source_code), options, saved?.sage_entity_id) +
      '<button type="button" data-save-ledger="' + escapeHtml(entry.source_code) + '" data-context="' + escapeHtml(entry.source_context) + '">Save mapping</button>' +
      '</div>';
  }).join("");
}

function renderCustomerMappings() {
  const customers = uniqueCustomers();

  if (customers.length === 0) {
    customerMappingBody.innerHTML = '<p class="empty-state">No customers found in the reviewed rows yet.</p>';
    return;
  }

  customerMappingBody.innerHTML = customers.map((customer) => {
    const saved = sageReferences.customer_mappings.find((mapping) => mapping.normalized_customer_name === customer.normalized);
    const contactOptions = (customer.matches || []).map((match) =>
      '<option value="' + escapeHtml(match.sage_contact_id) + '">' + escapeHtml(match.sage_contact_display_name) + (match.email ? " - " + escapeHtml(match.email) : "") + '</option>'
    ).join("");
    const select = customer.matches
      ? '<select id="contact-' + slug(customer.normalized) + '">' + contactOptions + '</select>'
      : '<select id="contact-' + slug(customer.normalized) + '" disabled><option>Search Sage first</option></select>';
    const matchText = customer.match_status === "ambiguous"
      ? '<small>Multiple possible matches. Please choose manually.</small>'
      : customer.missing_contact_message
        ? '<small>' + escapeHtml(customer.missing_contact_message) + '</small>'
        : "";

    return '<div class="mapping-row">' +
      '<div><strong>' + escapeHtml(customer.name) + '</strong><small>' + escapeHtml(customer.normalized) + '</small>' + savedBadge(saved) + matchText + '</div>' +
      select +
      '<div class="contact-actions">' +
        '<button class="secondary-button" type="button" data-search-contact="' + escapeHtml(customer.normalized) + '">Refresh and search</button>' +
        '<button type="button" data-save-contact="' + escapeHtml(customer.normalized) + '"' + (customer.matches ? "" : " disabled") + '>Save contact</button>' +
      '</div>' +
      '</div>';
  }).join("");
}

async function loadSageReferences() {
  try {
    const response = await fetch("/api/sage/references");
    const data = await response.json();
    if (!response.ok) {
      sageReferences = emptySageReferences();
      renderMappingNotice("error", data.error || "Sage mapping data could not be loaded.");
      renderMappingScreens();
      return;
    }

    sageReferences = {
      tax_rates: data.tax_rates || [],
      ledger_accounts: data.ledger_accounts || [],
      active_tax_rates: data.active_tax_rates || [],
      active_ledger_accounts: data.active_ledger_accounts || [],
      tax_mappings: data.tax_mappings || [],
      ledger_mappings: data.ledger_mappings || [],
      customer_mappings: data.customer_mappings || [],
    };
    renderMappingScreens();
    await refreshSageReadiness();
  } catch (error) {
    sageReferences = emptySageReferences();
    renderMappingScreens();
    console.error(error);
  }
}

async function saveReferenceMapping(mappingType, sourceCode, sourceContext, container) {
  const selectId = mappingType === "tax_rate"
    ? "tax-" + slug(sourceCode)
    : "ledger-" + slug(sourceContext + "-" + sourceCode);
  const select = container.querySelector("#" + cssEscape(selectId));
  const option = select?.selectedOptions?.[0];
  if (!select?.value || !option) {
    renderMappingNotice("error", "Choose a Sage reference before saving the mapping.");
    return;
  }

  const response = await fetch("/api/sage/reference-mappings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mapping_type: mappingType,
      source_code: sourceCode,
      source_context: sourceContext,
      sage_entity_id: select.value,
      sage_display_name: option.textContent,
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    renderMappingNotice("error", result.error || "Mapping could not be saved.");
    return;
  }

  renderMappingNotice("success", "Mapping saved.");
  await loadSageReferences();
}

async function searchContact(normalizedCustomerName) {
  const customer = uniqueCustomers().find((item) => item.normalized === normalizedCustomerName);
  if (!customer) {
    return;
  }

  const response = await fetch("/api/sage/contacts/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer_name: customer.name,
      normalized_customer_name: customer.normalized,
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    renderMappingNotice("error", result.error || "Sage contacts could not be searched.");
    return;
  }

  customer.contact_search = result;
  for (const row of reviewRows) {
    if (normalizeCustomerNameClient(row.customer_name || "") === normalizedCustomerName) {
      row.contact_search = result;
    }
  }
  renderMappingNotice(result.match_status === "none" ? "error" : "success", result.missing_contact_message || "Contact search complete. Confirm the correct match manually.");
  renderCustomerMappings();
}

async function saveCustomerMapping(normalizedCustomerName) {
  const select = customerMappingBody.querySelector("#contact-" + cssEscape(slug(normalizedCustomerName)));
  const option = select?.selectedOptions?.[0];
  if (!select?.value || !option) {
    renderMappingNotice("error", "Choose a Sage contact before saving the customer mapping.");
    return;
  }

  const response = await fetch("/api/sage/customer-mappings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      normalized_customer_name: normalizedCustomerName,
      sage_contact_id: select.value,
      sage_contact_display_name: option.textContent,
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    renderMappingNotice("error", result.error || "Customer mapping could not be saved.");
    return;
  }

  renderMappingNotice("success", "Customer mapping saved.");
  await loadSageReferences();
}

async function refreshSageReadiness() {
  if (reviewRows.length === 0) {
    return;
  }

  try {
    const response = await fetch("/api/sage/readiness", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: reviewRows }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      return;
    }

    const readinessById = new Map(result.readiness.map((item) => [item.review_id, item.status]));
    for (const row of reviewRows) {
      row.sage_readiness = readinessById.get(row.review_id) || "blocked_by_warning";
    }
    renderReviewTable();
  } catch (error) {
    console.error(error);
  }
}

function matchesActiveReviewFilter(row) {
  if (activeReviewFilter === "import_candidates") {
    return row.classification === "import_candidate";
  }

  if (activeReviewFilter === "excluded_storage") {
    return row.classification === "exclude_storage";
  }

  if (activeReviewFilter === "needs_review") {
    return row.review_decision === "review" || isReviewClassification(row.classification);
  }

  if (activeReviewFilter === "mismatches") {
    return row.classification === "amount_mismatch" || row.classification === "vat_mismatch" || row.pdf_match_status === "amount_mismatch" || row.pdf_match_status === "vat_mismatch";
  }

  if (activeReviewFilter === "missing_customer") {
    return row.classification === "missing_customer" || !row.customer_name;
  }

  return true;
}

function uniqueCustomers() {
  const map = new Map();
  for (const row of reviewRows) {
    if (!row.customer_name) {
      continue;
    }
    const normalized = normalizeCustomerNameClient(row.customer_name);
    if (!map.has(normalized)) {
      const search = row.contact_search;
      map.set(normalized, {
        name: row.customer_name,
        normalized,
        matches: search?.matches,
        match_status: search?.match_status,
        missing_contact_message: search?.missing_contact_message,
      });
    }
  }
  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function distinctLedgerEntries() {
  const map = new Map();
  for (const row of reviewRows) {
    if (!row.nominal_code) {
      continue;
    }
    map.set(row.nominal_code + "|" + row.transaction_type, {
      source_code: row.nominal_code,
      source_context: row.transaction_type,
    });
  }
  return [...map.values()].sort((left, right) => (left.source_context + left.source_code).localeCompare(right.source_context + right.source_code));
}

function distinctBy(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort();
}

function sageReferenceSelect(id, entries, selectedId) {
  const options = ['<option value="">Choose Sage record</option>'].concat(entries.map((entry) => {
    const selected = entry.sage_entity_id === selectedId ? " selected" : "";
    const code = entry.source_code ? entry.source_code + " - " : "";
    return '<option value="' + escapeHtml(entry.sage_entity_id) + '"' + selected + '>' + escapeHtml(code + entry.sage_display_name) + '</option>';
  }));
  return '<select id="' + escapeHtml(id) + '">' + options.join("") + '</select>';
}

function savedBadge(saved) {
  return saved ? '<small>Saved: ' + escapeHtml(saved.sage_display_name) + '</small>' : '<small>Not mapped yet</small>';
}

function reviewActionSelect(row) {
  const storageLocked = row.classification === "exclude_storage";
  const options = [
    { value: "include", label: "Include", disabled: storageLocked },
    { value: "exclude", label: "Exclude", disabled: false },
    { value: "review", label: "Review needed", disabled: false },
  ];

  const optionHtml = options.map((option) => {
    const selected = row.review_decision === option.value ? " selected" : "";
    const disabled = option.disabled ? " disabled" : "";
    return '<option value="' + option.value + '"' + selected + disabled + ">" + option.label + "</option>";
  }).join("");

  return '<select class="action-select" data-review-action="' + escapeHtml(row.review_id) + '"' + (storageLocked ? ' title="Storage rows are excluded by default."' : "") + ">" + optionHtml + "</select>";
}

function defaultReviewDecision(classification) {
  if (classification === "import_candidate") {
    return "include";
  }

  if (classification === "exclude_storage") {
    return "exclude";
  }

  return "review";
}

function isReviewClassification(classification) {
  return classification !== "import_candidate" && classification !== "exclude_storage";
}

function reviewRiskClass(row) {
  const highRisk = row.classification === "amount_mismatch" || row.classification === "vat_mismatch" || row.classification === "exclude_storage";
  const risky = highRisk ||
    row.classification === "missing_customer" ||
    row.classification === "possible_duplicate" ||
    row.transaction_type === "deposit" ||
    row.warnings.some((warning) => warning.toLowerCase().includes("overlap") || warning.toLowerCase().includes("duplicate"));

  if (highRisk) {
    return "risky-row high-risk";
  }

  return risky ? "risky-row" : "";
}

function badgeClassForReadiness(value) {
  if (value === "ready_for_sage") {
    return "";
  }

  if (value === "blocked_by_warning" || value === "already_imported") {
    return "error";
  }

  return "warning";
}

function downloadReviewCsv() {
  const headers = [
    "invoice_number",
    "date",
    "customer_name",
    "source_file_type",
    "source_file",
    "service_type",
    "description",
    "net_amount",
    "vat_amount",
    "gross_amount",
    "classification",
    "manual_decision",
    "included_in_report_totals",
    "warnings",
  ];
  const csvRows = [headers, ...reviewRows.map((row) => [
    row.invoice_number || "",
    row.date || "",
    row.customer_name || "",
    formatTransactionType(row.transaction_type),
    row.source_file || "",
    row.service_type || "",
    row.description || "",
    moneyForCsv(row.amount),
    moneyForCsv(row.vat_amount),
    moneyForCsv(grossAmount(row)),
    row.classification || "needs_review",
    row.review_decision,
    row.review_decision === "include" ? "yes" : "no",
    row.warnings.join(" | "),
  ])];
  const csv = csvRows.map((row) => row.map(csvCell).join(",")).join("\\r\\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "sage-import-reconciliation-report.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderReviewSaveNotice(state, message) {
  reviewSaveNotice.className = "notice show " + state;
  reviewSaveNotice.textContent = message;
}

async function loadSageStatus() {
  try {
    const response = await fetch("/api/sage/status");
    const status = await response.json();

    if (!response.ok) {
      sageStatusText.textContent = status.error || "Sage status could not be loaded.";
      sageConnectLink.textContent = "Connect Sage";
      sageDisconnectButton.disabled = true;
      return;
    }

    if (!status.storage_configured) {
      sageStatusText.textContent = "D1 is not configured yet, so Sage cannot be connected.";
      sageConnectLink.textContent = "Connect Sage";
      sageDisconnectButton.disabled = true;
      return;
    }

    if (status.connected) {
      const suffix = status.reauthorization_required ? " Reconnection is required." : "";
      sageStatusText.textContent = "Connected to " + status.business_display_name + "." + suffix;
      sageConnectLink.textContent = status.reauthorization_required ? "Reconnect Sage" : "Reconnect Sage";
      sageDisconnectButton.disabled = false;
      return;
    }

    sageStatusText.textContent = "Sage is not connected.";
    sageConnectLink.textContent = "Connect Sage";
    sageDisconnectButton.disabled = true;
  } catch (error) {
    sageStatusText.textContent = "Sage status could not be loaded.";
    sageDisconnectButton.disabled = true;
    console.error(error);
  }
}

function inferReportingMonth(rows) {
  const firstDate = rows.map((row) => row.date).find(Boolean);
  return firstDate ? String(firstDate).slice(0, 7) : null;
}

function emptySageReferences() {
  return {
    tax_rates: [],
    ledger_accounts: [],
    active_tax_rates: [],
    active_ledger_accounts: [],
    tax_mappings: [],
    ledger_mappings: [],
    customer_mappings: [],
  };
}

function renderClassificationSummary(summary) {
  const values = summary || {
    total_rows_uploaded: 0,
    import_candidates: 0,
    excluded_storage_rows: 0,
    needs_review_rows: 0,
    duplicate_warnings: 0,
    total_import_candidate_value: 0,
    total_excluded_value: 0,
  };

  classificationSummary.innerHTML = [
    ["Total rows", values.total_rows_uploaded],
    ["Import candidates", values.import_candidates],
    ["Excluded storage", values.excluded_storage_rows],
    ["Needs review", values.needs_review_rows],
    ["Duplicate warnings", values.duplicate_warnings],
    ["Candidate value", formatMoney(values.total_import_candidate_value)],
    ["Excluded value", formatMoney(values.total_excluded_value)],
  ].map(([label, value]) => "<article><strong>" + escapeHtml(String(value)) + "</strong><span>" + escapeHtml(label) + "</span></article>").join("");
}

function renderReconciliation(rows) {
  if (rows.length === 0) {
    renderReconciliationEmpty("No monthly PDF reconciliation available.");
    reconciliationIntro.textContent = "Add the monthly invoice report PDF to compare against CSV rows.";
    return;
  }

  const issueCount = rows.filter((row) => row.status !== "matched").length;
  reconciliationIntro.textContent = issueCount === 0
    ? rows.length + " invoice" + plural(rows.length) + " matched the monthly PDF report. Matching is a check only, not an approval."
    : issueCount + " invoice" + plural(issueCount) + " need" + (issueCount === 1 ? "s" : "") + " review after comparing CSV and PDF data.";

  reconciliationBody.innerHTML = rows.map((row) => {
    const badgeClass = row.status === "matched" ? "" : row.status.includes("mismatch") || row.status.includes("missing") ? " error" : " warning";
    return "<tr>" +
      tableCell(row.invoice_number) +
      '<td><span class="badge' + badgeClass + '">' + escapeHtml(formatStatus(row.status)) + "</span></td>" +
      tableCell(row.customer_name || "-") +
      tableCell(row.service_type || "-") +
      tableCell(formatMoney(row.csv_amount)) +
      tableCell(formatMoney(row.pdf_amount)) +
      tableCell(formatMoney(row.csv_vat)) +
      tableCell(formatMoney(row.pdf_vat)) +
      tableCell(row.warnings.length > 0 ? row.warnings.join(" ") : "OK") +
      "</tr>";
  }).join("");
}

function renderReconciliationEmpty(message) {
  reconciliationBody.innerHTML = '<tr><td colspan="9" class="empty-state">' + escapeHtml(message) + "</td></tr>";
}

async function extractPdfText(file) {
  const pdfjs = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

  const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(" "));
  }

  return pages.join("\\n");
}

function renderNotice(state, message) {
  summaryNotice.className = "notice show " + state;
  summaryNotice.textContent = message;
}

function renderEmpty(message) {
  summaryBody.innerHTML = '<tr><td colspan="13" class="empty-state">' + escapeHtml(message) + "</td></tr>";
}

function formatTransactionType(value) {
  return String(value).replaceAll("_", " ");
}

function formatStatus(value) {
  return String(value).replaceAll("_", " ");
}

function normalizeCustomerNameClient(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,'"]/g, "");
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
}

function badgeClassForClassification(value) {
  if (value === "import_candidate") {
    return "";
  }

  if (value === "exclude_storage" || value === "amount_mismatch" || value === "vat_mismatch") {
    return "error";
  }

  return "warning";
}

function formatMoney(value) {
  return typeof value === "number" ? value.toFixed(2) : "-";
}

function numericAmount(value) {
  return typeof value === "number" ? value : 0;
}

function grossAmount(row) {
  return numericAmount(row.amount) + numericAmount(row.vat_amount);
}

function moneyForCsv(value) {
  return typeof value === "number" ? value.toFixed(2) : "";
}

function csvCell(value) {
  const text = String(value ?? "");
  return '"' + text.replaceAll('"', '""') + '"';
}

function getFiles(slot) {
  const input = document.querySelector("#" + slot.id);
  return Array.from(input.files || []);
}

function setFieldMessage(id, message, state) {
  const element = document.querySelector("#" + id + "Message");
  element.textContent = message;
  element.className = "field-message" + (state ? " " + state : "");
}

function formatFileSize(bytes) {
  if (bytes < 1024) {
    return bytes + " B";
  }

  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + " KB";
  }

  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function tableCell(value) {
  return "<td>" + escapeHtml(String(value ?? "")) + "</td>";
}

function plural(count) {
  return count === 1 ? "" : "s";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
`;
