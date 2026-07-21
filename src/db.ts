import type {
  NormalizedTransaction,
  TransactionClassification,
  TransactionType,
} from "./removalsParser";
import type {
  CustomerMapping,
  SageReferenceEntry,
  SageReferenceMapping,
  SageReferenceType,
} from "./sageMappings";

export type ReviewDecision = "include" | "exclude" | "review";
export type ImportBatchStatus = "reviewed" | "saved" | "sage_pending" | "sage_created" | "failed";
export type SageImportStatus = "pending" | "created" | "failed" | "uncertain" | "skipped";

export interface SaveReviewedBatchInput {
  reportingMonth?: string | null;
  createdBy: string;
  originalFileNames: string[];
  rows: PersistableSourceInvoice[];
  status?: ImportBatchStatus;
}

export interface PersistableSourceInvoice extends NormalizedTransaction {
  review_decision?: ReviewDecision;
  rm_job_id?: string | null;
}

export interface ImportBatchRecord {
  id: string;
  reporting_month: string | null;
  original_file_names: string;
  created_at: string;
  created_by: string;
  status: ImportBatchStatus;
  invoice_count: number;
  import_candidate_count: number;
  excluded_count: number;
  review_count: number;
}

export interface SourceInvoiceRecord {
  id: string;
  import_batch_id: string;
  source_type: TransactionType;
  rm_invoice_number: string | null;
  rm_job_id: string | null;
  customer_name: string | null;
  normalized_customer_name: string | null;
  invoice_date: string | null;
  description: string;
  net_amount_minor: number | null;
  vat_amount_minor: number | null;
  gross_amount_minor: number | null;
  rm_tax_code: string;
  rm_nominal_code: string;
  classification: TransactionClassification;
  review_decision: ReviewDecision;
  warnings_json: string;
  source_hash: string;
  raw_source_json: string;
  created_at: string;
  updated_at: string;
}

export interface SaveReviewedBatchResult {
  batch: ImportBatchRecord;
  invoices: SourceInvoiceRecord[];
}

export interface SageImportRecord {
  id: string;
  source_invoice_id: string;
  sage_contact_id: string | null;
  sage_invoice_id: string | null;
  import_status: SageImportStatus;
  attempt_count: number;
  error_code: string | null;
  safe_error_message: string | null;
  created_at: string;
  updated_at: string;
}

export type SageImportReservation =
  | { reserved: true; record: SageImportRecord }
  | { reserved: false; record: SageImportRecord };

export class DuplicateSourceInvoiceError extends Error {
  constructor(message = "One or more source invoices have already been saved.") {
    super(message);
    this.name = "DuplicateSourceInvoiceError";
  }
}

export function createImportDatabase(db: D1Database): ImportDatabase {
  return new ImportDatabase(db);
}

export class ImportDatabase {
  constructor(private readonly db: D1Database) {}

