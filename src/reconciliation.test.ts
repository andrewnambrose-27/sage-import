import { describe, expect, it } from "vitest";
import type { MonthlyInvoiceReportRow } from "./monthlyReportParser";
import { reconcileTransactionsWithPdf } from "./reconciliation";
import type { NormalizedTransaction } from "./removalsParser";

describe("reconcileTransactionsWithPdf", () => {
  it("enriches matched CSV rows with PDF customer and service details", () => {
    const result = reconcileTransactionsWithPdf(
      [
        transaction({ invoice_number: "4632", amount: 300, vat_amount: 60 }),
        transaction({ invoice_number: "4632", amount: 40, vat_amount: 20 }),
      ],
      [pdfRow({ invoice_number: "4632", invoice_total: 420, vat_amount: 80 })],
    );

    expect(result.transactions[0]).toMatchObject({
      customer_name: "Andrew Smith Ltd",
      service_type: "removal",
      pdf_match_status: "matched",
    });
    expect(result.reconciliation[0]).toMatchObject({
      invoice_number: "4632",
      status: "matched",
      csv_amount: 420,
      pdf_amount: 420,
      csv_vat: 80,
      pdf_vat: 80,
    });
  });

  it("flags CSV rows missing from the PDF report", () => {
    const result = reconcileTransactionsWithPdf(
      [transaction({ invoice_number: "4633", amount: 100, vat_amount: 0 })],
      [],
    );

    expect(result.transactions[0].pdf_match_status).toBe("missing_from_pdf");
    expect(result.reconciliation[0].status).toBe("missing_from_pdf");
  });

  it("flags PDF rows missing from CSV and excludes storage PDF rows", () => {
    const result = reconcileTransactionsWithPdf(
      [],
      [
        pdfRow({ invoice_number: "4634" }),
        pdfRow({ invoice_number: "9000", service_type: "storage", excluded: true }),
      ],
    );

    expect(result.reconciliation).toHaveLength(1);
    expect(result.reconciliation[0].status).toBe("missing_from_csv");
    expect(result.pdf_rows.map((row) => row.invoice_number)).toEqual(["4634"]);
  });

  it("flags amount and VAT mismatches", () => {
    const amountMismatch = reconcileTransactionsWithPdf(
      [transaction({ invoice_number: "4635", amount: 100, vat_amount: 20 })],
      [pdfRow({ invoice_number: "4635", invoice_total: 130, vat_amount: 20 })],
    );
    const vatMismatch = reconcileTransactionsWithPdf(
      [transaction({ invoice_number: "4636", amount: 100, vat_amount: 20 })],
      [pdfRow({ invoice_number: "4636", invoice_total: 120, vat_amount: 25 })],
    );

    expect(amountMismatch.reconciliation[0].status).toBe("amount_mismatch");
    expect(vatMismatch.reconciliation[0].status).toBe("vat_mismatch");
  });
});

function transaction(overrides: Partial<NormalizedTransaction>): NormalizedTransaction {
  return {
    transaction_type: "removal",
    source_file: "removals.csv",
    row_number: 1,
    raw: [],
    sage_transaction_type: "SI",
    account_ref: "",
    nominal_code: "4010",
    department: "",
    date: "2026-05-26",
    reference: "RM inv no." + (overrides.invoice_number ?? "4632"),
    invoice_number: "4632",
    description: "Removal",
    amount: 100,
    tax_code: "T1",
    vat_amount: 20,
    warnings: [],
    ...overrides,
  };
}

function pdfRow(overrides: Partial<MonthlyInvoiceReportRow>): MonthlyInvoiceReportRow {
  return {
    invoice_number: "4632",
    date: "2026-05-26",
    service_type: "removal",
    customer_name: "Andrew Smith Ltd",
    vat_amount: 20,
    invoice_total: 120,
    paid_status: "paid",
    raw_text: "",
    excluded: false,
    warnings: [],
    ...overrides,
  };
}
