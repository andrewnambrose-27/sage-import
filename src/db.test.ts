import { describe, expect, it } from "vitest";
import {
  DuplicateSourceInvoiceError,
  assertUniqueSourceHashes,
  buildSourceInvoiceRecord,
  hashSourceInvoice,
  moneyToMinorUnits,
  normalizeCustomerName,
  type PersistableSourceInvoice,
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
