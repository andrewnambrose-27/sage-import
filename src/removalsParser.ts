export type TransactionType = "removal" | "deposit" | "ad_hoc" | "credit_note";

export interface NormalizedTransaction {
  transaction_type: TransactionType;
  source_file: string;
  row_number: number;
  raw: string[];
  sage_transaction_type: string;
  account_ref: string;
  nominal_code: string;
  department: string;
  date: string | null;
  reference: string;
  invoice_number: string | null;
  description: string;
  amount: number | null;
  tax_code: string;
  vat_amount: number | null;
  warnings: string[];
}

export interface ParseCsvOptions {
  transactionType: TransactionType;
  sourceFile: string;
}

const columns = {
  sageTransactionType: 0,
  accountRef: 1,
  nominalCode: 2,
  department: 3,
  date: 4,
  reference: 5,
  description: 6,
  amount: 7,
  taxCode: 8,
  vatAmount: 9,
};

export function parseRemovalsCsv(csvText: string, options: ParseCsvOptions): NormalizedTransaction[] {
  return parseCsvRows(csvText)
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row, index) => normalizeRow(row, index + 1, options));
}

export function normalizeRow(
  raw: string[],
  rowNumber: number,
  options: ParseCsvOptions,
): NormalizedTransaction {
  const reference = valueAt(raw, columns.reference);
  const description = valueAt(raw, columns.description);
  const date = normalizeDate(valueAt(raw, columns.date));
  const amount = parseMoney(valueAt(raw, columns.amount));
  const vatAmount = parseMoney(valueAt(raw, columns.vatAmount));
  const invoiceNumber = extractInvoiceNumber(reference);
  const warnings: string[] = [];

  if (raw.length < 10) {
    warnings.push("Unknown row format: expected at least 10 columns.");
  }

  if (!invoiceNumber) {
    warnings.push("Missing invoice number.");
  }

  if (!date) {
    warnings.push("Missing or invalid date.");
  }

  if (amount === null) {
    warnings.push("Invalid amount.");
  }

  if (vatAmount === null) {
    warnings.push("Invalid VAT.");
  }

  if (!description) {
    warnings.push("Missing description.");
  }

  return {
    transaction_type: options.transactionType,
    source_file: options.sourceFile,
    row_number: rowNumber,
    raw,
    sage_transaction_type: valueAt(raw, columns.sageTransactionType),
    account_ref: valueAt(raw, columns.accountRef),
    nominal_code: valueAt(raw, columns.nominalCode),
    department: valueAt(raw, columns.department),
    date,
    reference,
    invoice_number: invoiceNumber,
    description,
    amount,
    tax_code: valueAt(raw, columns.taxCode),
    vat_amount: vatAmount,
    warnings,
  };
}

export function extractInvoiceNumber(reference: string): string | null {
  const normalised = reference.trim();
  if (!normalised) {
    return null;
  }

  const patterns = [
    /\brm\s*inv(?:oice)?\s*(?:no\.?|number|#)?\s*(\d+)\b/i,
    /\binv(?:oice)?\s*(?:no\.?|number|#)?\s*(\d+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = normalised.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

export function normalizeDate(input: string): string | null {
  const value = input.trim();
  if (!value) {
    return null;
  }

  const isoMatch = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    return validIsoDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const ukMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ukMatch) {
    return validIsoDate(Number(ukMatch[3]), Number(ukMatch[2]), Number(ukMatch[1]));
  }

  return null;
}

export function parseMoney(input: string): number | null {
  const value = input.trim();
  if (!value) {
    return null;
  }

  const negative = /^\(.*\)$/.test(value);
  const cleaned = value.replace(/[£,\s()]/g, "");

  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) {
    return null;
  }

  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) {
    return null;
  }

  return negative ? -amount : amount;
}

export function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    const next = csvText[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

function valueAt(row: string[], index: number): string {
  return String(row[index] ?? "").trim();
}

function validIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}
