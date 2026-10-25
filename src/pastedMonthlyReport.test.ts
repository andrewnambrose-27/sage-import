import { describe, expect, it } from "vitest";
import { maxPastedReportLength, monthlyReportTableText, parsePastedMonthlyReport } from "./pastedMonthlyReport";

const headings = "Date\tSystem inv no.\tInvoice no.\tCustomer name\tJobID\tInvoice type\tAmt\tStatus";
const row = "01 Oct 2026\t4974\t\tExample Customer Ltd\t4176\tRemoval\t£690.00\tPAID";
const report = (line = row) => `${headings}\n${line}`;

describe("pasted monthly invoice reports", () => {
  it("uses the system invoice number, preserves empty columns, and reads abbreviated dates", () => {
    const rows = parsePastedMonthlyReport(report() + "\n10 Aug 2026\t4817\t2638261\tOther Customer\t3986\tRemoval\t£908.88\tUNPAID");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ invoice_number: "4974", date: "2026-10-01", customer_name: "Example Customer Ltd", invoice_total: 690, vat_amount: null, warnings: [] });
    expect(rows[1]).toMatchObject({ invoice_number: "4817", date: "2026-08-10", customer_name: "Other Customer", paid_status: "unpaid" });
  });

  it("preserves negative ad hoc amounts, comma grouping and storage exclusion", () => {
    const rows = parsePastedMonthlyReport(report(row.replace("£690.00", "£-635.10").replace("Removal", "Ad hoc invoice")) + "\n09 Oct 2026\t5026\t7410261\tStorage Customer\t4085\tStorage\t£1,280.23\tUNPAID");
    expect(rows[0]).toMatchObject({ invoice_total: -635.1, service_type: "ad hoc invoice", excluded: false });
    expect(rows[1]).toMatchObject({ invoice_total: 1280.23, excluded: true });
  });

  it("accepts CRLF, full month names, repeated headings and nonbreaking spaces", () => {
    const text = '\uFEFFReport for October\r\n' + report(row.replace("Oct", "October").replace("Customer Ltd", "Customer\u00a0Ltd")) + '\r\n' + headings;
    expect(parsePastedMonthlyReport(text)).toHaveLength(1);
    expect(parsePastedMonthlyReport(text)[0].customer_name).toBe("Example Customer Ltd");
  });

  it.each([
    ["missing headings", row, "headings"],
    ["wrong column order", report().replace("System inv no.\tInvoice no.", "Invoice no.\tSystem inv no."), "headings"],
    ["empty table", headings, "no invoice rows"],
    ["truncated row", report(row.replace("\t\t", "\t")), "eight report columns"],
    ["invalid date", report(row.replace("01 Oct", "32 Oct")), "date"],
    ["invalid amount", report(row.replace("£690.00", "£6,90.00")), "amount"],
    ["missing system number", report(row.replace("4974", "")), "system invoice number"],
    ["missing customer", report(row.replace("Example Customer Ltd", "")), "customer"],
    ["missing status", report(row.replace("PAID", "")), "status"],
    ["duplicate invoice", report() + '\n' + row, "appears more than once"],
    ["oversized report", "x".repeat(maxPastedReportLength + 1), "too large"],
  ])("rejects %s instead of silently guessing or dropping invoices", (_name, text, message) => {
    expect(() => parsePastedMonthlyReport(text)).toThrow(message);
  });

  it("converts clipboard table cells to text without losing blank invoice columns", () => {
    const text = monthlyReportTableText([headings.split("\t"), row.replace("Example Customer Ltd", " Example\nCustomer Ltd ").split("\t")]);
    expect(text).toContain("4974\t\tExample Customer Ltd\t4176");
    expect(parsePastedMonthlyReport(text)[0].invoice_number).toBe("4974");
  });
});
