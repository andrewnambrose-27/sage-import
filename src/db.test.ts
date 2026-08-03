import { describe, expect, it } from "vitest";
import {
  DuplicateSourceInvoiceError,
  ImportDatabase,
  assertUniqueSourceHashes,
  buildSourceInvoiceRecord,
  hashSourceInvoice,
  mergeSavedInvoiceReviewData,
  moneyToMinorUnits,
  normalizeCustomerName,
  parseCachedReferenceJson,
  type PersistableSourceInvoice,
  type SageImportRecord,
} from "./db";

describe("moneyToMinorUnits", () => {
  it("serializes money to integer minor units without float arithmetic", () => {
    expect(moneyToMinorUnits("1234.56")).toBe(123456);
    expect(moneyToMinorUnits("0.10")).toBe(10);
    expect(moneyToMinorUnits("-10.05")).toBe(-1005);
    expect(moneyToMinorUnits("£1,200.00")).toBe(120000);
  });

  it("rejects values with more than two decimal places", () => {
    expect(() => moneyToMinorUnits("10.123")).toThrow("Invalid money value");
  });
});

describe("source invoice records", () => {
  it("normalizes customers and stores gross value as minor units", async () => {
    const record = await buildSourceInvoiceRecord(transaction({
      customer_name: "  Acme, Ltd.  ",
      amount: 100,
      vat_amount: 20,
      classification: "import_candidate",
    }), "batch-1", "2026-07-14T20:00:00.000Z");

    expect(record.normalized_customer_name).toBe("acme ltd");
    expect(record.net_amount_minor).toBe(10000);
    expect(record.vat_amount_minor).toBe(2000);
    expect(record.gross_amount_minor).toBe(12000);
    expect(record.review_decision).toBe("include");
  });

  it("keeps storage excluded by default", async () => {
    const record = await buildSourceInvoiceRecord(transaction({
      classification: "exclude_storage",
      review_decision: undefined,
    }), "batch-1", "2026-07-14T20:00:00.000Z");

    expect(record.review_decision).toBe("exclude");
  });

  it("builds stable hashes for duplicate source rows", async () => {
    const first = await buildSourceInvoiceRecord(transaction(), "batch-1", "2026-07-14T20:00:00.000Z");
    const second = await buildSourceInvoiceRecord(transaction(), "batch-2", "2026-07-15T20:00:00.000Z");

    expect(first.source_hash).toBe(second.source_hash);
  });

  it("refreshes customer and review enrichment without changing the saved invoice identity", async () => {
    const saved = await buildSourceInvoiceRecord(transaction({
      customer_name: undefined,
      classification: "missing_customer",
      review_decision: "include",
    }), "batch-1", "2026-07-14T20:00:00.000Z");
    const current = await buildSourceInvoiceRecord(transaction({
      customer_name: "Sarah Taylor",
      classification: "import_candidate",
      review_decision: "include",
    }), "", "");

    const refreshed = mergeSavedInvoiceReviewData(saved, current, "2026-08-03T15:45:00.000Z");

    expect(refreshed.id).toBe(saved.id);
    expect(refreshed.import_batch_id).toBe("batch-1");
    expect(refreshed.source_hash).toBe(saved.source_hash);
    expect(refreshed.customer_name).toBe("Sarah Taylor");
    expect(refreshed.normalized_customer_name).toBe("sarah taylor");
    expect(refreshed.classification).toBe("import_candidate");
    expect(refreshed.updated_at).toBe("2026-08-03T15:45:00.000Z");
  });

  it("refuses to refresh review data for a different source invoice", async () => {
    const saved = await buildSourceInvoiceRecord(transaction(), "batch-1", "2026-07-14T20:00:00.000Z");
    const different = await buildSourceInvoiceRecord(transaction({ amount: 101 }), "", "");

    expect(() => mergeSavedInvoiceReviewData(saved, different, "2026-08-03T15:45:00.000Z"))
      .toThrow("Only matching source invoices");
  });

  it("blocks duplicate hashes inside the same batch before inserting", () => {
    expect(() => assertUniqueSourceHashes([
      { source_hash: "same" },
      { source_hash: "same" },
    ])).toThrow(DuplicateSourceInvoiceError);
  });

  it("hashes object keys in stable order", async () => {
    await expect(hashSourceInvoice({ b: 2, a: 1 })).resolves.toBe(await hashSourceInvoice({ a: 1, b: 2 }));
  });
});

describe("normalizeCustomerName", () => {
  it("normalizes spacing, case and simple punctuation", () => {
    expect(normalizeCustomerName("  NORAM  Firns, Ltd. ")).toBe("noram firns ltd");
  });
});

describe("cached Sage reference JSON", () => {
  it("handles malformed cached JSON without breaking reference loading", () => {
    expect(parseCachedReferenceJson("{not-json")).toEqual({});
  });
});

describe("Sage import reservations", () => {
  it("allows a definitive failed attempt to retry but keeps the new pending reservation protected", async () => {
    let record: SageImportRecord = {
      id: "import-1",
      source_invoice_id: "source-1",
      sage_contact_id: "contact-old",
      sage_invoice_id: null,
      import_status: "failed",
      attempt_count: 1,
      error_code: "sage_422",
      safe_error_message: "Sage rejected the draft invoice.",
      created_at: "2026-08-03T14:51:50.922Z",
      updated_at: "2026-08-03T14:51:51.821Z",
    };
    const database = new ImportDatabase({
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                return record;
              },
              async run() {
                if (!sql.startsWith("UPDATE sage_imports") || record.import_status !== "failed") {
                  return { meta: { changes: 0 } };
                }
                record = {
                  ...record,
                  sage_contact_id: String(values[0]),
                  sage_invoice_id: null,
                  import_status: "pending",
                  attempt_count: record.attempt_count + 1,
                  error_code: null,
                  safe_error_message: null,
                  updated_at: String(values[1]),
                };
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database);

    await expect(database.reserveSageImport("source-1", "contact-new")).resolves.toMatchObject({
      reserved: true,
      record: { import_status: "pending", attempt_count: 2, sage_contact_id: "contact-new" },
    });
    await expect(database.reserveSageImport("source-1", "contact-new")).resolves.toMatchObject({
      reserved: false,
      record: { import_status: "pending", attempt_count: 2 },
    });
  });
});

function transaction(overrides: Partial<PersistableSourceInvoice> = {}): PersistableSourceInvoice {
  return {
    transaction_type: "removal",
    source_file: "removals.csv",
    row_number: 1,
    raw: ["SC", "", "4010", "", "26/05/2026", "RM inv no.4632", "Removal", "100", "T1", "20"],
    sage_transaction_type: "SC",
    account_ref: "",
    nominal_code: "4010",
    department: "",
    date: "2026-05-26",
    reference: "RM inv no.4632",
    invoice_number: "4632",
    description: "Removal",
    amount: 100,
    tax_code: "T1",
    vat_amount: 20,
    customer_name: "Acme Ltd",
    service_type: "Removal",
    classification: "import_candidate",
    warnings: [],
    ...overrides,
  };
}
