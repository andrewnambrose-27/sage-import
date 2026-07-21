import type { SourceInvoiceRecord } from "./db";

export interface SageInvoiceLineMapping {
  ledgerAccountId: string;
  ledgerAccountName: string;
  taxRateId: string;
  taxRateName: string;
}

export interface SageDraftInvoiceInput {
  contactId: string;
  contactName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  reconciliation?: {
    csv_gross_minor: number | null;
    pdf_gross_minor: number | null;
    csv_vat_minor: number | null;
    pdf_vat_minor: number | null;
  } | null;
  lines: Array<{
    source: SourceInvoiceRecord;
    mapping: SageInvoiceLineMapping;
  }>;
}

export interface SageSalesInvoicePayload {
  sales_invoice: {
    contact_id: string;
    date: string;
    due_date: string;
    reference: string;
    invoice_lines: Array<{
      description: string;
      quantity: number;
      unit_price: number;
      ledger_account_id: string;
      tax_rate_id: string;
    }>;
  };
}

export interface DraftInvoicePreview {
  payload: SageSalesInvoicePayload;
  customer: string;
  invoice_reference: string;
  invoice_date: string;
  due_date: string;
  lines: Array<{
    description: string;
    ledger_account: string;
    tax_rate: string;
    net_minor: number;
    vat_minor: number;
    gross_minor: number;
  }>;
  totals: {
    net_minor: number;
    vat_minor: number;
    gross_minor: number;
  };
  reconciliation: SageDraftInvoiceInput["reconciliation"];
  warnings: string[];
}

export class DraftInvoiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftInvoiceValidationError";
  }
}

export interface DraftCreationSafetyInput {
  isStorage: boolean;
  alreadyImported: boolean;
  hasConfirmedContact: boolean;
  totalsMatch: boolean;
}

export function assertDraftCreationSafety(input: DraftCreationSafetyInput): void {
  if (input.isStorage) {
    throw new DraftInvoiceValidationError("Storage invoices cannot be created in Sage.");
  }
  if (input.alreadyImported) {
    throw new DraftInvoiceValidationError("This source invoice already has a Sage import record.");
  }
  if (!input.hasConfirmedContact) {
    throw new DraftInvoiceValidationError("A confirmed Sage customer is required.");
  }
  if (!input.totalsMatch) {
    throw new DraftInvoiceValidationError("Draft totals do not match the reconciled CSV/PDF totals.");
  }
}

export function buildSageDraftInvoice(input: SageDraftInvoiceInput): DraftInvoicePreview {
  if (!input.contactId || !input.contactName) {
    throw new DraftInvoiceValidationError("A confirmed Sage customer is required.");
  }
  if (!input.invoiceNumber || !isIsoDate(input.invoiceDate) || !isIsoDate(input.dueDate)) {
    throw new DraftInvoiceValidationError("The invoice number, invoice date and due date are required.");
  }
  if (input.dueDate < input.invoiceDate) {
    throw new DraftInvoiceValidationError("The due date cannot be before the invoice date.");
  }
  if (input.lines.length === 0) {
    throw new DraftInvoiceValidationError("This invoice has no valid source lines.");
  }

  const warnings = uniqueWarnings(input.lines.flatMap(({ source }) => parseWarnings(source.warnings_json)));
  const lines = input.lines.map(({ source, mapping }) => {
    if (source.net_amount_minor === null || source.vat_amount_minor === null || source.gross_amount_minor === null) {
      throw new DraftInvoiceValidationError("Every invoice line must have exact net, VAT and gross values.");
    }
    if (!source.description.trim() || !mapping.ledgerAccountId || !mapping.taxRateId) {
      throw new DraftInvoiceValidationError("Every invoice line needs a description, ledger mapping and tax mapping.");
    }

    return {
      description: source.description,
      ledger_account: mapping.ledgerAccountName,
      tax_rate: mapping.taxRateName,
      net_minor: source.net_amount_minor,
      vat_minor: source.vat_amount_minor,
      gross_minor: source.gross_amount_minor,
      payload: {
        description: source.description,
        quantity: 1,
        unit_price: minorUnitsToSageNumber(source.net_amount_minor),
        ledger_account_id: mapping.ledgerAccountId,
        tax_rate_id: mapping.taxRateId,
      },
    };
  });

  const totals = lines.reduce((total, line) => ({
    net_minor: total.net_minor + line.net_minor,
    vat_minor: total.vat_minor + line.vat_minor,
    gross_minor: total.gross_minor + line.gross_minor,
  }), { net_minor: 0, vat_minor: 0, gross_minor: 0 });

  if (totals.gross_minor !== totals.net_minor + totals.vat_minor) {
    throw new DraftInvoiceValidationError("The source invoice totals do not reconcile exactly.");
  }

  const reference = `RM inv no.${input.invoiceNumber}`;
  return {
    payload: {
      sales_invoice: {
        contact_id: input.contactId,
        date: input.invoiceDate,
        due_date: input.dueDate,
        reference,
        invoice_lines: lines.map((line) => line.payload),
      },
    },
    customer: input.contactName,
    invoice_reference: reference,
    invoice_date: input.invoiceDate,
    due_date: input.dueDate,
    lines: lines.map(({ payload: _payload, ...line }) => line),
    totals,
    reconciliation: input.reconciliation ?? null,
    warnings,
  };
}

export function minorUnitsToSageNumber(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new DraftInvoiceValidationError("Money must be stored as whole minor units.");
  }
  return value / 100;
}

function parseWarnings(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return ["Saved warning data could not be read."];
  }
}

function uniqueWarnings(warnings: string[]): string[] {
  return [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))];
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
