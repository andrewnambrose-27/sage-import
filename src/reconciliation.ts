import type { MonthlyInvoiceReportRow } from "./monthlyReportParser";
import type { NormalizedTransaction } from "./removalsParser";

export type ReconciliationStatus =
  | "matched"
  | "missing_from_csv"
  | "missing_from_pdf"
  | "amount_mismatch"
  | "vat_mismatch"
  | "needs_review";

export interface ReconciliationRow {
  vat_checked?: boolean;
  invoice_number: string;
  status: ReconciliationStatus;
  customer_name: string | null;
  service_type: string | null;
  csv_amount: number | null;
  pdf_amount: number | null;
  csv_vat: number | null;
  pdf_vat: number | null;
  warnings: string[];
}

export interface ReconciliationResult {
  transactions: NormalizedTransaction[];
  pdf_rows: MonthlyInvoiceReportRow[];
  reconciliation: ReconciliationRow[];
}

const moneyTolerance = 0.01;

export function reconcileTransactionsWithPdf(
  transactions: NormalizedTransaction[],
  pdfRows: MonthlyInvoiceReportRow[],
  options: { sourceLabel?: string; compareVat?: boolean } = {},
): ReconciliationResult {
  const sourceLabel = options.sourceLabel ?? "PDF";
  const reportName = sourceLabel === "PDF" ? "monthly PDF report" : "pasted monthly report";
  const compareVat = options.compareVat !== false;
  const activePdfRows = pdfRows.filter((row) => !row.excluded);
  const pdfByInvoice = new Map(activePdfRows.map((row) => [row.invoice_number, row]));
  const csvByInvoice = groupCsvRows(transactions);
  const reconciliation: ReconciliationRow[] = [];

  const enrichedTransactions = transactions.map((transaction) => {
    if (!transaction.invoice_number) {
      return {
        ...transaction,
        pdf_match_status: "needs_review",
        warnings: [...transaction.warnings, `Cannot match ${sourceLabel} row without an invoice number.`],
      };
    }

    const pdfRow = pdfByInvoice.get(transaction.invoice_number);
    if (!pdfRow) {
      return {
        ...transaction,
        pdf_match_status: "missing_from_pdf",
        warnings: [...transaction.warnings, sourceLabel === "PDF" ? "No matching monthly PDF row." : `No matching ${reportName} row.`],
      };
    }

    return {
      ...transaction,
      customer_name: pdfRow.customer_name || undefined,
      service_type: pdfRow.service_type || undefined,
      pdf_match_status: pdfRow.warnings.length > 0 ? "needs_review" : "matched",
      warnings: pdfRow.warnings.length > 0
        ? [...transaction.warnings, ...pdfRow.warnings.map((warning) => `${sourceLabel}: ${warning}`)]
        : transaction.warnings,
    };
  });

  for (const [invoiceNumber, csvRows] of csvByInvoice) {
    const pdfRow = pdfByInvoice.get(invoiceNumber);
    const csvAmount = sumInvoiceTotals(csvRows);
    const csvVat = sumValues(csvRows.map((row) => row.vat_amount));

    if (!pdfRow) {
      reconciliation.push({
        vat_checked: compareVat,
        invoice_number: invoiceNumber,
        status: "missing_from_pdf",
        customer_name: null,
        service_type: null,
        csv_amount: csvAmount,
        pdf_amount: null,
        csv_vat: csvVat,
        pdf_vat: null,
        warnings: [`CSV invoice was not found in the ${reportName}.`],
      });
      continue;
    }

    const warnings = [
      ...new Set([
        ...csvRows.flatMap((row) => row.warnings),
        ...pdfRow.warnings.map((warning) => `${sourceLabel}: ${warning}`),
      ]),
    ];

    const amountMismatch = !moneyMatches(csvAmount, pdfRow.invoice_total);
    const vatMismatch = compareVat && !moneyMatches(csvVat, pdfRow.vat_amount);
    if (amountMismatch) {
      warnings.push(`CSV amount does not match ${sourceLabel} invoice total.`);
    }
    if (vatMismatch) {
      warnings.push(`CSV VAT does not match ${sourceLabel} VAT.`);
    }

    reconciliation.push({
      vat_checked: compareVat,
      invoice_number: invoiceNumber,
      status: statusFor({ amountMismatch, vatMismatch, warnings }),
      customer_name: pdfRow.customer_name || null,
      service_type: pdfRow.service_type || null,
      csv_amount: csvAmount,
      pdf_amount: pdfRow.invoice_total,
      csv_vat: csvVat,
      pdf_vat: pdfRow.vat_amount,
      warnings,
    });
  }

  for (const pdfRow of activePdfRows) {
    if (csvByInvoice.has(pdfRow.invoice_number)) {
      continue;
    }

    reconciliation.push({
      vat_checked: compareVat,
      invoice_number: pdfRow.invoice_number,
      status: "missing_from_csv",
      customer_name: pdfRow.customer_name || null,
      service_type: pdfRow.service_type || null,
      csv_amount: null,
      pdf_amount: pdfRow.invoice_total,
      csv_vat: null,
      pdf_vat: pdfRow.vat_amount,
      warnings: [`${sourceLabel} invoice was not found in the uploaded CSV rows.`, ...pdfRow.warnings],
    });
  }

  return {
    transactions: enrichedTransactions,
    pdf_rows: activePdfRows,
    reconciliation,
  };
}

function groupCsvRows(transactions: NormalizedTransaction[]): Map<string, NormalizedTransaction[]> {
  const grouped = new Map<string, NormalizedTransaction[]>();

  for (const transaction of transactions) {
    if (!transaction.invoice_number) {
      continue;
    }

    const rows = grouped.get(transaction.invoice_number) ?? [];
    rows.push(transaction);
    grouped.set(transaction.invoice_number, rows);
  }

  return grouped;
}

function sumValues(values: Array<number | null>): number | null {
  if (values.some((value) => value === null)) {
    return null;
  }

  return roundMoney((values as number[]).reduce((total, value) => total + value, 0));
}

function sumInvoiceTotals(rows: NormalizedTransaction[]): number | null {
  if (rows.some((row) => row.amount === null || row.vat_amount === null)) {
    return null;
  }

  return roundMoney(rows.reduce((total, row) => total + Number(row.amount) + Number(row.vat_amount), 0));
}

function moneyMatches(left: number | null, right: number | null): boolean {
  if (left === null || right === null) {
    return false;
  }

  return Math.abs(left - right) <= moneyTolerance;
}

function statusFor(input: {
  amountMismatch: boolean;
  vatMismatch: boolean;
  warnings: string[];
}): ReconciliationStatus {
  if (input.amountMismatch) {
    return "amount_mismatch";
  }

  if (input.vatMismatch) {
    return "vat_mismatch";
  }

  if (input.warnings.length > 0) {
    return "needs_review";
  }

  return "matched";
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
