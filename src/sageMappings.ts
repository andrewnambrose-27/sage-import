import { normalizeCustomerName, type PersistableSourceInvoice, type ReviewDecision } from "./db";
import type { TransactionType } from "./removalsParser";

export type SageReferenceType = "tax_rate" | "ledger_account";
export type SageReadinessStatus =
  | "ready_for_sage"
  | "missing_contact_mapping"
  | "missing_tax_mapping"
  | "missing_ledger_mapping"
  | "blocked_by_warning"
  | "already_imported";

export interface SageReferenceEntry {
  reference_type: SageReferenceType;
  sage_entity_id: string;
  source_code: string | null;
  sage_display_name: string;
  is_active: boolean;
  raw: Record<string, unknown>;
}

export interface SageReferenceMapping {
  mapping_type: SageReferenceType;
  source_code: string;
  source_context: string;
  sage_entity_id: string;
  sage_display_name: string;
  manually_confirmed: boolean;
}

export interface CustomerMapping {
  normalized_customer_name: string;
  customer_email: string | null;
  postcode: string | null;
  sage_contact_id: string;
  sage_contact_display_name: string;
  manually_confirmed: boolean;
}

export interface SageContactMatch {
  sage_contact_id: string;
  sage_contact_display_name: string;
  normalized_display_name: string;
  email: string | null;
  postcode: string | null;
}

export interface ReadinessInput extends Pick<PersistableSourceInvoice,
  "transaction_type" |
  "customer_name" |
  "tax_code" |
  "nominal_code" |
  "classification" |
  "warnings" |
  "pdf_match_status"
> {
  review_decision?: ReviewDecision;
  source_invoice_id?: string;
}

export interface ReadinessContext {
  customerMappings: CustomerMapping[];
  taxMappings: SageReferenceMapping[];
  ledgerMappings: SageReferenceMapping[];
  importedSourceInvoiceIds: Set<string>;
}

export function parseSageReferenceItems(data: unknown, referenceType: SageReferenceType): SageReferenceEntry[] {
  return extractItems(data).map((item) => {
    const id = stringValue(item, "id");
    const displayName = stringValue(item, "displayed_as") || stringValue(item, "display_name") || stringValue(item, "name");
    if (!id || !displayName) {
      return null;
    }

    return {
      reference_type: referenceType,
      sage_entity_id: id,
      source_code: stringValue(item, "code") || stringValue(item, "ledger_account_code") || null,
      sage_display_name: displayName,
      is_active: activeFromReference(item),
      raw: item,
    };
  }).filter((entry): entry is SageReferenceEntry => entry !== null);
}

export function parseSageContactItems(data: unknown): SageContactMatch[] {
  return extractItems(data).map((item) => {
    const id = stringValue(item, "id");
    const displayName = stringValue(item, "displayed_as") || stringValue(item, "name");
    if (!id || !displayName) {
      return null;
    }

    return {
      sage_contact_id: id,
      sage_contact_display_name: displayName,
      normalized_display_name: normalizeCustomerName(displayName),
      email: stringValue(item, "email") || null,
      postcode: postcodeFromContact(item),
    };
  }).filter((entry): entry is SageContactMatch => entry !== null);
}

export function contactMatchStatus(normalizedCustomerName: string, matches: SageContactMatch[]): "none" | "single_exact" | "ambiguous" {
  const exact = matches.filter((match) => match.normalized_display_name === normalizedCustomerName);
  if (exact.length === 1) {
    return "single_exact";
  }
  if (exact.length > 1 || matches.length > 1) {
    return "ambiguous";
  }
  return matches.length === 1 ? "ambiguous" : "none";
}

export function distinctTaxCodes(rows: Array<Pick<PersistableSourceInvoice, "tax_code">>): string[] {
  return [...new Set(rows.map((row) => row.tax_code.trim()).filter(Boolean))].sort();
}

export function distinctLedgerCodes(rows: Array<Pick<PersistableSourceInvoice, "nominal_code" | "transaction_type">>): Array<{ source_code: string; source_context: TransactionType }> {
  const map = new Map<string, { source_code: string; source_context: TransactionType }>();
  for (const row of rows) {
    const sourceCode = row.nominal_code.trim();
    if (!sourceCode) {
      continue;
    }
    map.set(`${sourceCode}|${row.transaction_type}`, {
      source_code: sourceCode,
      source_context: row.transaction_type,
    });
  }
  return [...map.values()].sort((left, right) => `${left.source_context}:${left.source_code}`.localeCompare(`${right.source_context}:${right.source_code}`));
}

export function readinessForInvoice(row: ReadinessInput, context: ReadinessContext): SageReadinessStatus {
  if (row.source_invoice_id && context.importedSourceInvoiceIds.has(row.source_invoice_id)) {
    return "already_imported";
  }

  if (row.review_decision !== "include" || row.classification === "exclude_storage" || hasBlockingWarning(row)) {
    return "blocked_by_warning";
  }

  const normalizedCustomerName = row.customer_name ? normalizeCustomerName(row.customer_name) : "";
  const customerMapping = context.customerMappings.find((mapping) =>
    mapping.manually_confirmed &&
    mapping.normalized_customer_name === normalizedCustomerName
  );
  if (!customerMapping) {
    return "missing_contact_mapping";
  }

  const taxMapping = context.taxMappings.find((mapping) =>
    mapping.manually_confirmed &&
    mapping.mapping_type === "tax_rate" &&
    mapping.source_code === row.tax_code
  );
  if (!taxMapping) {
    return "missing_tax_mapping";
  }

  const ledgerMapping = context.ledgerMappings.find((mapping) =>
    mapping.manually_confirmed &&
    mapping.mapping_type === "ledger_account" &&
    mapping.source_code === row.nominal_code &&
    mapping.source_context === row.transaction_type
  );
  if (!ledgerMapping) {
    return "missing_ledger_mapping";
  }

  return "ready_for_sage";
}

export function activeReferenceEntries(entries: SageReferenceEntry[]): SageReferenceEntry[] {
  return entries.filter((entry) => entry.is_active);
}

function hasBlockingWarning(row: ReadinessInput): boolean {
  if (row.classification === "amount_mismatch" || row.classification === "vat_mismatch" || row.classification === "possible_duplicate") {
    return true;
  }

  if (row.pdf_match_status === "amount_mismatch" || row.pdf_match_status === "vat_mismatch") {
    return true;
  }

  return row.warnings.some((warning) => {
    const lower = warning.toLowerCase();
    return lower.includes("mismatch") || lower.includes("duplicate") || lower.includes("storage") || lower.includes("overlap");
  });
}

function activeFromReference(item: Record<string, unknown>): boolean {
  if (typeof item.active === "boolean") {
    return item.active;
  }
  if (typeof item.inactive === "boolean") {
    return !item.inactive;
  }

  const status = stringValue(item, "status").toLowerCase();
  return status !== "inactive" && status !== "deleted" && status !== "archived";
}

function postcodeFromContact(item: Record<string, unknown>): string | null {
  const mainAddress = isRecord(item.main_address) ? item.main_address : null;
  return stringValue(mainAddress, "postal_code") || stringValue(mainAddress, "postcode") || null;
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
