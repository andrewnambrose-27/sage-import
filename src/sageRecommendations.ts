import type { SageReferenceEntry } from "./sageMappings";

export type RecommendationStatus = "exact_code_match" | "suggested_by_source_code" | "multiple_possible_matches" | "manual_choice_required";

export interface SageRecommendation {
  status: RecommendationStatus;
  candidate: SageReferenceEntry | null;
  message: string;
}

export function recommendLedgerAccount(
  sourceCode: unknown,
  transactionType: string,
  entries: SageReferenceEntry[],
  sourceDescription = "",
): SageRecommendation {
  const code = normaliseCode(sourceCode);
  const exactCodes = entries.filter((entry) => normaliseCode(entry.source_code) === code);
  if (exactCodes.length === 1) {
    return { status: "exact_code_match", candidate: exactCodes[0], message: "Exact code match" };
  }
  if (exactCodes.length > 1) {
    return { status: "multiple_possible_matches", candidate: null, message: "Multiple Sage categories use this code. Choose the correct one." };
  }

  const description = normaliseText(sourceDescription);
  const exactNames = description
    ? entries.filter((entry) => normaliseText(entry.sage_display_name) === description || normaliseText(rawString(entry, "name")) === description)
    : [];
  if (exactNames.length === 1) {
    return { status: "suggested_by_source_code", candidate: exactNames[0], message: "Suggested by source description" };
  }
  if (exactNames.length > 1) {
    return { status: "multiple_possible_matches", candidate: null, message: "Several Sage categories have this name. Choose the correct one." };
  }

  const compatible = entries.filter((entry) => isCompatible(transactionType, entry));
  if (compatible.length === 1) {
    return { status: "suggested_by_source_code", candidate: compatible[0], message: "Suggested by transaction type" };
  }

  return { status: "manual_choice_required", candidate: null, message: "Manual choice required" };
}

export function recommendVatRate(sourceCode: unknown, entries: SageReferenceEntry[]): SageRecommendation {
  if (normaliseCode(sourceCode).toUpperCase() !== "T9") {
    return { status: "manual_choice_required", candidate: null, message: "Manual choice required" };
  }

  const activeSalesEntries = entries.filter((entry) => entry.is_active && salesCompatible(entry));
  const namedCandidates = activeSalesEntries.filter((entry) => /(no\s*vat|not\s*applicable|outside\s*scope)/i.test(vatText(entry)));
  if (namedCandidates.length === 1) {
    return { status: "suggested_by_source_code", candidate: namedCandidates[0], message: "Suggested by source code" };
  }
  if (namedCandidates.length > 1) {
    return { status: "multiple_possible_matches", candidate: null, message: "Several 0% VAT options are available. Please choose the correct accounting treatment." };
  }

  const zeroRates = activeSalesEntries.filter((entry) => percentage(entry) === 0);
  if (zeroRates.length > 1) {
    return { status: "multiple_possible_matches", candidate: null, message: "Several 0% VAT options are available. Please choose the correct accounting treatment." };
  }

  return { status: "manual_choice_required", candidate: null, message: "Manual choice required" };
}

export function normaliseCode(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function normaliseText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function rawString(entry: SageReferenceEntry, key: string): string {
  return typeof entry.raw[key] === "string" ? entry.raw[key] : "";
}

function isCompatible(transactionType: string, entry: SageReferenceEntry): boolean {
  const type = `${rawString(entry, "accountType")} ${rawString(entry, "account_type")} ${rawString(entry, "ledger_account_type")}`.toLowerCase();
  const group = `${rawString(entry, "accountGroup")} ${rawString(entry, "account_group")} ${rawString(entry, "ledger_account_group")}`.toLowerCase();
  return ["removal", "deposit", "ad_hoc", "credit_note"].includes(transactionType) && /(sales|income|revenue)/.test(`${type} ${group}`);
}

function salesCompatible(entry: SageReferenceEntry): boolean {
  const value = entry.raw.usableForSales ?? entry.raw.usable_for_sales ?? entry.raw.sales_usable;
  return value !== false;
}

function vatText(entry: SageReferenceEntry): string {
  return `${entry.sage_display_name} ${rawString(entry, "name")} ${rawString(entry, "description")}`;
}

function percentage(entry: SageReferenceEntry): number | null {
  for (const key of ["percentage", "rate", "tax_rate_percentage"]) {
    const value = typeof entry.raw[key] === "number" ? entry.raw[key] : Number(entry.raw[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}
