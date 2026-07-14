import type { TransactionClassification, TransactionType } from "./removalsParser";

export interface ClassificationRuleConfig {
  storageTerms: string[];
  removalTerms: string[];
  depositTerms: string[];
  creditTerms: string[];
  multiInvoiceWarningPatterns: RegExp[];
  storageCreditTerms: string[];
  finalInvoiceTypes: TransactionType[];
  classificationPriority: TransactionClassification[];
}

export const classificationConfig: ClassificationRuleConfig = {
  storageTerms: ["storage", "store", "container storage", "monthly storage"],
  removalTerms: ["removal", "removals", "move", "moving", "mileage", "packing"],
  depositTerms: ["deposit", "part payment", "advance payment"],
  creditTerms: ["credit", "refund", "credit note"],
  storageCreditTerms: ["storage credit", "storage refund", "storage rebate", "storage adjustment"],
  multiInvoiceWarningPatterns: [
    /\bmultiple invoices?\b/i,
    /\bcombined invoices?\b/i,
    /\bseveral invoices?\b/i,
    /\binvoices?\s+\d+\s*(?:,|and|&)\s*\d+/i,
    /\bstorage.*(?:removal|invoice|refund)|(?:removal|invoice|refund).*storage/i,
  ],
  finalInvoiceTypes: ["removal", "ad_hoc"],
  classificationPriority: [
    "exclude_storage",
    "possible_storage_credit",
    "amount_mismatch",
    "vat_mismatch",
    "possible_duplicate",
    "missing_customer",
    "needs_review",
    "import_candidate",
  ],
};