  async saveReviewedBatch(input: SaveReviewedBatchInput): Promise<SaveReviewedBatchResult> {
    const now = new Date().toISOString();
    const batchId = createId();
    const invoices = await Promise.all(input.rows.map((row) => buildSourceInvoiceRecord(row, batchId, now)));
    assertUniqueSourceHashes(invoices);

    const batch: ImportBatchRecord = {
      id: batchId,
      reporting_month: input.reportingMonth?.trim() || null,
      original_file_names: JSON.stringify([...new Set(input.originalFileNames.filter(Boolean))]),
      created_at: now,
      created_by: input.createdBy,
      status: input.status ?? "reviewed",
      invoice_count: invoices.length,
      import_candidate_count: invoices.filter((row) => row.classification === "import_candidate").length,
      excluded_count: invoices.filter((row) => row.classification === "exclude_storage" || row.review_decision === "exclude").length,
      review_count: invoices.filter((row) => row.review_decision === "review").length,
    };

    const statements = [
      this.db.prepare(
        `INSERT INTO import_batches (
          id, reporting_month, original_file_names, created_at, created_by, status,
          invoice_count, import_candidate_count, excluded_count, review_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        batch.id,
        batch.reporting_month,
        batch.original_file_names,
        batch.created_at,
        batch.created_by,
        batch.status,
        batch.invoice_count,
        batch.import_candidate_count,
        batch.excluded_count,
        batch.review_count,
      ),
      ...invoices.map((invoice) => this.db.prepare(
        `INSERT INTO source_invoices (
          id, import_batch_id, source_type, rm_invoice_number, rm_job_id, customer_name,
          normalized_customer_name, invoice_date, description, net_amount_minor, vat_amount_minor,
          gross_amount_minor, rm_tax_code, rm_nominal_code, classification, review_decision,
          warnings_json, source_hash, raw_source_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        invoice.id,
        invoice.import_batch_id,
        invoice.source_type,
        invoice.rm_invoice_number,
        invoice.rm_job_id,
        invoice.customer_name,
        invoice.normalized_customer_name,
        invoice.invoice_date,
        invoice.description,
        invoice.net_amount_minor,
        invoice.vat_amount_minor,
        invoice.gross_amount_minor,
        invoice.rm_tax_code,
        invoice.rm_nominal_code,
        invoice.classification,
        invoice.review_decision,
        invoice.warnings_json,
        invoice.source_hash,
        invoice.raw_source_json,
        invoice.created_at,
        invoice.updated_at,
      )),
    ];

    try {
      await this.db.batch(statements);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new DuplicateSourceInvoiceError();
      }
      throw error;
    }

