import { classifyTransactions } from "../src/classification";
import { DuplicateSourceInvoiceError, createImportDatabase, normalizeCustomerName, type SourceInvoiceRecord } from "../src/db";
import { parseMonthlyInvoiceReportText } from "../src/monthlyReportParser";
import { reconcileTransactionsWithPdf } from "../src/reconciliation";
import { parseRemovalsCsv, type TransactionType } from "../src/removalsParser";
import {
  D1SageConnectionStore,
  SageApiClient,
  SageAuthorizationError,
  SageBusinessLookupError,
  SageReferenceFetchError,
  SageResponseShapeError,
  SageTokenExchangeError,
  createSageAuthorizationUrl,
  encryptTokenPair,
  exchangeAuthorizationCode,
  expiryFromNow,
  fetchConnectedBusiness,
  fetchSageLedgerAccounts,
  fetchSageTaxRates,
  normalizeSageLedgerAccount,
  normalizeSageTaxRate,
  createSageDraftInvoice,
  searchSageSalesInvoices,
  SageDraftInvoiceRequestError,
  SageUncertainResultError,
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
  type ReadinessInput,
} from "../src/sageMappings";
import { assertDraftCreationSafety, buildSageDraftInvoice, DraftInvoiceValidationError, type DraftInvoicePreview } from "../src/sageDraftInvoice";

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
const APP_ASSET_VERSION = "20260726-9";
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

      // Sage returns here from a third-party domain. The short-lived OAuth state
      // cookie validates that return, so this must not depend on the app session.
      if (url.pathname === "/api/sage/callback" && request.method === "GET") {
        return handleSageCallback(request, env);
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

      if (url.pathname === "/api/sage/drafts/dry-run" && request.method === "POST") {
        return handleSageDraftDryRun(request, env);
      }

      if (url.pathname === "/api/sage/drafts/create" && request.method === "POST") {
        return handleSageDraftCreate(request, env);
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
      source_invoice_ids: result.invoices.map((invoice) => invoice.id),
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
    return sageCallbackRedirect("configuration_failed", {
      "Set-Cookie": clearCookie(SAGE_OAUTH_STATE_COOKIE, secure),
    });
  }

  if (!env.DB) {
    return sageCallbackRedirect("storage_failed", {
      "Set-Cookie": clearCookie(SAGE_OAUTH_STATE_COOKIE, secure),
    });
  }

  const expectedState = getCookie(request.headers.get("Cookie") ?? "", SAGE_OAUTH_STATE_COOKIE);
  const returnedState = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const validation = validateOAuthCallbackInput(expectedState, returnedState, code, constantTimeEqual);
  if (!validation.ok) {
    return sageCallbackRedirect("authorization_failed", {
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
      return sageCallbackRedirect("token_exchange_failed", {
        "Set-Cookie": clearCookie(SAGE_OAUTH_STATE_COOKIE, secure),
      });
    }

    if (error instanceof SageBusinessLookupError) {
      return sageCallbackRedirect("business_lookup_failed", {
        "Set-Cookie": clearCookie(SAGE_OAUTH_STATE_COOKIE, secure),
      });
    }

    console.error("Sage OAuth callback failed", safeError(error));
    return sageCallbackRedirect("connection_failed", {
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

async function activeSageBusinessId(env: Env): Promise<string | null> {
  if (!env.DB) {
    return null;
  }
  const connection = await new D1SageConnectionStore(env.DB).getActiveConnection();
  return connection?.sage_business_id ?? null;
}

function availableMappings<T extends { sage_entity_id: string }>(mappings: T[], entries: Array<{ sage_entity_id: string }>): T[] {
  const availableIds = new Set(entries.map((entry) => entry.sage_entity_id));
  return mappings.filter((mapping) => availableIds.has(mapping.sage_entity_id));
}

async function handleSageReferences(env: Env): Promise<Response> {
  const database = databaseFromEnv(env);
  if (!database.ok) {
    return jsonResponse(database.body, database.status);
  }

  const businessId = await activeSageBusinessId(env);
  if (!businessId) {
    return jsonResponse({ ok: false, error: "Connect Sage before setting up conversions." }, 401);
  }

  const [taxRates, ledgerAccounts, taxMappings, ledgerMappings, customerMappings] = await Promise.all([
    database.value.listSageReferenceCache(businessId, "tax_rate"),
    database.value.listSageReferenceCache(businessId, "ledger_account"),
    database.value.listReferenceMappings(businessId, "tax_rate"),
    database.value.listReferenceMappings(businessId, "ledger_account"),
    database.value.listCustomerMappings(businessId),
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

  const connection = await new D1SageConnectionStore(env.DB!).getActiveConnection();
  if (!connection) {
    return jsonResponse({ ok: false, error: "Reconnect Sage before refreshing reference data." }, 401);
  }

  try {
    const [ledgerData, taxData] = await Promise.all([
      fetchSageLedgerAccounts(client.value),
      fetchSageTaxRates(client.value),
    ]);
    const ledgerAccounts = parseSageReferenceItems(ledgerData.items.map((item) => ({ ...item, ...normalizeSageLedgerAccount(item) })), "ledger_account");
    const taxRates = parseSageReferenceItems(taxData.items.map((item) => ({ ...item, ...normalizeSageTaxRate(item) })), "tax_rate");
    const now = new Date().toISOString();

    // A successful but empty collection must not erase a previously usable cache.
    const cacheWrites: Promise<void>[] = [];
    if (ledgerAccounts.length > 0) {
      cacheWrites.push(database.value.replaceSageReferenceCache(connection.sage_business_id, "ledger_account", ledgerAccounts, now));
    }
    if (taxRates.length > 0) {
      cacheWrites.push(database.value.replaceSageReferenceCache(connection.sage_business_id, "tax_rate", taxRates, now));
    }
    await Promise.all(cacheWrites);

    const warnings: string[] = [];
    if (ledgerAccounts.length === 0) warnings.push("Connected to Sage, but no ledger accounts were returned. Check the refresh details or reconnect Sage.");
    if (taxRates.length === 0) warnings.push("Connected to Sage, but no VAT rates were returned. Check the refresh details or reconnect Sage.");

    return jsonResponse({
      ok: true,
      businessId: connection.sage_business_id,
      businessName: connection.sage_business_name,
      counts: { ledgerAccounts: ledgerAccounts.length, taxRates: taxRates.length },
      ledgerAccounts,
      taxRates,
      diagnostics: [...ledgerData.diagnostics, ...taxData.diagnostics],
      warnings,
      refreshed_at: now,
    });
  } catch (error) {
    if (error instanceof SageAuthorizationError) {
      return jsonResponse({ ok: false, error: "Reconnect Sage before refreshing reference data." }, 401);
    }
    if (error instanceof SageReferenceFetchError) {
      return jsonResponse({ ok: false, error: error.message, status: error.status, endpoint: error.endpoint }, error.status === 403 || error.status === 429 ? error.status : 502);
    }
    if (error instanceof SageResponseShapeError) {
      return jsonResponse({ ok: false, error: error.message }, 502);
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

  const businessId = await activeSageBusinessId(env);
  if (!businessId) {
    return jsonResponse({ ok: false, error: "Connect Sage before saving conversion choices." }, 401);
  }

  await database.value.saveReferenceMapping({
    sage_business_id: businessId,
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
      database.value.listCustomerMappings((await activeSageBusinessId(env)) ?? ""),
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

  const businessId = await activeSageBusinessId(env);
  if (!businessId) {
    return jsonResponse({ ok: false, error: "Connect Sage before saving customer matches." }, 401);
  }

  await database.value.saveCustomerMapping({
    sage_business_id: businessId,
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
  const businessId = await activeSageBusinessId(env);
  if (!businessId) {
    return jsonResponse({ ok: false, error: "Connect Sage before checking conversion readiness." }, 401);
  }
  const [customerMappings, taxMappings, ledgerMappings, taxRates, ledgerAccounts, importedIds] = await Promise.all([
    database.value.listCustomerMappings(businessId),
    database.value.listReferenceMappings(businessId, "tax_rate"),
    database.value.listReferenceMappings(businessId, "ledger_account"),
    database.value.listSageReferenceCache(businessId, "tax_rate"),
    database.value.listSageReferenceCache(businessId, "ledger_account"),
    database.value.importedSourceInvoiceIds(rows.map((row) => String(row.source_invoice_id ?? "")).filter(Boolean)),
  ]);

  const context = {
    customerMappings,
    taxMappings: availableMappings(taxMappings, activeReferenceEntries(taxRates)),
    ledgerMappings: availableMappings(ledgerMappings, activeReferenceEntries(ledgerAccounts)),
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

async function handleSageDraftDryRun(request: Request, env: Env): Promise<Response> {
  const database = databaseFromEnv(env);
  if (!database.ok) {
    return jsonResponse(database.body, database.status);
  }

  const body = await request.json() as { source_invoice_id?: string; due_date?: string };
  const prepared = await prepareSageDraftInvoice(database.value, await activeSageBusinessId(env), body.source_invoice_id ?? "", body.due_date ?? "");
  if (!prepared.ok) {
    return jsonResponse({ ok: false, error: prepared.error }, prepared.status);
  }

  return jsonResponse({
    ok: true,
    mode: "dry_run",
    ready: true,
    source_invoice_id: prepared.sourceInvoiceId,
    preview: prepared.preview,
  });
}

async function handleSageDraftCreate(request: Request, env: Env): Promise<Response> {
  const database = databaseFromEnv(env);
  if (!database.ok) {
    return jsonResponse(database.body, database.status);
  }

  const body = await request.json() as { source_invoice_id?: string; due_date?: string; confirmed?: boolean };
  if (body.confirmed !== true) {
    return jsonResponse({ ok: false, error: "Confirm this one draft invoice before creating it in Sage." }, 400);
  }

  const prepared = await prepareSageDraftInvoice(database.value, await activeSageBusinessId(env), body.source_invoice_id ?? "", body.due_date ?? "");
  if (!prepared.ok) {
    return jsonResponse({ ok: false, error: prepared.error }, prepared.status);
  }

  const client = sageClientFromEnv(env);
  if (!client.ok) {
    return jsonResponse(client.body, client.status);
  }

  let reservedForCreate = false;
  try {
    const existingInSage = await searchSageSalesInvoices(client.value, prepared.preview.invoice_reference);
    const existingId = sageInvoiceIdForReference(existingInSage, prepared.preview.invoice_reference);
    if (existingId) {
      const reservation = await database.value.reserveSageImport(prepared.sourceInvoiceId, prepared.contactId);
      if (!reservation.reserved) {
        return sageImportAlreadyReserved(reservation.record.import_status, reservation.record.sage_invoice_id);
      }
      await database.value.markSageImportCreated(prepared.sourceInvoiceId, existingId);
      return jsonResponse({
        ok: true,
        created: false,
        found_existing: true,
        sage_invoice_id: existingId,
        message: "An existing Sage invoice with this Removals Manager reference was found. No new draft was created.",
      });
    }

    const reservation = await database.value.reserveSageImport(prepared.sourceInvoiceId, prepared.contactId);
    if (!reservation.reserved) {
      return sageImportAlreadyReserved(reservation.record.import_status, reservation.record.sage_invoice_id);
    }
    reservedForCreate = true;

    const sageResult = await createSageDraftInvoice(client.value, prepared.preview.payload);
    const sageInvoiceId = sageInvoiceIdFromResult(sageResult);
    if (!sageInvoiceId) {
      await database.value.markSageImportUncertain(prepared.sourceInvoiceId, "Sage accepted the request but did not return a draft invoice ID. Check Sage before trying again.");
      return jsonResponse({ ok: false, uncertain: true, error: "Sage did not return a draft ID. Check Sage before trying again." }, 502);
    }

    await database.value.markSageImportCreated(prepared.sourceInvoiceId, sageInvoiceId);
    return jsonResponse({
      ok: true,
      created: true,
      sage_invoice_id: sageInvoiceId,
      message: "One Sage draft invoice was created. It has not been sent, released or published.",
    });
  } catch (error) {
    if (error instanceof SageDraftInvoiceRequestError) {
      await database.value.markSageImportFailed(prepared.sourceInvoiceId, "Sage rejected the draft invoice. Review the preview and Sage mappings before trying again.", `sage_${error.status}`);
      return jsonResponse({ ok: false, error: "Sage rejected the draft invoice. No draft was confirmed as created." }, 502);
    }
    if (error instanceof SageAuthorizationError) {
      await database.value.markSageImportFailed(prepared.sourceInvoiceId, "Reconnect Sage before creating a draft invoice.", "authorization_error");
      return jsonResponse({ ok: false, error: "Reconnect Sage before creating a draft invoice." }, 401);
    }

    if (!reservedForCreate) {
      console.error("Sage duplicate check failed", safeError(error));
      return jsonResponse({ ok: false, error: "Sage could not be checked for an existing invoice. No draft was created." }, 502);
    }

    await database.value.markSageImportUncertain(
      prepared.sourceInvoiceId,
      "The Sage request did not return a reliable result. Check Sage for the Removals Manager reference before trying again.",
    );
    console.error("Sage draft invoice result uncertain", safeError(error));
    return jsonResponse({ ok: false, uncertain: true, error: "The Sage result is uncertain. Check Sage before trying again." }, 502);
  }
}

async function prepareSageDraftInvoice(
  database: ReturnType<typeof createImportDatabase>,
  businessId: string | null,
  sourceInvoiceId: string,
  dueDate: string,
): Promise<
  | { ok: true; sourceInvoiceId: string; contactId: string; preview: DraftInvoicePreview }
  | { ok: false; status: number; error: string }
> {
  if (!sourceInvoiceId) {
    return { ok: false, status: 400, error: "Save the reviewed batch, then select one invoice to preview." };
  }

  const lines = await database.listInvoiceLinesForSourceInvoice(sourceInvoiceId);
  if (lines.length === 0) {
    return { ok: false, status: 404, error: "The saved source invoice could not be found." };
  }

  const anchor = lines.find((line) => line.id === sourceInvoiceId) ?? lines[0];
  if (!anchor.rm_invoice_number || !anchor.invoice_date) {
    return { ok: false, status: 400, error: "This invoice is missing its Removals Manager number or date." };
  }

  if (!businessId) {
    return { ok: false, status: 401, error: "Connect Sage before preparing a draft invoice." };
  }

  const [customerMappings, taxMappings, ledgerMappings, taxRates, ledgerAccounts, importedIds] = await Promise.all([
    database.listCustomerMappings(businessId),
    database.listReferenceMappings(businessId, "tax_rate"),
    database.listReferenceMappings(businessId, "ledger_account"),
    database.listSageReferenceCache(businessId, "tax_rate"),
    database.listSageReferenceCache(businessId, "ledger_account"),
    database.importedSourceInvoiceIds([anchor.id]),
  ]);
  const readinessContext = {
    customerMappings,
    taxMappings: availableMappings(taxMappings, activeReferenceEntries(taxRates)),
    ledgerMappings: availableMappings(ledgerMappings, activeReferenceEntries(ledgerAccounts)),
    importedSourceInvoiceIds: importedIds,
  };

  if (importedIds.has(anchor.id)) {
    return { ok: false, status: 409, error: "This source invoice already has a Sage import record. Check Sage before another attempt." };
  }

  for (const line of lines) {
    const readiness = readinessForInvoice(sourceInvoiceForReadiness(line), readinessContext);
    if (readiness !== "ready_for_sage") {
      return { ok: false, status: 400, error: `Invoice ${anchor.rm_invoice_number} is not Sage-ready: ${readiness.replaceAll("_", " ")}.` };
    }
  }

  const customerNames = new Set(lines.map((line) => line.normalized_customer_name).filter(Boolean));
  if (customerNames.size !== 1) {
    return { ok: false, status: 400, error: "This invoice has inconsistent customer details and needs review." };
  }
  const customerMapping = customerMappings.find((mapping) =>
    mapping.manually_confirmed && mapping.normalized_customer_name === anchor.normalized_customer_name,
  );
  if (!customerMapping) {
    return { ok: false, status: 400, error: "A confirmed Sage customer mapping is required." };
  }

  try {
    const reconciliation = reconciliationForInvoice(lines);
    const preview = buildSageDraftInvoice({
      contactId: customerMapping.sage_contact_id,
      contactName: customerMapping.sage_contact_display_name,
      invoiceNumber: anchor.rm_invoice_number,
      invoiceDate: anchor.invoice_date,
      dueDate,
      reconciliation,
      lines: lines.map((line) => {
        const tax = readinessContext.taxMappings.find((mapping) => mapping.manually_confirmed && mapping.source_code === line.rm_tax_code);
        const ledger = readinessContext.ledgerMappings.find((mapping) =>
          mapping.manually_confirmed && mapping.source_code === line.rm_nominal_code && mapping.source_context === line.source_type,
        );
        if (!tax || !ledger) {
          throw new DraftInvoiceValidationError("A confirmed Sage tax and ledger mapping is required for every line.");
        }
        return {
          source: line,
          mapping: {
            ledgerAccountId: ledger.sage_entity_id,
            ledgerAccountName: ledger.sage_display_name,
            taxRateId: tax.sage_entity_id,
            taxRateName: tax.sage_display_name,
          },
        };
      }),
    });
    assertDraftCreationSafety({
      isStorage: lines.some((line) => line.classification === "exclude_storage"),
      alreadyImported: false,
      hasConfirmedContact: true,
      totalsMatch: draftTotalsMatchReconciliation(preview, reconciliation),
    });
    return { ok: true, sourceInvoiceId: anchor.id, contactId: customerMapping.sage_contact_id, preview };
  } catch (error) {
    if (error instanceof DraftInvoiceValidationError) {
      return { ok: false, status: 400, error: error.message };
    }
    throw error;
  }
}

function sourceInvoiceForReadiness(line: SourceInvoiceRecord): ReadinessInput {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(line.raw_source_json) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const warnings = parseStringArray(line.warnings_json);
  return {
    transaction_type: line.source_type,
    customer_name: line.customer_name ?? undefined,
    tax_code: line.rm_tax_code,
    nominal_code: line.rm_nominal_code,
    classification: line.classification,
    review_decision: line.review_decision,
    warnings,
    pdf_match_status: typeof raw.pdf_match_status === "string" ? raw.pdf_match_status : undefined,
    source_invoice_id: line.id,
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return ["Saved warning data could not be read."];
  }
}

function reconciliationForInvoice(lines: SourceInvoiceRecord[]): {
  csv_gross_minor: number | null;
  pdf_gross_minor: number | null;
  csv_vat_minor: number | null;
  pdf_vat_minor: number | null;
} | null {
  const raw = lines.map((line) => {
    try {
      return JSON.parse(line.raw_source_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  }).find((item) => typeof item.reconciled_csv_amount === "number" || typeof item.reconciled_pdf_amount === "number");
  if (!raw) {
    return null;
  }
  return {
    csv_gross_minor: moneyMinorFromRaw(raw.reconciled_csv_amount),
    pdf_gross_minor: moneyMinorFromRaw(raw.reconciled_pdf_amount),
    csv_vat_minor: moneyMinorFromRaw(raw.reconciled_csv_vat),
    pdf_vat_minor: moneyMinorFromRaw(raw.reconciled_pdf_vat),
  };
}

function moneyMinorFromRaw(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const minor = Math.round(value * 100);
  return Math.abs(value * 100 - minor) < 0.000001 ? minor : null;
}

function draftTotalsMatchReconciliation(
  preview: DraftInvoicePreview,
  reconciliation: DraftInvoicePreview["reconciliation"],
): boolean {
  if (!reconciliation) {
    return true;
  }
  const values = [
    [preview.totals.gross_minor, reconciliation.csv_gross_minor],
    [preview.totals.gross_minor, reconciliation.pdf_gross_minor],
    [preview.totals.vat_minor, reconciliation.csv_vat_minor],
    [preview.totals.vat_minor, reconciliation.pdf_vat_minor],
  ] as const;
  return values.every(([actual, expected]) => expected === null || actual === expected);
}

function sageInvoiceIdForReference(data: unknown, reference: string): string | null {
  const items = sageApiItems(data);
  const matching = items.find((item) => item.reference === reference);
  return matching && typeof matching.id === "string" ? matching.id : null;
}

function sageInvoiceIdFromResult(data: unknown): string | null {
  return data && typeof data === "object" && !Array.isArray(data) && typeof (data as Record<string, unknown>).id === "string"
    ? (data as Record<string, string>).id
    : null;
}

function sageApiItems(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return [];
  }
  const items = (data as Record<string, unknown>).$items ?? (data as Record<string, unknown>).items;
  return Array.isArray(items) ? items.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
}

function sageImportAlreadyReserved(status: string, sageInvoiceId: string | null): Response {
  const detail = sageInvoiceId ? ` Existing Sage draft ID: ${sageInvoiceId}.` : "";
  return jsonResponse({ ok: false, error: `This invoice is already reserved with status ${status}. Check Sage before another attempt.${detail}` }, 409);
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

function sageCallbackRedirect(result: string, headers: Record<string, string>): Response {
  return redirect(`/upload?sage=${encodeURIComponent(result)}`, headers);
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
      "Cache-Control": "no-store",
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
              <div class="step-title"><span class="step-badge">1</span><h2 id="upload-title">Add files</h2></div>
              <p>Start with the main removal invoices CSV. Add deposits, ad hoc invoices, credit notes and PDFs where you have them, then check the files before moving on.</p>
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
              <div class="file-dropzone">
                <span class="drop-icon" aria-hidden="true">+</span>
                <strong>Drop your CSV here</strong>
                <span>or choose it from your computer</span>
                <label for="removalInvoices">Choose CSV</label>
                <button class="file-remove-button" type="button" data-remove-file="removalInvoices" hidden>Remove file</button>
              </div>
              <input id="removalInvoices" type="file" accept=".csv,text/csv">
              <p class="field-message" id="removalInvoicesMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="removalDeposits">
              <div>
                <h3>Removal deposits CSV</h3>
                <p>Use this if deposits are exported separately from invoices.</p>
              </div>
              <div class="file-dropzone">
                <span class="drop-icon" aria-hidden="true">+</span>
                <strong>Drop your CSV here</strong>
                <span>or choose it from your computer</span>
                <label for="removalDeposits">Choose CSV</label>
                <button class="file-remove-button" type="button" data-remove-file="removalDeposits" hidden>Remove file</button>
              </div>
              <input id="removalDeposits" type="file" accept=".csv,text/csv">
              <p class="field-message" id="removalDepositsMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="adHocInvoices">
              <div>
                <h3>Ad Hoc invoices CSV</h3>
                <p>Use the ad hoc invoice export if Removals Manager provides one.</p>
              </div>
              <div class="file-dropzone">
                <span class="drop-icon" aria-hidden="true">+</span>
                <strong>Drop your CSV here</strong>
                <span>or choose it from your computer</span>
                <label for="adHocInvoices">Choose CSV</label>
                <button class="file-remove-button" type="button" data-remove-file="adHocInvoices" hidden>Remove file</button>
              </div>
              <input id="adHocInvoices" type="file" accept=".csv,text/csv">
              <p class="field-message" id="adHocInvoicesMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="creditNotes">
              <div>
                <h3>Credit notes CSV</h3>
                <p>Add credit notes here if Removals Manager can export them.</p>
              </div>
              <div class="file-dropzone">
                <span class="drop-icon" aria-hidden="true">+</span>
                <strong>Drop your CSV here</strong>
                <span>or choose it from your computer</span>
                <label for="creditNotes">Choose CSV</label>
                <button class="file-remove-button" type="button" data-remove-file="creditNotes" hidden>Remove file</button>
              </div>
              <input id="creditNotes" type="file" accept=".csv,text/csv">
              <p class="field-message" id="creditNotesMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="monthlyReport">
              <div>
                <h3>Monthly invoice report PDF</h3>
                <p>Add the monthly invoice report PDF if it is available for checking later.</p>
              </div>
              <div class="file-dropzone">
                <span class="drop-icon" aria-hidden="true">+</span>
                <strong>Drop your PDF here</strong>
                <span>or choose it from your computer</span>
                <label for="monthlyReport">Choose PDF</label>
                <button class="file-remove-button" type="button" data-remove-file="monthlyReport" hidden>Remove file</button>
              </div>
              <input id="monthlyReport" type="file" accept=".pdf,application/pdf">
              <p class="field-message" id="monthlyReportMessage">No file selected yet. This is optional.</p>
            </article>

            <article class="file-card" data-slot="invoicePdfs">
              <div>
                <h3>Individual invoice PDFs</h3>
                <p>Add a batch of invoice PDFs if you have them. Multiple files are allowed.</p>
              </div>
              <div class="file-dropzone">
                <span class="drop-icon" aria-hidden="true">+</span>
                <strong>Drop your PDFs here</strong>
                <span>or choose them from your computer</span>
                <label for="invoicePdfs">Choose PDFs</label>
                <button class="file-remove-button" type="button" data-remove-file="invoicePdfs" hidden>Remove files</button>
              </div>
              <input id="invoicePdfs" type="file" accept=".pdf,application/pdf" multiple>
              <p class="field-message" id="invoicePdfsMessage">No files selected yet. This is optional.</p>
            </article>
          </form>
        </section>

        <section class="results-panel" aria-live="polite">
          <div class="section-heading">
            <div>
              <div class="step-title"><span class="step-badge">2</span><h2>Check the import</h2></div>
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
              <div class="step-title"><span class="step-badge substep">2</span><h2>Reconciliation</h2></div>
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
              <div class="step-title"><span class="step-badge">3</span><h2>Review transactions</h2></div>
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
          <div id="reviewBatchActions" class="button-row review-batch-actions">
            <span>Apply to visible rows:</span>
            <button type="button" class="secondary-button" data-batch-review="include">Include</button>
            <button type="button" class="secondary-button" data-batch-review="exclude">Exclude</button>
            <button type="button" class="secondary-button" data-batch-review="review">Mark for review</button>
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
                  <th class="review-action-cell">Action</th>
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
              <div class="step-title"><span class="step-badge">4</span><h2>Set up Sage conversion</h2></div>
              <p id="mappingIntro">Your uploaded files contain Sage 50 tax and nominal codes. Choose the equivalent Sage Accounting options below. These choices will be saved and reused for future imports.</p>
            </div>
            <div class="button-row">
              <button id="refreshSageReferencesButton" class="secondary-button" type="button">Refresh Sage options</button>
              <small class="button-helper">Use this after changing Sage VAT settings or categories.</small>
            </div>
          </div>
          <div id="mappingNotice" class="notice"></div>
          <details id="sageReferenceDiagnostics" class="reference-diagnostics" hidden>
            <summary>Refresh details</summary>
            <div id="sageReferenceDiagnosticsBody"></div>
          </details>
          <div id="conversionSetupSummary" class="conversion-summary"></div>
          <details class="why-conversion">
            <summary>Why is this needed?</summary>
            <p>The uploaded CSV was created for Sage 50 and contains codes such as T9 and 4010. Sage Accounting uses its own VAT-rate and category records, so the app needs to know which Sage Accounting option each source code represents.</p>
            <p>You normally only need to complete this once. The app will reuse the saved choices on future imports.</p>
          </details>
          <div class="mapping-grid">
            <article>
              <h3>VAT conversion</h3>
              <p>Choose how each tax code from the Sage 50 export should be treated in Sage Accounting.</p>
              <div id="taxMappingBody" class="mapping-list">
                <p class="empty-state">No uploaded tax codes yet.</p>
              </div>
            </article>
            <article>
              <h3>Nominal code conversion</h3>
              <p>Choose which Sage Accounting category should be used for each nominal code in the Sage 50 export.</p>
              <div id="ledgerMappingBody" class="mapping-list">
                <p class="empty-state">No uploaded nominal codes yet.</p>
              </div>
            </article>
            <article>
              <h3>Customer matching</h3>
              <p>Match customers from the uploaded files to existing Sage contacts. Suggested matches are never accepted automatically.</p>
              <div id="customerMappingBody" class="mapping-list">
                <p class="empty-state">No customers found in the reviewed rows yet.</p>
              </div>
            </article>
          </div>
        </section>

        <section class="results-panel draft-panel" aria-live="polite">
          <div class="section-heading">
            <div>
              <div class="step-title"><span class="step-badge">5</span><h2>Prepare one Sage draft invoice</h2></div>
              <p>Choose a saved, Sage-ready invoice from the review table. This stage creates a draft only; it never sends, releases or publishes an invoice.</p>
            </div>
          </div>
          <div id="draftInvoiceNotice" class="notice"></div>
          <div id="draftInvoiceEmpty" class="draft-empty">Save the reviewed batch, then select “Preview draft” beside one Sage-ready invoice.</div>
          <div id="draftInvoiceWorkspace" class="draft-workspace" hidden>
            <div class="draft-controls">
              <label>Due date
                <input id="draftDueDate" type="date">
              </label>
              <button id="draftDryRunButton" type="button">Check draft details</button>
              <label class="confirm-control"><input id="draftConfirmCheckbox" type="checkbox"> I confirm this one draft should be created in Sage.</label>
              <button id="draftCreateButton" type="button" disabled>Create one draft invoice in Sage</button>
            </div>
            <div id="draftInvoicePreview" class="draft-preview"></div>
          </div>
        </section>
      </main>
      <script src="/assets/app.js?v=${APP_ASSET_VERSION}" defer></script>
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
    <link rel="stylesheet" href="/assets/styles.css?v=${APP_ASSET_VERSION}">
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
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 272px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fbfa;
  transition: border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease;
}

.file-card.is-dragging {
  border-color: var(--sage);
  background: #edf8f5;
  box-shadow: inset 0 0 0 1px var(--sage);
}

.file-card.is-dragging .file-dropzone {
  border-color: var(--sage);
  background: #e4f4ef;
}

.file-card.has-file {
  border-color: #268168;
  background: #f4fbf8;
  box-shadow: 0 0 0 2px rgba(38, 129, 104, 0.16), 0 6px 16px rgba(23, 111, 88, 0.1);
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

.file-dropzone {
  display: grid;
  min-height: 144px;
  padding: 16px;
  border: 1px dashed #8daea6;
  border-radius: 8px;
  background: #ffffff;
  place-items: center;
  align-content: center;
  gap: 6px;
  color: var(--muted);
  text-align: center;
  font-size: 0.9rem;
}

.file-dropzone strong {
  color: var(--ink);
  font-size: 1rem;
}

.drop-icon {
  display: grid;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  place-items: center;
  background: #dcefe9;
  color: var(--sage-dark);
  font-size: 1.7rem;
  font-weight: 800;
  line-height: 1;
}

.file-remove-button {
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #ffffff;
  color: var(--ink);
  cursor: pointer;
  font: inherit;
  font-size: 0.84rem;
  font-weight: 750;
}

.file-remove-button:hover {
  border-color: var(--danger);
  color: var(--danger);
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

.step-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.step-title h2 {
  margin: 0;
}

.step-badge {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: 50%;
  place-items: center;
  background: var(--sage);
  color: #ffffff;
  font-size: 0.84rem;
  font-weight: 850;
}

.step-badge.substep {
  background: #dcefe9;
  color: var(--sage-dark);
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

.review-action-cell {
  position: sticky;
  left: 0;
  z-index: 2;
  min-width: 174px;
  background: #ffffff;
  box-shadow: 8px 0 10px -12px rgba(31, 49, 54, 0.45);
}

.review-table thead .review-action-cell {
  z-index: 3;
  background: #eef5f3;
}

.review-table tr.risky-row .review-action-cell {
  background: #fff9f6;
}

.review-table tr.high-risk .review-action-cell {
  background: #fff4f3;
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

.button-helper {
  max-width: 220px;
  color: var(--muted);
  font-weight: 650;
  line-height: 1.35;
}

.conversion-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 22px;
  align-items: center;
  margin-bottom: 16px;
  padding: 14px 16px;
  border: 1px solid #e1bc72;
  border-radius: 8px;
  background: #fffaf0;
  color: #6d521f;
}

.conversion-summary strong {
  color: var(--ink);
}

.conversion-summary.complete {
  border-color: rgba(15, 107, 91, 0.28);
  background: #eff9f5;
  color: var(--sage-dark);
}

.why-conversion {
  margin: 0 0 16px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fbfa;
}

.why-conversion summary {
  cursor: pointer;
  color: var(--ink);
  font-weight: 800;
}

.why-conversion p {
  margin: 10px 0 0;
  color: var(--muted);
  line-height: 1.5;
}

.conversion-card {
  display: grid;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #ffffff;
}

.conversion-card summary {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  cursor: pointer;
  list-style: none;
}

.conversion-card summary::-webkit-details-marker {
  display: none;
}

.conversion-card summary::after {
  content: "+";
  color: var(--sage-dark);
  font-size: 1.2rem;
  font-weight: 800;
}

.conversion-card[open] summary::after {
  content: "−";
}

.conversion-card summary span {
  color: var(--muted);
  font-size: 0.82rem;
  font-weight: 700;
}

.conversion-card-content {
  display: grid;
  gap: 12px;
  padding-top: 14px;
}

.conversion-card h4,
.conversion-card p {
  margin: 0;
}

.conversion-source {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.conversion-source span,
.conversion-result span,
.conversion-meta {
  color: var(--muted);
  font-size: 0.82rem;
  font-weight: 700;
}

.conversion-source strong,
.conversion-result strong {
  display: block;
  margin-top: 3px;
  color: var(--ink);
}

.conversion-choice {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: end;
}

.conversion-choice label {
  display: grid;
  gap: 6px;
  color: var(--ink);
  font-size: 0.86rem;
  font-weight: 800;
}

.conversion-choice select,
.reference-search {
  min-height: 40px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #ffffff;
  color: var(--ink);
  font: inherit;
}

.conversion-suggestion {
  padding: 10px 12px;
  border-left: 3px solid #c9a55d;
  background: #fffbf2;
  color: #72591f;
  font-size: 0.88rem;
  line-height: 1.4;
}

.conversion-unavailable {
  margin: 0;
  color: var(--danger);
  font-size: 0.88rem;
  font-weight: 750;
}

.conversion-result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
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

.draft-workspace {
  display: grid;
  gap: 16px;
}

.draft-empty {
  padding: 18px;
  border: 1px dashed var(--line);
  color: var(--muted);
  font-weight: 700;
}

.draft-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fbfa;
}

.draft-controls > label:not(.confirm-control) {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 0.86rem;
  font-weight: 800;
}

.draft-controls input[type="date"] {
  min-height: 40px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #ffffff;
  color: var(--ink);
  font: inherit;
}

.confirm-control {
  display: inline-flex;
  max-width: 300px;
  gap: 8px;
  align-items: flex-start;
  color: var(--ink);
  font-size: 0.88rem;
  font-weight: 700;
}

.draft-preview {
  display: grid;
  gap: 14px;
}

.draft-preview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.draft-preview-grid article {
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #ffffff;
}

.draft-preview-grid span,
.draft-preview-grid strong {
  display: block;
}

.draft-preview-grid span {
  color: var(--muted);
  font-size: 0.78rem;
  font-weight: 800;
}

.draft-preview-grid strong {
  margin-top: 5px;
}

.draft-line-table {
  min-width: 760px;
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

  .draft-preview-grid {
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
const reviewBatchActions = document.querySelector("#reviewBatchActions");
const reviewTotals = document.querySelector("#reviewTotals");
const exportReviewButton = document.querySelector("#exportReviewButton");
const saveBatchButton = document.querySelector("#saveBatchButton");
const reviewSaveNotice = document.querySelector("#reviewSaveNotice");
const sageStatusText = document.querySelector("#sageStatusText");
const sageConnectLink = document.querySelector("#sageConnectLink");
const sageDisconnectButton = document.querySelector("#sageDisconnectButton");
const refreshSageReferencesButton = document.querySelector("#refreshSageReferencesButton");
const sageReferenceDiagnostics = document.querySelector("#sageReferenceDiagnostics");
const sageReferenceDiagnosticsBody = document.querySelector("#sageReferenceDiagnosticsBody");
const mappingNotice = document.querySelector("#mappingNotice");
const conversionSetupSummary = document.querySelector("#conversionSetupSummary");
const taxMappingBody = document.querySelector("#taxMappingBody");
const ledgerMappingBody = document.querySelector("#ledgerMappingBody");
const customerMappingBody = document.querySelector("#customerMappingBody");
const draftInvoiceNotice = document.querySelector("#draftInvoiceNotice");
const draftInvoiceEmpty = document.querySelector("#draftInvoiceEmpty");
const draftInvoiceWorkspace = document.querySelector("#draftInvoiceWorkspace");
const draftDueDate = document.querySelector("#draftDueDate");
const draftDryRunButton = document.querySelector("#draftDryRunButton");
const draftConfirmCheckbox = document.querySelector("#draftConfirmCheckbox");
const draftCreateButton = document.querySelector("#draftCreateButton");
const draftInvoicePreview = document.querySelector("#draftInvoicePreview");

const maxFileSizeBytes = 20 * 1024 * 1024;
let reviewRows = [];
let activeReviewFilter = "all";
let latestOriginalFileNames = [];
let sageReferences = emptySageReferences();
let activeDraftSourceInvoiceId = null;
let activeDraftPreview = null;
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

  const removeButton = document.querySelector('[data-remove-file="' + slot.id + '"]');
  removeButton.addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const card = input.closest(".file-card");
  for (const eventName of ["dragenter", "dragover"]) {
    card.addEventListener(eventName, (event) => {
      event.preventDefault();
      card.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "dragend"]) {
    card.addEventListener(eventName, () => card.classList.remove("is-dragging"));
  }
  card.addEventListener("drop", (event) => {
    event.preventDefault();
    card.classList.remove("is-dragging");
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length === 0) {
      return;
    }
    if (!slot.multiple && files.length > 1) {
      setFieldMessage(slot.id, "Please drop one file into this box.", "error");
      return;
    }
    const transfer = new DataTransfer();
    for (const file of files) {
      transfer.items.add(file);
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
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

reviewBatchActions.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-batch-review]") : null;
  if (!button || reviewRows.length === 0) {
    return;
  }

  const decision = button.dataset.batchReview;
  const visibleRows = reviewRows.filter(matchesActiveReviewFilter);
  let changed = 0;
  let skippedStorage = 0;
  for (const row of visibleRows) {
    if (decision === "include" && row.classification === "exclude_storage") {
      skippedStorage += 1;
      continue;
    }
    row.review_decision = decision;
    changed += 1;
  }
  reviewSaveNotice.className = "notice success";
  reviewSaveNotice.textContent = changed + " visible row" + plural(changed) + " updated." + (skippedStorage ? " " + skippedStorage + " storage row" + plural(skippedStorage) + " remain excluded for safety." : "");
  renderReviewTable();
  refreshSageReadiness();
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

reviewBody.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-preview-draft]") : null;
  if (!button) {
    return;
  }
  previewDraftInvoice(button.dataset.previewDraft || "");
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
    if (Array.isArray(result.source_invoice_ids) && result.source_invoice_ids.length === reviewRows.length) {
      for (let index = 0; index < reviewRows.length; index += 1) {
        reviewRows[index].source_invoice_id = result.source_invoice_ids[index];
      }
      saveBatchButton.disabled = true;
      saveBatchButton.textContent = "Reviewed batch saved";
      renderReviewTable();
    }
  } catch (error) {
    renderReviewSaveNotice("error", "The reviewed batch could not be saved.");
    console.error(error);
  } finally {
    if (!reviewRows.every((row) => row.source_invoice_id)) {
      saveBatchButton.disabled = reviewRows.length === 0;
      saveBatchButton.textContent = "Save reviewed batch";
    }
  }
});

draftDryRunButton.addEventListener("click", () => {
  if (activeDraftSourceInvoiceId) {
    previewDraftInvoice(activeDraftSourceInvoiceId);
  }
});

draftDueDate.addEventListener("change", () => {
  activeDraftPreview = null;
  draftCreateButton.disabled = true;
  renderDraftNotice("error", "Due date changed. Check the draft details again before creating it.");
});

draftConfirmCheckbox.addEventListener("change", () => {
  draftCreateButton.disabled = !activeDraftPreview || !draftConfirmCheckbox.checked;
});

draftCreateButton.addEventListener("click", async () => {
  if (!activeDraftSourceInvoiceId || !activeDraftPreview || !draftConfirmCheckbox.checked) {
    return;
  }
  if (!window.confirm("Create one draft invoice in Sage? It will not be sent, released or published.")) {
    return;
  }

  draftCreateButton.disabled = true;
  draftCreateButton.textContent = "Creating draft...";
  try {
    const response = await fetch("/api/sage/drafts/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_invoice_id: activeDraftSourceInvoiceId,
        due_date: draftDueDate.value,
        confirmed: true,
      }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      renderDraftNotice("error", result.error || "The Sage draft invoice could not be created.");
      return;
    }
    const prefix = result.found_existing ? "No new draft was created." : "One draft invoice was created.";
    renderDraftNotice("success", prefix + " Sage draft ID: " + result.sage_invoice_id + ". It has not been sent, released or published.");
    activeDraftPreview = null;
    draftConfirmCheckbox.checked = false;
    await refreshSageReadiness();
  } catch (error) {
    renderDraftNotice("error", "The Sage draft invoice result could not be confirmed. Check Sage before trying again.");
    console.error(error);
  } finally {
    draftCreateButton.textContent = "Create one draft invoice in Sage";
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

    const counts = result.counts || {};
    renderMappingNotice("success", "Sage options refreshed: " + (counts.taxRates || 0) + " VAT rates and " + (counts.ledgerAccounts || 0) + " ledger accounts found." + (Array.isArray(result.warnings) && result.warnings.length ? " " + result.warnings.join(" ") : ""));
    renderSageReferenceDiagnostics(result);
    await loadSageReferences();
    await refreshSageReadiness();
  } catch (error) {
    renderMappingNotice("error", "Sage references could not be refreshed.");
    console.error(error);
  } finally {
    refreshSageReferencesButton.disabled = false;
    refreshSageReferencesButton.textContent = "Refresh Sage options";
  }
});

taxMappingBody.addEventListener("click", async (event) => {
  const suggestion = event.target instanceof Element ? event.target.closest("[data-suggest-tax]") : null;
  const button = event.target instanceof Element ? event.target.closest("[data-save-tax]") : null;
  if (suggestion) {
    const select = taxMappingBody.querySelector("#" + cssEscape("tax-" + slug(suggestion.dataset.suggestTax || "")));
    if (select) {
      select.value = suggestion.dataset.sageEntityId || "";
    }
    return;
  }
  if (!button) {
    return;
  }

  await saveReferenceMapping("tax_rate", button.dataset.saveTax || "", "", taxMappingBody);
});

ledgerMappingBody.addEventListener("click", async (event) => {
  const suggestion = event.target instanceof Element ? event.target.closest("[data-suggest-ledger]") : null;
  const button = event.target instanceof Element ? event.target.closest("[data-save-ledger]") : null;
  if (suggestion) {
    const select = ledgerMappingBody.querySelector("#" + cssEscape("ledger-" + slug((suggestion.dataset.context || "") + "-" + (suggestion.dataset.suggestLedger || ""))));
    if (select) {
      select.value = suggestion.dataset.sageEntityId || "";
    }
    return;
  }
  if (!button) {
    return;
  }

  await saveReferenceMapping("ledger_account", button.dataset.saveLedger || "", button.dataset.context || "", ledgerMappingBody);
});

function filterReferenceOptions(event) {
  const search = event.target instanceof Element ? event.target.closest("[data-reference-search]") : null;
  if (!search) {
    return;
  }
  const select = ledgerMappingBody.querySelector("#" + cssEscape(search.dataset.referenceSearch || ""));
  const query = String(search.value || "").trim().toLowerCase();
  for (const option of Array.from(select?.options || [])) {
    const searchable = (option.dataset.referenceSearchText || option.textContent || "").toLowerCase();
    option.hidden = Boolean(query) && !searchable.includes(query);
  }
}

ledgerMappingBody.addEventListener("input", filterReferenceOptions);
taxMappingBody.addEventListener("input", filterReferenceOptions);

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
    document.querySelector('[data-slot="' + slot.id + '"]').classList.remove("has-file");
    document.querySelector('[data-remove-file="' + slot.id + '"]').hidden = true;
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
  document.querySelector('[data-slot="' + slot.id + '"]').classList.toggle("has-file", files.length > 0);
  document.querySelector('[data-remove-file="' + slot.id + '"]').hidden = files.length === 0;
  clearButton.disabled = !uploadSlots.some((item) => getFiles(item).length > 0);
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
  initialiseReviewRows(rows, result.reconciliation || []);

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

function initialiseReviewRows(rows, reconciliation) {
  const reconciliationByInvoice = new Map(reconciliation.map((entry) => [entry.invoice_number, entry]));
  reviewRows = rows.map((row, index) => {
    const classification = row.classification || "needs_review";
    const matched = reconciliationByInvoice.get(row.invoice_number);
    return {
      ...row,
      reconciled_csv_amount: matched ? matched.csv_amount : null,
      reconciled_pdf_amount: matched ? matched.pdf_amount : null,
      reconciled_csv_vat: matched ? matched.csv_vat : null,
      reconciled_pdf_vat: matched ? matched.pdf_vat : null,
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
  resetDraftInvoiceWorkspace();
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
  resetDraftInvoiceWorkspace();
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
      '<td class="review-action-cell">' + reviewActionSelect(row) + draftPreviewButton(row) + '</td>' +
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
  renderConversionSetupSummary();
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
    const usage = taxCodeUsage(code);
    const recommendation = taxRecommendation(code, options);
    const suggested = recommendation.candidate;
    const savedAvailable = saved && referenceIsAvailable(saved, options);
    const result = saved
      ? '<div class="conversion-result"><div><span>' + escapeHtml(code) + ' will be converted to</span><strong>' + escapeHtml(saved.sage_display_name) + '</strong></div><button class="secondary-button" type="button" data-save-tax="' + escapeHtml(code) + '">Change</button></div>' + (savedAvailable ? "" : '<p class="conversion-unavailable">This saved Sage option is no longer available. Please choose a replacement.</p>')
      : "";
    const suggestion = suggested
      ? '<div class="conversion-suggestion"><strong>Suggested match: ' + escapeHtml(sageTaxLabel(suggested)) + '</strong><br>T9 commonly represents a non-vatable treatment in Sage 50, and all ' + usage.count + ' imported row' + plural(usage.count) + ' currently show ' + formatSterling(usage.vat) + ' VAT. Please confirm this is the intended accounting treatment.<br><button class="secondary-button" type="button" data-suggest-tax="' + escapeHtml(code) + '" data-sage-entity-id="' + escapeHtml(suggested.sage_entity_id) + '">Use suggested option</button></div>'
      : recommendation.message ? '<p class="conversion-meta">' + escapeHtml(recommendation.message) + '</p>' : "";
    const summary = saved && savedAvailable
      ? escapeHtml(code + " → " + saved.sage_display_name) + '<span>Configured · ' + usage.count + ' transaction' + plural(usage.count) + '</span>'
      : escapeHtml(code) + '<span>Not configured · ' + usage.count + ' transaction' + plural(usage.count) + ' · ' + formatSterling(usage.vat) + ' VAT</span>';
    return '<details class="conversion-card"' + (saved && savedAvailable ? "" : " open") + '><summary><strong>' + summary + '</strong></summary><div class="conversion-card-content">' +
      '<div class="conversion-source"><div><span>Source tax code</span><strong>' + escapeHtml(code) + '</strong></div><div><span>Found in</span><strong>' + escapeHtml(usage.source) + '</strong></div></div>' +
      '<p class="conversion-meta">Used by ' + usage.count + ' transaction' + plural(usage.count) + ' · Source net total: ' + formatSterling(usage.net) + ' · Source VAT total: ' + formatSterling(usage.vat) + '<br>Example: ' + escapeHtml(usage.example) + (usage.allZeroVat ? ' · All source VAT values are £0.00' : '') + '</p>' +
      suggestion +
      '<p class="conversion-status">' + escapeHtml(saved && savedAvailable ? "Configured" : recommendation.status) + '</p>' +
      '<div class="conversion-choice"><label>Use in Sage Accounting' + sageReferenceSelect("tax-" + slug(code), options, saved?.sage_entity_id, "Select VAT treatment", sageTaxLabel) + referenceSearchInput("tax-" + slug(code), "Search VAT name, percentage or description") + '</label><button type="button" data-save-tax="' + escapeHtml(code) + '">Save VAT choice</button></div>' +
      result +
      '</div></details>';
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
    const usage = ledgerCodeUsage(entry.source_code, entry.source_context);
    const recommendation = ledgerRecommendation(entry.source_code, entry.source_context, options, usage.description);
    const suggested = recommendation.candidate;
    const savedAvailable = saved && referenceIsAvailable(saved, options);
    const result = saved
      ? '<div class="conversion-result"><div><span>' + escapeHtml(entry.source_code) + ' will be converted to</span><strong>' + escapeHtml(saved.sage_display_name) + '</strong></div><button class="secondary-button" type="button" data-save-ledger="' + escapeHtml(entry.source_code) + '" data-context="' + escapeHtml(entry.source_context) + '">Change</button></div>' + (savedAvailable ? "" : '<p class="conversion-unavailable">This saved Sage option is no longer available. Please choose a replacement.</p>')
      : "";
    const summary = saved && savedAvailable
      ? escapeHtml(entry.source_code + " → " + saved.sage_display_name) + '<span>Configured · ' + usage.count + ' transaction' + plural(usage.count) + '</span>'
      : escapeHtml(entry.source_code) + '<span>Not configured · ' + usage.count + ' transaction' + plural(usage.count) + ' · ' + formatSterling(usage.total) + '</span>';
    return '<details class="conversion-card"' + (saved && savedAvailable ? "" : " open") + '><summary><strong>' + summary + '</strong></summary><div class="conversion-card-content">' +
      '<div class="conversion-source"><div><span>Source nominal code</span><strong>' + escapeHtml(entry.source_code) + '</strong></div><div><span>Used for</span><strong>' + escapeHtml(formatTransactionType(entry.source_context)) + '</strong></div></div>' +
      '<p class="conversion-meta">Used by ' + usage.count + ' transaction' + plural(usage.count) + ' · Total value: ' + formatSterling(usage.total) + '<br>Example: ' + escapeHtml(usage.example) + '</p>' +
      (suggested ? '<div class="conversion-suggestion"><strong>Suggested match found</strong><br>' + escapeHtml(sageLedgerLabel(suggested)) + '<br>' + escapeHtml(sageLedgerGroupLabel(suggested)) + '<br><button class="secondary-button" type="button" data-suggest-ledger="' + escapeHtml(entry.source_code) + '" data-context="' + escapeHtml(entry.source_context) + '" data-sage-entity-id="' + escapeHtml(suggested.sage_entity_id) + '">Use suggested option</button></div>' : '<p class="conversion-meta">' + escapeHtml(recommendation.message) + '</p>') +
      '<p class="conversion-status">' + escapeHtml(saved && savedAvailable ? "Configured" : recommendation.status) + '</p>' +
      '<div class="conversion-choice"><label>Use in Sage Accounting' + sageReferenceSelect("ledger-" + slug(entry.source_context + "-" + entry.source_code), options, saved?.sage_entity_id, "Select sales or ledger category", sageLedgerLabel) + referenceSearchInput("ledger-" + slug(entry.source_context + "-" + entry.source_code), "Search by category code, name or group") + '</label><button type="button" data-save-ledger="' + escapeHtml(entry.source_code) + '" data-context="' + escapeHtml(entry.source_context) + '">Save category choice</button></div>' +
      result +
      '</div></details>';
  }).join("");
}

function renderCustomerMappings() {
  const customers = uniqueCustomers();

  if (customers.length === 0) {
    customerMappingBody.innerHTML = '<p class="empty-state">No customer matches are needed for the currently reviewed rows.<br><small>Customers will appear here after invoice rows have been reviewed and approved.</small></p>';
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

function renderSageReferenceDiagnostics(result) {
  if (!sageReferenceDiagnostics || !sageReferenceDiagnosticsBody) {
    return;
  }
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  const counts = result.counts || {};
  const lastStatus = diagnostics.length ? diagnostics[diagnostics.length - 1].status : "Not available";
  sageReferenceDiagnostics.hidden = false;
  sageReferenceDiagnosticsBody.innerHTML =
    '<p><strong>Connected business:</strong> ' + escapeHtml(result.businessName || "Unknown") + ' (' + escapeHtml(result.businessId || "Unknown") + ')</p>' +
    '<p><strong>VAT rates:</strong> ' + escapeHtml(String(counts.taxRates || 0)) + ' &middot; <strong>Ledger accounts:</strong> ' + escapeHtml(String(counts.ledgerAccounts || 0)) + ' &middot; <strong>Last Sage status:</strong> ' + escapeHtml(String(lastStatus)) + '</p>' +
    '<p><strong>Last refreshed:</strong> ' + escapeHtml(result.refreshed_at || "Not available") + '</p>';
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

function sageReferenceSelect(id, entries, selectedId, placeholder, labelForEntry) {
  const options = ['<option value="">' + escapeHtml(placeholder || "Choose Sage record") + '</option>'].concat(entries.map((entry) => {
    const selected = entry.sage_entity_id === selectedId ? " selected" : "";
    return '<option value="' + escapeHtml(entry.sage_entity_id) + '" data-reference-search-text="' + escapeHtml(sageReferenceSearchText(entry)) + '"' + selected + '>' + escapeHtml(labelForEntry ? labelForEntry(entry) : entry.sage_display_name) + '</option>';
  }));
  return '<select id="' + escapeHtml(id) + '">' + options.join("") + '</select>';
}

function referenceSearchInput(selectId, placeholder) {
  return '<input class="reference-search" type="search" data-reference-search="' + escapeHtml(selectId) + '" placeholder="' + escapeHtml(placeholder) + '">';
}

function renderConversionSetupSummary() {
  const taxCodes = distinctBy(reviewRows.map((row) => row.tax_code).filter(Boolean));
  const ledgerEntries = distinctLedgerEntries();
  const customers = uniqueCustomers();
  const taxOutstanding = taxCodes.filter((code) => {
    const mapping = sageReferences.tax_mappings.find((item) => item.source_code === code && item.manually_confirmed);
    return !mapping || !referenceIsAvailable(mapping, sageReferences.active_tax_rates || []);
  }).length;
  const ledgerOutstanding = ledgerEntries.filter((entry) => {
    const mapping = sageReferences.ledger_mappings.find((item) => item.source_code === entry.source_code && item.source_context === entry.source_context && item.manually_confirmed);
    return !mapping || !referenceIsAvailable(mapping, sageReferences.active_ledger_accounts || []);
  }).length;
  const customersOutstanding = customers.filter((customer) => !sageReferences.customer_mappings.some((mapping) => mapping.normalized_customer_name === customer.normalized && mapping.manually_confirmed)).length;
  const complete = reviewRows.length > 0 && taxOutstanding === 0 && ledgerOutstanding === 0 && customersOutstanding === 0;

  conversionSetupSummary.className = "conversion-summary" + (complete ? " complete" : "");
  conversionSetupSummary.innerHTML = complete
    ? '<strong>Ready to continue</strong><span>All required Sage conversion choices have been saved.</span>'
    : '<strong>Before continuing</strong>' +
      taxCodes.filter((code) => {
        const mapping = sageReferences.tax_mappings.find((item) => item.source_code === code && item.manually_confirmed);
        return !mapping || !referenceIsAvailable(mapping, sageReferences.active_tax_rates || []);
      }).map((code) => '<span>Choose a VAT treatment for ' + escapeHtml(code) + '</span>').join("") +
      ledgerEntries.filter((entry) => {
        const mapping = sageReferences.ledger_mappings.find((item) => item.source_code === entry.source_code && item.source_context === entry.source_context && item.manually_confirmed);
        return !mapping || !referenceIsAvailable(mapping, sageReferences.active_ledger_accounts || []);
      }).map((entry) => '<span>Choose a Sage category for ' + escapeHtml(entry.source_code) + '</span>').join("") +
      (customersOutstanding > 0 ? '<span>' + customersOutstanding + ' customer match' + plural(customersOutstanding) + ' outstanding</span>' : "");
}

function taxCodeUsage(code) {
  const rows = reviewRows.filter((row) => row.tax_code === code);
  return {
    count: rows.length,
    net: rows.reduce((total, row) => total + numericAmount(row.amount), 0),
    vat: rows.reduce((total, row) => total + numericAmount(row.vat_amount), 0),
    source: distinctBy(rows.map((row) => formatTransactionType(row.transaction_type))).join(", ") || "Uploaded CSV",
    example: rows[0]?.reference || rows[0]?.invoice_number || "No reference available",
    allZeroVat: rows.length > 0 && rows.every((row) => numericAmount(row.vat_amount) === 0),
  };
}

function ledgerCodeUsage(sourceCode, sourceContext) {
  const rows = reviewRows.filter((row) => row.nominal_code === sourceCode && row.transaction_type === sourceContext);
  return {
    count: rows.length,
    total: rows.reduce((total, row) => total + grossAmount(row), 0),
    example: rows[0]?.reference || rows[0]?.invoice_number || "No reference available",
    description: rows.map((row) => row.description).find(Boolean) || "",
  };
}

function ledgerRecommendation(sourceCode, transactionType, entries, sourceDescription) {
  const code = normaliseSageCode(sourceCode);
  const exactCodes = entries.filter((entry) => normaliseSageCode(entry.source_code) === code);
  if (exactCodes.length === 1) return { status: "Exact code match", candidate: exactCodes[0], message: "Exact code match" };
  if (exactCodes.length > 1) return { status: "Multiple possible matches", candidate: null, message: "Multiple Sage categories use this code. Choose the correct one." };
  const description = normaliseSageText(sourceDescription);
  const exactNames = description ? entries.filter((entry) => normaliseSageText(entry.sage_display_name) === description || normaliseSageText(entry.raw?.name) === description) : [];
  if (exactNames.length === 1) return { status: "Suggested by source code", candidate: exactNames[0], message: "Suggested by source description" };
  if (exactNames.length > 1) return { status: "Multiple possible matches", candidate: null, message: "Several Sage categories have this name. Choose the correct one." };
  const compatible = entries.filter((entry) => /sales|income|revenue/.test((String(entry.raw?.accountType || entry.raw?.account_type || "") + " " + String(entry.raw?.accountGroup || entry.raw?.account_group || "")).toLowerCase()));
  if (compatible.length === 1 && ["removal", "deposit", "ad_hoc", "credit_note"].includes(transactionType)) return { status: "Suggested by source code", candidate: compatible[0], message: "Suggested by transaction type" };
  return { status: "Manual choice required", candidate: null, message: "Manual choice required" };
}

function taxRecommendation(code, entries) {
  if (normaliseSageCode(code) !== "T9") return { status: "Manual choice required", candidate: null, message: "Manual choice required" };
  const salesEntries = entries.filter((entry) => entry.raw?.usableForSales !== false && entry.raw?.usable_for_sales !== false);
  const named = salesEntries.filter((entry) => /(no\s*vat|not\s*applicable|outside\s*scope)/i.test(entry.sage_display_name + " " + String(entry.raw?.name || "") + " " + String(entry.raw?.description || "")));
  if (named.length === 1) return { status: "Suggested by source code", candidate: named[0], message: "Suggested by source code" };
  if (named.length > 1) return { status: "Multiple possible matches", candidate: null, message: "Several 0% VAT options are available. Please choose the correct accounting treatment." };
  const zeroRates = salesEntries.filter((entry) => sagePercentage(entry) === 0);
  if (zeroRates.length > 1) return { status: "Multiple possible matches", candidate: null, message: "Several 0% VAT options are available. Please choose the correct accounting treatment." };
  return { status: "Manual choice required", candidate: null, message: "Manual choice required" };
}

function normaliseSageCode(value) {
  return String(value || "").trim().toUpperCase();
}

function normaliseSageText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function referenceIsAvailable(mapping, entries) {
  return entries.some((entry) => entry.sage_entity_id === mapping.sage_entity_id);
}

function sageTaxLabel(entry) {
  const percentage = sagePercentage(entry);
  return percentage === null ? entry.sage_display_name : entry.sage_display_name + " - " + percentage + "%";
}

function sageLedgerLabel(entry) {
  const code = entry.source_code ? entry.source_code + " - " : "";
  return code + entry.sage_display_name;
}

function sageLedgerGroupLabel(entry) {
  const raw = entry.raw || {};
  const group = raw.accountGroup || raw.account_group || raw.ledger_account_group || "";
  const type = raw.accountType || raw.account_type || raw.ledger_account_type || "";
  return group && type ? group + " · " + type : group || type || "Sage category";
}

function sageReferenceSearchText(entry) {
  const raw = entry.raw || {};
  return [entry.source_code, entry.sage_display_name, raw.name, raw.displayName, raw.description, raw.accountGroup, raw.account_group, raw.ledger_account_group, sagePercentage(entry)].filter((value) => value !== null && value !== undefined).join(" ");
}

function sagePercentage(entry) {
  const raw = entry.raw || {};
  for (const key of ["percentage", "rate", "tax_rate_percentage"]) {
    const value = raw[key];
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return null;
}

function formatSterling(value) {
  return "£" + formatMoney(value);
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

  const locked = storageLocked || !!row.source_invoice_id;
  return '<select class="action-select" data-review-action="' + escapeHtml(row.review_id) + '"' + (locked ? " disabled" : "") + (storageLocked ? ' title="Storage rows are excluded by default."' : row.source_invoice_id ? ' title="Saved rows are locked for draft safety."' : "") + ">" + optionHtml + "</select>";
}

function draftPreviewButton(row) {
  if (!row.source_invoice_id) {
    return '<small class="cell-muted">Save batch first</small>';
  }
  if (row.sage_readiness !== "ready_for_sage") {
    return '<small class="cell-muted">Not Sage-ready</small>';
  }
  const firstRowForInvoice = reviewRows.find((item) => item.invoice_number === row.invoice_number);
  if (!firstRowForInvoice || firstRowForInvoice.review_id !== row.review_id) {
    return '<small class="cell-muted">Included in this invoice</small>';
  }
  return '<button type="button" class="draft-preview-button" data-preview-draft="' + escapeHtml(row.source_invoice_id) + '">Preview draft</button>';
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

async function previewDraftInvoice(sourceInvoiceId) {
  const row = reviewRows.find((item) => item.source_invoice_id === sourceInvoiceId);
  if (!row) {
    renderDraftNotice("error", "Save the reviewed batch before preparing a draft.");
    return;
  }

  const changedInvoice = activeDraftSourceInvoiceId !== sourceInvoiceId;
  activeDraftSourceInvoiceId = sourceInvoiceId;
  activeDraftPreview = null;
  draftConfirmCheckbox.checked = false;
  draftCreateButton.disabled = true;
  if (changedInvoice || !draftDueDate.value) {
    draftDueDate.value = datePlusDays(row.date, 30);
  }
  draftInvoiceEmpty.hidden = true;
  draftInvoiceWorkspace.hidden = false;
  draftDryRunButton.disabled = true;
  draftDryRunButton.textContent = "Checking...";
  renderDraftNotice("", "");

  try {
    const response = await fetch("/api/sage/drafts/dry-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_invoice_id: sourceInvoiceId, due_date: draftDueDate.value }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      draftInvoicePreview.innerHTML = "";
      renderDraftNotice("error", result.error || "This invoice cannot be prepared as a Sage draft.");
      return;
    }
    activeDraftPreview = result.preview;
    renderDraftPreview(result.preview);
    renderDraftNotice("success", "Draft details checked. Review the totals, then confirm the one-off Sage action.");
  } catch (error) {
    draftInvoicePreview.innerHTML = "";
    renderDraftNotice("error", "The draft details could not be checked.");
    console.error(error);
  } finally {
    draftDryRunButton.disabled = false;
    draftDryRunButton.textContent = "Check draft details";
  }
}

function renderDraftPreview(preview) {
  const warnings = preview.warnings && preview.warnings.length > 0
    ? preview.warnings.map((warning) => '<li>' + escapeHtml(warning) + "</li>").join("")
    : "<li>No current warnings.</li>";
  const lines = preview.lines.map((line) => "<tr>" +
    tableCell(line.description) +
    tableCell(line.ledger_account) +
    tableCell(line.tax_rate) +
    tableCell(formatMoney(line.net_minor / 100)) +
    tableCell(formatMoney(line.vat_minor / 100)) +
    tableCell(formatMoney(line.gross_minor / 100)) +
    "</tr>").join("");
  const reconciliation = preview.reconciliation
    ? '<div class="draft-preview-grid">' +
        draftPreviewCard("Reconciled CSV gross", formatMinorMoney(preview.reconciliation.csv_gross_minor)) +
        draftPreviewCard("Reconciled PDF gross", formatMinorMoney(preview.reconciliation.pdf_gross_minor)) +
        draftPreviewCard("Draft gross", formatMoney(preview.totals.gross_minor / 100)) +
        draftPreviewCard("Reconciled CSV VAT", formatMinorMoney(preview.reconciliation.csv_vat_minor)) +
        draftPreviewCard("Reconciled PDF VAT", formatMinorMoney(preview.reconciliation.pdf_vat_minor)) +
        draftPreviewCard("Draft VAT", formatMoney(preview.totals.vat_minor / 100)) +
      "</div>"
    : '<p class="cell-muted">No monthly PDF totals were available to compare for this invoice.</p>';
  draftInvoicePreview.innerHTML =
    '<div class="draft-preview-grid">' +
      draftPreviewCard("Customer", preview.customer) +
      draftPreviewCard("Invoice reference", preview.invoice_reference) +
      draftPreviewCard("Invoice date", preview.invoice_date) +
      draftPreviewCard("Due date", preview.due_date) +
      draftPreviewCard("Net total", formatMoney(preview.totals.net_minor / 100)) +
      draftPreviewCard("VAT total", formatMoney(preview.totals.vat_minor / 100)) +
      draftPreviewCard("Gross total", formatMoney(preview.totals.gross_minor / 100)) +
    "</div>" +
    '<div class="table-wrap"><table class="draft-line-table"><thead><tr><th>Description</th><th>Ledger account</th><th>Tax rate</th><th>Net</th><th>VAT</th><th>Gross</th></tr></thead><tbody>' + lines + "</tbody></table></div>" +
    '<div><strong>Reconciliation comparison</strong>' + reconciliation + "</div>" +
    '<div><strong>Current warnings</strong><ul>' + warnings + "</ul></div>";
}

function draftPreviewCard(label, value) {
  return '<article><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(String(value || "-")) + "</strong></article>";
}

function formatMinorMoney(value) {
  return typeof value === "number" ? formatMoney(value / 100) : "Not available";
}

function resetDraftInvoiceWorkspace() {
  activeDraftSourceInvoiceId = null;
  activeDraftPreview = null;
  draftInvoiceEmpty.hidden = false;
  draftInvoiceWorkspace.hidden = true;
  draftInvoicePreview.innerHTML = "";
  draftInvoiceNotice.className = "notice";
  draftInvoiceNotice.textContent = "";
  draftConfirmCheckbox.checked = false;
  draftCreateButton.disabled = true;
}

function renderDraftNotice(state, message) {
  draftInvoiceNotice.className = "notice" + (message ? " show" : "") + (state ? " " + state : "");
  draftInvoiceNotice.textContent = message;
}

function datePlusDays(value, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    return "";
  }
  const date = new Date(value + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function loadSageStatus() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch("/api/sage/status", { signal: controller.signal });
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

    sageStatusText.textContent = sageConnectionOutcome() || "Sage is not connected.";
    sageConnectLink.textContent = "Connect Sage";
    sageDisconnectButton.disabled = true;
  } catch (error) {
    sageStatusText.textContent = error.name === "AbortError"
      ? "Sage connection status is taking too long to load. Refresh the page to try again."
      : "Sage status could not be loaded.";
    sageDisconnectButton.disabled = true;
    console.error(error);
  } finally {
    window.clearTimeout(timeout);
  }
}

function sageConnectionOutcome() {
  const result = new URLSearchParams(window.location.search).get("sage");
  const messages = {
    connected: "Sage connected successfully.",
    authorization_failed: "Sage did not return a valid authorization response. Start the connection again from this page.",
    token_exchange_failed: "Sage returned to the app, but did not issue usable access tokens. Check the client credentials, then try again.",
    business_lookup_failed: "Sage authorized the app, but its Accounting service could not return the business details. Please try again shortly.",
    storage_failed: "Sage authorized the app, but the connection could not be stored. Check the D1 binding and try again.",
    configuration_failed: "The Sage connection settings are incomplete in this deployment.",
    connection_failed: "Sage returned to the app, but the connection could not be completed. Please try again shortly.",
  };
  const message = messages[result];
  if (message) {
    window.history.replaceState({}, "", window.location.pathname);
  }
  return message || "";
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
