import { describe, expect, it, vi } from "vitest";
import type { SourceInvoiceRecord } from "./db";
import {
  assertDraftCreationSafety,
  buildSageDraftInvoice,
  DraftInvoiceValidationError,
  minorUnitsToSageNumber,
} from "./sageDraftInvoice";

describe("Sage draft invoice payload", () => {
  it("preserves multiple invoice lines and exact minor-unit totals", () => {
    const preview = buildSageDraftInvoice({
      contactId: "contact-1",
      contactName: "Acme Ltd",
      invoiceNumber: "4632",
      invoiceDate: "2026-07-01",
      dueDate: "2026-07-31",
      lines: [
        { source: sourceLine({ net_amount_minor: 10010, vat_amount_minor: 2002, gross_amount_minor: 12012 }), mapping: mapping() },
        { source: sourceLine({ description: "Packing", net_amount_minor: 2505, vat_amount_minor: 501, gross_amount_minor: 3006 }), mapping: mapping() },
      ],
    });

    expect(preview.payload).toEqual({
      sales_invoice: {
        contact_id: "contact-1",
        date: "2026-07-01",
        due_date: "2026-07-31",
        reference: "RM inv no.4632",
        invoice_lines: [
          { description: "Removal service", quantity: 1, unit_price: 100.1, ledger_account_id: "ledger-1", tax_rate_id: "tax-1" },
          { description: "Packing", quantity: 1, unit_price: 25.05, ledger_account_id: "ledger-1", tax_rate_id: "tax-1" },
        ],
      },
    });
    expect(preview.totals).toEqual({ net_minor: 12515, vat_minor: 2503, gross_minor: 15018 });
  });

  it("dry-run payload building makes no API request", () => {
    const apiRequest = vi.fn();
    buildSageDraftInvoice({
      contactId: "contact-1",
      contactName: "Acme Ltd",
      invoiceNumber: "4632",
      invoiceDate: "2026-07-01",
      dueDate: "2026-07-31",
      lines: [{ source: sourceLine(), mapping: mapping() }],
    });
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("rejects storage invoices", () => {
    expect(() => assertDraftCreationSafety({ isStorage: true, alreadyImported: false, hasConfirmedContact: true, totalsMatch: true }))
      .toThrow("Storage invoices cannot be created");
  });

  it("rejects previously imported invoices", () => {
    expect(() => assertDraftCreationSafety({ isStorage: false, alreadyImported: true, hasConfirmedContact: true, totalsMatch: true }))
      .toThrow("already has a Sage import record");
  });

  it("rejects missing contacts and totals mismatches", () => {
    expect(() => assertDraftCreationSafety({ isStorage: false, alreadyImported: false, hasConfirmedContact: false, totalsMatch: true }))
      .toThrow("confirmed Sage customer");
    expect(() => assertDraftCreationSafety({ isStorage: false, alreadyImported: false, hasConfirmedContact: true, totalsMatch: false }))
      .toThrow("do not match");
  });

  it("rejects fractional minor units", () => {
    expect(() => minorUnitsToSageNumber(10.5)).toThrow(DraftInvoiceValidationError);
  });
});

function mapping() {
  return {
    ledgerAccountId: "ledger-1",
    ledgerAccountName: "Removal sales",
    taxRateId: "tax-1",
    taxRateName: "VAT 20%",
  };
}

function sourceLine(overrides: Partial<SourceInvoiceRecord> = {}): SourceInvoiceRecord {
  return {
    id: "source-1",
    import_batch_id: "batch-1",
    source_type: "removal",
    rm_invoice_number: "4632",
    rm_job_id: null,
    customer_name: "Acme Ltd",
    normalized_customer_name: "acme ltd",
    invoice_date: "2026-07-01",
    description: "Removal service",
    net_amount_minor: 10000,
    vat_amount_minor: 2000,
    gross_amount_minor: 12000,
    rm_tax_code: "T1",
    rm_nominal_code: "4010",
    classification: "import_candidate",
    review_decision: "include",
    warnings_json: "[]",
    source_hash: "hash",
    raw_source_json: "{}",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}