    return { batch, invoices };
  }

  async replaceSageReferenceCache(referenceType: SageReferenceType, entries: SageReferenceEntry[], refreshedAt = new Date().toISOString()): Promise<void> {
    const statements = [
      this.db.prepare("DELETE FROM sage_reference_cache WHERE reference_type = ?").bind(referenceType),
      ...entries.map((entry) => this.db.prepare(
        `INSERT INTO sage_reference_cache (
          id, reference_type, sage_entity_id, source_code, sage_display_name,
          is_active, raw_reference_json, refreshed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        createId(),
        entry.reference_type,
        entry.sage_entity_id,
        entry.source_code,
        entry.sage_display_name,
        entry.is_active ? 1 : 0,
        JSON.stringify(entry.raw),
        refreshedAt,
      )),
    ];

    await this.db.batch(statements);
  }

  async listSageReferenceCache(referenceType: SageReferenceType): Promise<SageReferenceEntry[]> {
    const result = await this.db.prepare(
      `SELECT reference_type, sage_entity_id, source_code, sage_display_name, is_active, raw_reference_json
       FROM sage_reference_cache
       WHERE reference_type = ?
       ORDER BY sage_display_name`,
    ).bind(referenceType).all<{
      reference_type: SageReferenceType;
      sage_entity_id: string;
      source_code: string | null;
      sage_display_name: string;
      is_active: number;
      raw_reference_json: string;
    }>();

    return (result.results ?? []).map((row) => ({
      reference_type: row.reference_type,
      sage_entity_id: row.sage_entity_id,
      source_code: row.source_code,
      sage_display_name: row.sage_display_name,
      is_active: row.is_active === 1,
      raw: JSON.parse(row.raw_reference_json) as Record<string, unknown>,
    }));
  }

  async saveReferenceMapping(input: SageReferenceMapping): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO sage_reference_mappings (
        id, mapping_type, source_code, source_context, sage_entity_id,
        sage_display_name, manually_confirmed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mapping_type, source_code, source_context) DO UPDATE SET
        sage_entity_id = excluded.sage_entity_id,
        sage_display_name = excluded.sage_display_name,
        manually_confirmed = excluded.manually_confirmed,
        updated_at = excluded.updated_at`,
    ).bind(
      createId(),
      input.mapping_type,
      input.source_code,
      input.source_context,
      input.sage_entity_id,
      input.sage_display_name,
      input.manually_confirmed ? 1 : 0,
      now,
      now,
    ).run();
  }

  async listReferenceMappings(mappingType?: SageReferenceType): Promise<SageReferenceMapping[]> {
    const result = mappingType
      ? await this.db.prepare(
        `SELECT mapping_type, source_code, source_context, sage_entity_id, sage_display_name, manually_confirmed
         FROM sage_reference_mappings
         WHERE mapping_type = ?
         ORDER BY source_context, source_code`,
      ).bind(mappingType).all<SageReferenceMappingRow>()
      : await this.db.prepare(
        `SELECT mapping_type, source_code, source_context, sage_entity_id, sage_display_name, manually_confirmed
         FROM sage_reference_mappings
         ORDER BY mapping_type, source_context, source_code`,
      ).all<SageReferenceMappingRow>();

    return (result.results ?? []).map(referenceMappingFromRow);
  }

  async saveCustomerMapping(input: CustomerMapping): Promise<void> {
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare(
        `DELETE FROM customer_mappings
         WHERE normalized_customer_name = ?
           AND COALESCE(customer_email, '') = ?
           AND COALESCE(postcode, '') = ?`,
      ).bind(input.normalized_customer_name, input.customer_email ?? "", input.postcode ?? ""),
      this.db.prepare(
        `INSERT INTO customer_mappings (
          id, normalized_customer_name, customer_email, postcode, sage_contact_id,
          sage_contact_display_name, manually_confirmed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        createId(),
        input.normalized_customer_name,
        input.customer_email,
        input.postcode,
        input.sage_contact_id,
        input.sage_contact_display_name,
        input.manually_confirmed ? 1 : 0,
        now,
        now,
      ),
    ]);
  }

  async listCustomerMappings(): Promise<CustomerMapping[]> {
    const result = await this.db.prepare(
      `SELECT normalized_customer_name, customer_email, postcode, sage_contact_id, sage_contact_display_name, manually_confirmed
       FROM customer_mappings
       ORDER BY normalized_customer_name`,
    ).all<CustomerMappingRow>();

    return (result.results ?? []).map(customerMappingFromRow);
  }

  async importedSourceInvoiceIds(sourceInvoiceIds: string[]): Promise<Set<string>> {
    if (sourceInvoiceIds.length === 0) {
      return new Set();
    }

    const placeholders = sourceInvoiceIds.map(() => "?").join(",");
    const result = await this.db.prepare(
      `SELECT source_invoice_id
       FROM sage_imports
       WHERE source_invoice_id IN (${placeholders})
         AND import_status IN ('pending', 'created', 'uncertain')`,
    ).bind(...sourceInvoiceIds).all<{ source_invoice_id: string }>();

    return new Set((result.results ?? []).map((row) => row.source_invoice_id));
  }

  async getSourceInvoice(id: string): Promise<SourceInvoiceRecord | null> {
    return (await this.db.prepare("SELECT * FROM source_invoices WHERE id = ?").bind(id).first<SourceInvoiceRecord>()) ?? null;
  }

  async listInvoiceLinesForSourceInvoice(sourceInvoiceId: string): Promise<SourceInvoiceRecord[]> {
    const anchor = await this.getSourceInvoice(sourceInvoiceId);
    if (!anchor || !anchor.rm_invoice_number) {
      return anchor ? [anchor] : [];
    }

    const result = await this.db.prepare(
      `SELECT * FROM source_invoices
       WHERE import_batch_id = ? AND rm_invoice_number = ?
       ORDER BY rowid`,
    ).bind(anchor.import_batch_id, anchor.rm_invoice_number).all<SourceInvoiceRecord>();
    return result.results ?? [];
  }

  async getSageImport(sourceInvoiceId: string): Promise<SageImportRecord | null> {
    return (await this.db.prepare(
      "SELECT * FROM sage_imports WHERE source_invoice_id = ?",
    ).bind(sourceInvoiceId).first<SageImportRecord>()) ?? null;
  }

  async reserveSageImport(sourceInvoiceId: string, sageContactId: string): Promise<SageImportReservation> {
    const existing = await this.getSageImport(sourceInvoiceId);
    if (existing) {
      return { reserved: false, record: existing };
    }

    const now = new Date().toISOString();
    const record: SageImportRecord = {
      id: createId(),
      source_invoice_id: sourceInvoiceId,
      sage_contact_id: sageContactId,
      sage_invoice_id: null,
      import_status: "pending",
      attempt_count: 1,
      error_code: null,
      safe_error_message: null,
      created_at: now,
      updated_at: now,
    };

    try {
      await this.db.prepare(
        `INSERT INTO sage_imports (
          id, source_invoice_id, sage_contact_id, sage_invoice_id, import_status,
          attempt_count, error_code, safe_error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        record.id, record.source_invoice_id, record.sage_contact_id, record.sage_invoice_id,
        record.import_status, record.attempt_count, record.error_code, record.safe_error_message,
        record.created_at, record.updated_at,
      ).run();
      return { reserved: true, record };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      const concurrent = await this.getSageImport(sourceInvoiceId);
      if (!concurrent) {
        throw error;
      }
      return { reserved: false, record: concurrent };
    }
  }

  async markSageImportCreated(sourceInvoiceId: string, sageInvoiceId: string): Promise<void> {
    await this.updateSageImport(sourceInvoiceId, "created", {
      sageInvoiceId,
      errorCode: null,
      safeErrorMessage: null,
    });
  }

  async markSageImportUncertain(sourceInvoiceId: string, message: string): Promise<void> {
    await this.updateSageImport(sourceInvoiceId, "uncertain", {
      errorCode: "uncertain_result",
      safeErrorMessage: message,
    });
  }

  async markSageImportFailed(sourceInvoiceId: string, message: string, errorCode = "sage_request_failed"): Promise<void> {
    await this.updateSageImport(sourceInvoiceId, "failed", {
      errorCode,
      safeErrorMessage: message,
    });
  }

  private async updateSageImport(
    sourceInvoiceId: string,
    status: SageImportStatus,
    values: { sageInvoiceId?: string | null; errorCode: string | null; safeErrorMessage: string | null },
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE sage_imports
       SET sage_invoice_id = COALESCE(?, sage_invoice_id), import_status = ?, error_code = ?,
           safe_error_message = ?, updated_at = ?
       WHERE source_invoice_id = ?`,
    ).bind(
      values.sageInvoiceId ?? null, status, values.errorCode, values.safeErrorMessage,
      new Date().toISOString(), sourceInvoiceId,
    ).run();
  }
}

interface SageReferenceMappingRow {
  mapping_type: SageReferenceType;
  source_code: string;
  source_context: string;
  sage_entity_id: string;
  sage_display_name: string;
  manually_confirmed: number;
}

interface CustomerMappingRow {
  normalized_customer_name: string;
  customer_email: string | null;
  postcode: string | null;
  sage_contact_id: string;
  sage_contact_display_name: string;
  manually_confirmed: number;
}

export async function buildSourceInvoiceRecord(
  row: PersistableSourceInvoice,
  importBatchId: string,
  now: string,
): Promise<SourceInvoiceRecord> {
  const netAmount = moneyToMinorUnits(row.amount);
  const vatAmount = moneyToMinorUnits(row.vat_amount);
  const classification = row.classification ?? "needs_review";
  const rawSource = buildRawSourcePayload(row);
  const warnings = row.warnings ?? [];

  return {
    id: createId(),
    import_batch_id: importBatchId,
    source_type: row.transaction_type,
    rm_invoice_number: row.invoice_number,
    rm_job_id: row.rm_job_id ?? null,
    customer_name: row.customer_name ?? null,
    normalized_customer_name: row.customer_name ? normalizeCustomerName(row.customer_name) : null,
    invoice_date: row.date,
    description: row.description,
    net_amount_minor: netAmount,
    vat_amount_minor: vatAmount,
    gross_amount_minor: netAmount === null || vatAmount === null ? null : netAmount + vatAmount,
    rm_tax_code: row.tax_code,
    rm_nominal_code: row.nominal_code,
    classification,
    review_decision: row.review_decision ?? defaultReviewDecision(classification),
    warnings_json: JSON.stringify(warnings),
    source_hash: await hashSourceInvoice({
      source_type: row.transaction_type,
      rm_invoice_number: row.invoice_number,
      invoice_date: row.date,
      description: row.description,
      net_amount_minor: netAmount,
      vat_amount_minor: vatAmount,
      rm_tax_code: row.tax_code,
      rm_nominal_code: row.nominal_code,
    }),
    raw_source_json: JSON.stringify(rawSource),
    created_at: now,
    updated_at: now,
  };
}

export function moneyToMinorUnits(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const text = String(value).trim().replace(/[\u00A3,\s]/g, "");
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error(`Invalid money value: ${String(value)}`);
  }

  const sign = text.startsWith("-") ? -1 : 1;
  const unsigned = sign === -1 ? text.slice(1) : text;
  const [pounds, pence = ""] = unsigned.split(".");
  return sign * (Number(pounds) * 100 + Number(pence.padEnd(2, "0")));
}

export function normalizeCustomerName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,'"]/g, "");
}

export function assertUniqueSourceHashes(records: Array<{ source_hash: string }>): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.source_hash)) {
      throw new DuplicateSourceInvoiceError("Duplicate source invoice detected in this batch.");
    }
    seen.add(record.source_hash);
  }
}

export async function hashSourceInvoice(value: unknown): Promise<string> {
  const payload = stableJson(value);
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildRawSourcePayload(row: PersistableSourceInvoice): Record<string, unknown> {
  return {
    source_file: row.source_file,
    row_number: row.row_number,
    raw: row.raw,
    sage_transaction_type: row.sage_transaction_type,
    account_ref: row.account_ref,
    nominal_code: row.nominal_code,
    department: row.department,
    reference: row.reference,
    tax_code: row.tax_code,
    pdf_match_status: row.pdf_match_status,
    reconciled_csv_amount: row.reconciled_csv_amount,
    reconciled_pdf_amount: row.reconciled_pdf_amount,
    reconciled_csv_vat: row.reconciled_csv_vat,
    reconciled_pdf_vat: row.reconciled_pdf_vat,
    classification_reasons: row.classification_reasons,
  };
}

function defaultReviewDecision(classification: TransactionClassification): ReviewDecision {
  if (classification === "import_candidate") {
    return "include";
  }
  if (classification === "exclude_storage") {
    return "exclude";
  }
  return "review";
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique|constraint/i.test(error.message);
}

function referenceMappingFromRow(row: SageReferenceMappingRow): SageReferenceMapping {
  return {
    mapping_type: row.mapping_type,
    source_code: row.source_code,
    source_context: row.source_context,
    sage_entity_id: row.sage_entity_id,
    sage_display_name: row.sage_display_name,
    manually_confirmed: row.manually_confirmed === 1,
  };
}

function customerMappingFromRow(row: CustomerMappingRow): CustomerMapping {
  return {
    normalized_customer_name: row.normalized_customer_name,
    customer_email: row.customer_email,
    postcode: row.postcode,
    sage_contact_id: row.sage_contact_id,
    sage_contact_display_name: row.sage_contact_display_name,
    manually_confirmed: row.manually_confirmed === 1,
  };
}

function createId(): string {
  return crypto.randomUUID();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}
