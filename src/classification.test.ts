import { describe, expect, it } from "vitest";
import { classifyTransactions } from "./classification";
import type { ReconciliationRow } from "./reconciliation";
import type { NormalizedTransaction, TransactionType } from "./removalsParser";

describe("classifyTransactions", () => {
  it("excludes storage rows using service type and description", () => {
    const result = classifyTransactions([
      transaction({ service_type: "Storage", description: "Monthly storage" }),
    ]);

    expect(result.transactions[0]).toMatchObject({
      classification: "exclude_storage",
      export_allowed_by_default: false,
    });
    expect(result.summary.excluded_storage_rows).toBe(1);
  });

  it("marks normal removal invoices as import candidates", () => {
    const result = classifyTransactions([
      transaction({ transaction_type: "removal", description: "Removal", customer_name: "Smith Ltd" }),
    ]);

    expect(result.transactions[0]).toMatchObject({
      classification: "import_candidate",
      export_allowed_by_default: true,
    });
    expect(result.summary.import_candidates).toBe(1);
    expect(result.summary.total_import_candidate_value).toBe(120);
  });

  it("classifies deposits separately for careful review", () => {
    const result = classifyTransactions([
      transaction({ transaction_type: "deposit", description: "Removal deposit", customer_name: "Smith Ltd" }),
    ]);

    expect(result.transactions[0].classification).toBe("needs_review");
    expect(result.transactions[0].warnings).toContain("Deposit rows should be checked carefully before import.");
  });

  it("allows ad hoc invoices as import candidates", () => {
    const result = classifyTransactions([
      transaction({ transaction_type: "ad_hoc", description: "Crate hire", customer_name: "Smith Ltd" }),
    ]);

    expect(result.transactions[0].classification).toBe("import_candidate");
  });

  it("keeps credit notes in review", () => {
    const result = classifyTransactions([
      transaction({ transaction_type: "credit_note", description: "Credit note", customer_name: "Smith Ltd" }),
    ]);

    expect(result.transactions[0].classification).toBe("needs_review");
  });

  it("flags storage-related credit notes for manual review rather than exclusion", () => {
    const result = classifyTransactions([
      transaction({ transaction_type: "credit_note", description: "Storage refund", customer_name: "Smith Ltd" }),
    ]);

    expect(result.transactions[0].classification).toBe("possible_storage_credit");
    expect(result.summary.excluded_storage_rows).toBe(0);
  });

  it("uses reconciliation mismatches as classifications", () => {
    const amount = classifyTransactions(
      [transaction({ invoice_number: "1001", customer_name: "Smith Ltd" })],
      [reconciliation({ invoice_number: "1001", status: "amount_mismatch" })],
    );
    const vat = classifyTransactions(
      [transaction({ invoice_number: "1002", customer_name: "Smith Ltd" })],
      [reconciliation({ invoice_number: "1002", status: "vat_mismatch" })],
    );

    expect(amount.transactions[0].classification).toBe("amount_mismatch");
    expect(vat.transactions[0].classification).toBe("vat_mismatch");
  });

  it("flags missing customers", () => {
    const result = classifyTransactions([
      transaction({ customer_name: undefined, warnings: [] }),
    ]);

    expect(result.transactions[0].classification).toBe("missing_customer");
  });

  it("flags duplicate rows and deposit/final invoice overlaps", () => {
    const duplicate = transaction({ invoice_number: "2001", customer_name: "Smith Ltd" });
    const result = classifyTransactions([
      duplicate,
      duplicate,
      transaction({ transaction_type: "deposit", invoice_number: "2002", customer_name: "Jones Ltd" }),
      transaction({ transaction_type: "removal", invoice_number: "2002", customer_name: "Jones Ltd" }),
    ]);

    expect(result.transactions.filter((row) => row.classification === "possible_duplicate")).toHaveLength(4);
    expect(result.summary.duplicate_warnings).toBe(4);
  });

  it("adds a warning for rows that appear to combine multiple invoices or storage amounts", () => {
    const result = classifyTransactions([
      transaction({
        customer_name: "Smith Ltd",
        description: "Combined invoices 1001 and 1002",
        reference: "RM inv no.1001",
      }),
    ]);

    expect(result.transactions[0].classification).toBe("needs_review");
    expect(result.transactions[0].warnings).toContain("Amount may include more than one invoice or a storage amount.");
  });
});

function transaction(overrides: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  return {
    transaction_type: "removal" as TransactionType,
    source_file: "removals.csv",
    row_number: 1,
    raw: [],
    sage_transaction_type: "SI",
    account_ref: "",
    nominal_code: "4010",
    department: "",
    date: "2026-05-26",
    reference: "RM inv no.1001",
    invoice_number: "1001",
    description: "Removal",
    amount: 100,
    tax_code: "T1",
    vat_amount: 20,
    customer_name: "Smith Ltd",
    service_type: "removal",
    warnings: [],
    ...overrides,
  };
}

function reconciliation(overrides: Partial<ReconciliationRow>): ReconciliationRow {
  return {
    invoice_number: "1001",
    status: "matched",
    customer_name: "Smith Ltd",
    service_type: "removal",
    csv_amount: 120,
    pdf_amount: 120,
    csv_vat: 20,
    pdf_vat: 20,
    warnings: [],
    ...overrides,
  };
}
