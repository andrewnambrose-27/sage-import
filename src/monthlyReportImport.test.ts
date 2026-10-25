import { describe, expect, it } from "vitest";
import { onRequest } from "../functions/[[path]]";
import type { NormalizedTransaction } from "./removalsParser";
import type { ReconciliationRow } from "./reconciliation";
import type { CustomerListResult } from "./customerList";

const report = "Date\tSystem inv no.\tInvoice no.\tCustomer name\tJobID\tInvoice type\tAmt\tStatus\n01 Oct 2026\t4974\t7001000\tExample Customer\t4176\tRemoval\t£690.00\tPAID";

function context(request: Request): Parameters<typeof onRequest>[0] {
  return {
    // Node's synthetic Request has no incoming Cloudflare metadata; this handler does not use it.
    request: request as Parameters<typeof onRequest>[0]["request"], functionPath: "/", params: {}, data: {},
    env: { APP_ACCESS_PASSWORD: "monthly-report-test", ASSETS: { fetch } },
    waitUntil() {}, passThroughOnException() {},
    next: async () => new Response("Not found", { status: 404 }),
  };
}

async function checkReport(fields: Record<string, string>, csv = "SI,EXAMPLE,4010,,01/10/2026,RM inv no.4974,Removal,575.00,T1,115.00", customerCsv?: string) {
  const login = await onRequest(context(new Request("https://example.test/login", {
    method: "POST", body: new URLSearchParams({ password: "monthly-report-test" }),
  })));
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (csv) form.set("removalInvoices", new File([csv], "example.csv", { type: "text/csv" }));
  if (customerCsv !== undefined) form.set("customerList", new File([customerCsv], "customers.csv", { type: "text/csv" }));
  const response = await onRequest(context(new Request("https://example.test/api/parse-csv", {
    method: "POST", headers: { Cookie: cookie }, body: form,
  })));
  const data = await response.json() as {
    error?: string;
    field?: string;
    customer_list: CustomerListResult | null;
    report_summary: { source: string; total_rows: number; excluded_storage_rows: number; vat_checked: boolean };
    rows: NormalizedTransaction[];
    reconciliation: ReconciliationRow[];
  };
  return { response, data };
}

describe("monthly report import endpoint", () => {
  it("checks a customer CSV on its own without producing invoice rows or reconciliation entries", async () => {
    const result = await checkReport({}, "", "JobID,Customer,Tel,Mobile,Email,Address,,,\n1300,Example Customer,01150000000,07400000000,example@example.test,Example address,,,\n2279,,,,,,,,");
    expect(result.response.status).toBe(200);
    expect(result.data.customer_list?.customers).toHaveLength(1);
    expect(result.data.customer_list?.skipped_empty_rows).toBe(1);
    expect(result.data.customer_list?.customers[0].mobile).toBe("07400000000");
    expect(result.data.rows).toEqual([]);
    expect(result.data.reconciliation).toEqual([]);
  });

  it("keeps customer reference rows separate from invoice rows when all files are checked together", async () => {
    const result = await checkReport({ pastedMonthlyReport: report }, undefined, "JobID,Customer,Tel,Mobile,Email,Address,,,\n1300,Different Customer,,,,Example address,,,");
    expect(result.response.status).toBe(200);
    expect(result.data.rows).toHaveLength(1);
    expect(result.data.rows[0].customer_name).toBe("Example Customer");
    expect(result.data.reconciliation[0].status).toBe("matched");
    expect(result.data.customer_list?.customers[0].customer_name).toBe("Different Customer");
  });

  it("identifies malformed customer uploads without blaming the monthly report", async () => {
    const result = await checkReport({}, "", "not,a,customer,list");
    expect(result.response.status).toBe(400);
    expect(result.data.field).toBe("customerList");
    expect(result.data.error).toContain("column headings");
  });

  it("enriches the CSV from a pasted report and checks gross while retaining CSV VAT", async () => {
    const { response, data } = await checkReport({ pastedMonthlyReport: report });
    expect(response.status).toBe(200);
    expect(data.report_summary).toEqual({ source: "paste", total_rows: 1, excluded_storage_rows: 0, vat_checked: false });
    expect(data.rows[0]).toMatchObject({ invoice_number: "4974", customer_name: "Example Customer", vat_amount: 115, classification: "import_candidate" });
    expect(data.reconciliation[0]).toMatchObject({ status: "matched", pdf_amount: 690, pdf_vat: null, vat_checked: false });
  });

  it("can validate a pasted report before the CSV is selected", async () => {
    const { response, data } = await checkReport({ pastedMonthlyReport: report }, "");
    expect(response.status).toBe(200);
    expect(data.report_summary.total_rows).toBe(1);
    expect(data.rows).toEqual([]);
  });

  it("returns a useful validation error instead of accepting incomplete copied data", async () => {
    const { response, data } = await checkReport({ pastedMonthlyReport: report.replace("\t7001000", "") });
    expect(response.status).toBe(400);
    expect(data.error).toContain("eight report columns");
  });

  it("rejects competing monthly sources and keeps the PDF path's VAT check", async () => {
    const conflict = await checkReport({ pastedMonthlyReport: report, monthlyReportText: "4974 PAID 01/10/2026 Removal Example Customer 115.00 690.00" });
    expect(conflict.response.status).toBe(400);
    expect(conflict.data.error).toContain("one monthly report source");
    const pdf = await checkReport({ monthlyReportText: "4974 PAID 01/10/2026 Removal Example Customer 100.00 690.00" });
    expect(pdf.response.status).toBe(200);
    expect(pdf.data.report_summary.source).toBe("pdf");
    expect(pdf.data.reconciliation[0]).toMatchObject({ status: "vat_mismatch", vat_checked: true });
  });
});
