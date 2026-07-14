import { classificationConfig, type ClassificationRuleConfig } from "./classificationConfig";
import type { ReconciliationRow } from "./reconciliation";
import type {
  NormalizedTransaction,
  TransactionClassification,
} from "./removalsParser";

export interface ClassificationSummary {
  total_rows_uploaded: number;
  import_candidates: number;
  excluded_storage_rows: number;
  needs_review_rows: number;
  duplicate_warnings: number;
  total_import_candidate_value: number;
  total_excluded_value: number;
}

export interface ClassificationResult {
  transactions: NormalizedTransaction[];
  summary: ClassificationSummary;
}

export function classifyTransactions(
  transactions: NormalizedTransaction[],
  reconciliation: ReconciliationRow[] = [],
  config: ClassificationRuleConfig = classificationConfig,
): ClassificationResult {
  const reconciliationByInvoice = new Map(reconciliation.map((row) => [row.invoice_number, row]));
  const duplicateKeys = findDuplicateKeys(transactions);
  const overlapKeys = findDepositFinalOverlapKeys(transactions, config);

  const classified = transactions.map((transaction) => {
    const text = searchableText(transaction);
    const reconciliationRow = transaction.invoice_number ? reconciliationByInvoice.get(transaction.invoice_number) : undefined;
    const reasons: string[] = [];
    const candidates = new Set<TransactionClassification>();
    const storageRelated = containsAny(text, config.storageTerms);
    const storageCreditRelated = transaction.transaction_type === "credit_note" && (
      storageRelated ||
      containsAny(text, config.storageCreditTerms)
    );

    if (storageCreditRelated) {
      candidates.add("possible_storage_credit");
      reasons.push("Storage-related credit or refund needs manual review.");
    } else if (storageRelated) {
      candidates.add("exclude_storage");
      reasons.push("Storage-related text found.");
    }

    if (reconciliationRow?.status === "amount_mismatch") {
      candidates.add("amount_mismatch");
      reasons.push("CSV amount does not match the monthly PDF report.");
    }

    if (reconciliationRow?.status === "vat_mismatch") {
      candidates.add("vat_mismatch");
      reasons.push("CSV VAT does not match the monthly PDF report.");
    }

    if (transaction.warnings.length > 0 || reconciliationRow?.status === "needs_review") {
      candidates.add("needs_review");
      reasons.push("Existing row warnings need review.");
    }

    if (!transaction.customer_name) {
      candidates.add("missing_customer");
      reasons.push("No customer name matched from the monthly PDF report.");
    }

    if (transaction.transaction_type === "deposit") {
      candidates.add("needs_review");
      reasons.push("Deposit rows should be checked carefully before import.");
    }

    if (transaction.transaction_type === "credit_note") {
      candidates.add("needs_review");
      reasons.push("Credit notes may be import candidates but need review.");
    }

    if (duplicateKeys.has(rowKey(transaction)) || overlapKeys.has(rowKey(transaction))) {
      candidates.add("possible_duplicate");
      reasons.push("Possible duplicate or deposit/final invoice overlap.");
    }

    if (appearsToCombineMultipleInvoices(transaction, config)) {
      candidates.add("needs_review");
      reasons.push("Amount may include more than one invoice or a storage amount.");
    }

    if (candidates.size === 0 && isImportCandidate(transaction, text, config)) {
      candidates.add("import_candidate");
      reasons.push("Normal invoice row appears importable.");
    }

    if (candidates.size === 0) {
      candidates.add("needs_review");
      reasons.push("Transaction type or service is unclear.");
    }

    const classification = chooseClassification(candidates, config);
    const classificationReasons = [...new Set(reasons)];

    return {
      ...transaction,
      classification,
      classification_reasons: classificationReasons,
      export_allowed_by_default: classification === "import_candidate",
      warnings: mergeWarnings(transaction.warnings, classificationReasons),
    };
  });

  return {
    transactions: classified,
    summary: buildSummary(classified),
  };
}

