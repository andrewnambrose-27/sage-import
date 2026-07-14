import { extractInvoiceNumber, normalizeDate, parseMoney } from "./removalsParser";

export interface MonthlyInvoiceReportRow {
  invoice_number: string;
  date: string | null;
  service_type: string;
  customer_name: string;
  vat_amount: number | null;
  invoice_total: number | null;
  paid_status: string | null;
  raw_text: string;
  excluded: boolean;
  warnings: string[];
}

const serviceWords = [
  "removal",
  "removals",
  "packing",
  "packaging",
  "mileage",
  "storage",
  "ad hoc",
  "adhoc",
  "credit note",
  "invoice",
];

export function parseMonthlyInvoiceReportText(text: string): MonthlyInvoiceReportRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map(parseMonthlyReportLine)
    .filter((row): row is MonthlyInvoiceReportRow => row !== null);
}

export function parseMonthlyReportLine(line: string): MonthlyInvoiceReportRow | null {
  const invoiceNumber = extractInvoiceNumber(line) ?? line.match(/\b\d{3,}\b/)?.[0] ?? null;

  if (!invoiceNumber) {
    return null;
  }

  const dateText = line.match(/\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4})\b/)?.[0] ?? "";
  const date = normalizeDate(dateText);
  const moneyTexts = line.match(/(?:\u00A3\s*)?-?\d[\d,]*\.\d{2}|\(\s*\u00A3?\s*\d[\d,]*\.\d{2}\s*\)/g) ?? [];
  const moneyValues = moneyTexts.map(parseMoney).filter((value): value is number => value !== null);
  const paidStatus = extractPaidStatus(line);
  const warnings: string[] = [];

  const invoiceTotal = moneyValues.at(-1) ?? null;
  const vatAmount = moneyValues.length >= 2 ? moneyValues.at(-2) ?? null : null;

  if (!date) {
    warnings.push("Missing or invalid PDF date.");
  }

  if (vatAmount === null) {
    warnings.push("Missing or invalid PDF VAT.");
  }

  if (invoiceTotal === null) {
    warnings.push("Missing or invalid PDF invoice total.");
  }

  const { serviceType, customerName } = extractServiceAndCustomer(line, {
    invoiceNumber,
    dateText,
    moneyTexts,
    paidStatus,
  });

  if (!serviceType) {
    warnings.push("Missing PDF service type.");
  }

  if (!customerName) {
    warnings.push("Missing PDF customer name.");
  }

  const excluded = /\bstorage\b/i.test(serviceType) || /\bstorage\b/i.test(line);

  return {
    invoice_number: invoiceNumber,
    date,
    service_type: serviceType,
    customer_name: customerName,
    vat_amount: vatAmount,
    invoice_total: invoiceTotal,
    paid_status: paidStatus,
    raw_text: line,
    excluded,
    warnings,
  };
}

function extractPaidStatus(line: string): string | null {
  const match = line.match(/\b(part paid|unpaid|paid|outstanding)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function extractServiceAndCustomer(
  line: string,
  tokens: {
    invoiceNumber: string;
    dateText: string;
    moneyTexts: string[];
    paidStatus: string | null;
  },
): { serviceType: string; customerName: string } {
  let middle = line;
  middle = middle.replace(new RegExp("\\bRM\\s+inv(?:oice)?\\s*(?:no\\.?|number|#)?\\s*" + tokens.invoiceNumber + "\\b", "i"), " ");
  middle = middle.replace(new RegExp("\\binv(?:oice)?\\s*(?:no\\.?|number|#)?\\s*" + tokens.invoiceNumber + "\\b", "i"), " ");
  middle = middle.replace(new RegExp("\\b" + tokens.invoiceNumber + "\\b"), " ");

  if (tokens.dateText) {
    middle = middle.replace(tokens.dateText, " ");
  }

  for (const moneyText of tokens.moneyTexts) {
    middle = middle.replace(moneyText, " ");
  }

  if (tokens.paidStatus) {
    middle = middle.replace(new RegExp("\\b" + escapeRegExp(tokens.paidStatus) + "\\b", "i"), " ");
  }

  middle = middle.replace(/\b(?:invoice|total|vat|amount|date|paid|status|service)\b/gi, " ");
  middle = middle.replace(/\s+/g, " ").trim();

  const lower = middle.toLowerCase();
  const service = serviceWords.find((word) => lower.startsWith(word + " ") || lower === word);

  if (service) {
    return {
      serviceType: normaliseService(service),
      customerName: middle.slice(service.length).trim(),
    };
  }

  const embeddedService = serviceWords.find((word) => new RegExp("\\b" + escapeRegExp(word) + "\\b", "i").test(middle));
  if (embeddedService) {
    const parts = middle.split(new RegExp("\\b" + escapeRegExp(embeddedService) + "\\b", "i"));
    return {
      serviceType: normaliseService(embeddedService),
      customerName: parts.join(" ").replace(/\s+/g, " ").trim(),
    };
  }

  return {
    serviceType: "",
    customerName: middle,
  };
}

function normaliseService(service: string): string {
  if (service.toLowerCase() === "removals") {
    return "removal";
  }

  if (service.toLowerCase() === "adhoc") {
    return "ad hoc";
  }

  return service.toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
