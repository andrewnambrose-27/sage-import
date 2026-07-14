import { describe, expect, it } from "vitest";
import { parseMonthlyInvoiceReportText } from "./monthlyReportParser";

describe("parseMonthlyInvoiceReportText", () => {
  it("extracts invoice summary fields from monthly report text", () => {
    const rows = parseMonthlyInvoiceReportText(`
      4632 Paid 26/05/2026 Removal Andrew Smith Ltd 0.00 3615.53
      RM invoice 4557 unpaid 30/04/2026 Packing Jones Family \u00A370.00 \u00A3420.00
    `);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      invoice_number: "4632",
      paid_status: "paid",
      date: "2026-05-26",
      service_type: "removal",
      customer_name: "Andrew Smith Ltd",
      vat_amount: 0,
      invoice_total: 3615.53,
      excluded: false,
    });
    expect(rows[1]).toMatchObject({
      invoice_number: "4557",
      paid_status: "unpaid",
      date: "2026-04-30",
      service_type: "packing",
      customer_name: "Jones Family",
      vat_amount: 70,
      invoice_total: 420,
    });
  });

  it("keeps storage report rows but marks them as excluded", () => {
    const rows = parseMonthlyInvoiceReportText("5001 Paid 01/06/2026 Storage Customer Store Ltd 20.00 120.00");

    expect(rows).toHaveLength(1);
    expect(rows[0].excluded).toBe(true);
    expect(rows[0].customer_name).toBe("Customer Store Ltd");
  });

  it("adds warnings for incomplete PDF rows", () => {
    const rows = parseMonthlyInvoiceReportText("7001 Removal");

    expect(rows).toHaveLength(1);
    expect(rows[0].warnings).toEqual([
      "Missing or invalid PDF date.",
      "Missing or invalid PDF VAT.",
      "Missing or invalid PDF invoice total.",
      "Missing PDF customer name.",
    ]);
  });
});