function isImportCandidate(
  transaction: NormalizedTransaction,
  text: string,
  config: ClassificationRuleConfig,
): boolean {
  if (transaction.transaction_type === "ad_hoc") {
    return true;
  }

  if (transaction.transaction_type === "removal") {
    return containsAny(text, config.removalTerms) || transaction.transaction_type === "removal";
  }

  return false;
}

function appearsToCombineMultipleInvoices(
  transaction: NormalizedTransaction,
  config: ClassificationRuleConfig,
): boolean {
  const text = searchableText(transaction);
  const invoiceReferences = new Set(text.match(/\binv(?:oice)?\s*(?:no\.?|number|#)?\s*\d+\b/g) ?? []);

  return (
    invoiceReferences.size > 1 ||
    config.multiInvoiceWarningPatterns.some((pattern) => pattern.test(text))
  );
}

function findDuplicateKeys(transactions: NormalizedTransaction[]): Set<string> {
  const counts = new Map<string, number>();

  for (const transaction of transactions) {
    const key = rowKey(transaction);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}

function findDepositFinalOverlapKeys(
  transactions: NormalizedTransaction[],
  config: ClassificationRuleConfig,
): Set<string> {
  const keys = new Set<string>();
  const deposits = transactions.filter((row) => row.transaction_type === "deposit");
  const finals = transactions.filter((row) => config.finalInvoiceTypes.includes(row.transaction_type));

  for (const deposit of deposits) {
    for (const finalInvoice of finals) {
      if (overlaps(deposit, finalInvoice)) {
        keys.add(rowKey(deposit));
        keys.add(rowKey(finalInvoice));
      }
    }
  }

  return keys;
}

function overlaps(left: NormalizedTransaction, right: NormalizedTransaction): boolean {
  if (left.invoice_number && right.invoice_number && left.invoice_number === right.invoice_number) {
    return true;
  }

  if (left.customer_name && right.customer_name && left.customer_name.toLowerCase() === right.customer_name.toLowerCase()) {
    return true;
  }

  return false;
}

function chooseClassification(
  candidates: Set<TransactionClassification>,
  config: ClassificationRuleConfig,
): TransactionClassification {
  return config.classificationPriority.find((classification) => candidates.has(classification)) ?? "needs_review";
}

function buildSummary(transactions: NormalizedTransaction[]): ClassificationSummary {
  return {
    total_rows_uploaded: transactions.length,
    import_candidates: transactions.filter((row) => row.classification === "import_candidate").length,
    excluded_storage_rows: transactions.filter((row) => row.classification === "exclude_storage").length,
    needs_review_rows: transactions.filter((row) => row.classification !== "import_candidate" && row.classification !== "exclude_storage").length,
    duplicate_warnings: transactions.filter((row) => row.classification === "possible_duplicate").length,
    total_import_candidate_value: sumByClassification(transactions, "import_candidate"),
    total_excluded_value: sumByClassification(transactions, "exclude_storage"),
  };
}

function sumByClassification(
  transactions: NormalizedTransaction[],
  classification: TransactionClassification,
): number {
  const total = transactions
    .filter((row) => row.classification === classification)
    .reduce((sum, row) => sum + (row.amount ?? 0) + (row.vat_amount ?? 0), 0);

  return Math.round(total * 100) / 100;
}

function searchableText(transaction: NormalizedTransaction): string {
  return [
    transaction.description,
    transaction.service_type,
    transaction.reference,
    transaction.source_file,
    transaction.raw.join(" "),
  ].filter(Boolean).join(" ").toLowerCase();
}

function rowKey(transaction: NormalizedTransaction): string {
  return [
    transaction.invoice_number ?? "",
    transaction.customer_name?.toLowerCase() ?? "",
    transaction.transaction_type,
    transaction.amount ?? "",
    transaction.vat_amount ?? "",
    transaction.description.toLowerCase(),
  ].join("|");
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term.toLowerCase()));
}

function mergeWarnings(existing: string[], additions: string[]): string[] {
  return [...new Set([...existing, ...additions])];
}
