import { normalizeDate, parseMoney } from "./removalsParser";
import type { MonthlyInvoiceReportRow } from "./monthlyReportParser";

export const maxPastedReportLength = 1_000_000;

export class PastedReportError extends Error {}

const reportColumns = ["date", "systeminvno", "invoiceno", "customername", "jobid", "invoicetype", "amt", "status"];
const moneyNumber = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2}";
const moneyPattern = new RegExp("^(?:[£Ł]?\\s*-?\\s*" + moneyNumber + "|-\\s*[£Ł]\\s*" + moneyNumber + "|\\(\\s*[£Ł]?\\s*" + moneyNumber + "\\s*\\))$");

/** Read the browser-copied table, preserving blank invoice-number cells. */
export function parsePastedMonthlyReport(text: string): MonthlyInvoiceReportRow[] {
  if (text.length > maxPastedReportLength) {
    throw new PastedReportError("The pasted report is too large. Paste one monthly report at a time.");
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
  const columnsFor = (line: string) => line.split("\t").map(cell => cell.replace(/\u00a0/g, " ").trim());
  const isHeader = (cells: string[]) => cells.length === reportColumns.length && cells.every((cell, index) => cell.toLowerCase().replace(/[^a-z0-9]/g, "") === reportColumns[index]);
  const headerIndex = lines.findIndex(line => isHeader(columnsFor(line)));
  if (headerIndex === -1) {
    throw new PastedReportError("The report headings were not recognised. Copy the complete monthly invoice report table, including the Date and System inv no. headings, directly from its browser tab.");
  }
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const seen = new Set<string>();
  const rows: MonthlyInvoiceReportRow[] = [];
  for (const [index, line] of lines.slice(headerIndex + 1).entries()) {
    const cells = columnsFor(line);
    if (isHeader(cells)) continue;
    const fail = (message: string): never => {
      throw new PastedReportError(`Report row ${index + 1}: ${message} Copy the complete report again before checking.`);
    };
    if (cells.length !== reportColumns.length) fail("Expected all eight report columns, including empty cells.");
    const [dateText, invoiceNumber, , customer, , service, amountText, status] = cells;
    if (!/^\d+$/.test(invoiceNumber)) fail("The system invoice number is missing or invalid.");
    if (seen.has(invoiceNumber)) fail(`System invoice ${invoiceNumber} appears more than once.`);
    const expandedDate = dateText.replace(/\b[a-z]{3}\b/gi, short => months.find(month => month.toLowerCase().startsWith(short.toLowerCase())) ?? short);
    const date = normalizeDate(expandedDate);
    if (!date) fail("The invoice date is missing or invalid.");
    if (!customer || !service) fail("The customer name or invoice type is missing.");
    if (!moneyPattern.test(amountText)) fail("The invoice amount is missing or invalid.");
    const amount = parseMoney(amountText);
    if (amount === null) fail("The invoice amount is missing or invalid.");
    if (!/^(paid|unpaid|part paid|outstanding)$/i.test(status)) fail("The payment status is missing or invalid.");
    seen.add(invoiceNumber);
    rows.push({
      invoice_number: invoiceNumber,
      date,
      customer_name: customer,
      service_type: service.toLowerCase(),
      invoice_total: amount,
      vat_amount: null,
      paid_status: status.toLowerCase(),
      excluded: /\bstorage\b/i.test(service),
      raw_text: line,
      warnings: [],
    });
  }
  if (rows.length === 0) throw new PastedReportError("The pasted report has headings but no invoice rows. Copy the complete report table and try again.");
  return rows;
}

/** Standalone so the same function can be emitted into the browser bundle. */
export function monthlyReportTableText(rows: string[][]): string {
  return rows.map(row => row.map(cell => cell.replace(/[\t\r\n]+/g, " ").trim()).join("\t"))
    .filter(line => line.trim()).join("\n");
}
