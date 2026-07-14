import { describe, expect, it } from "vitest";
import {
  activeReferenceEntries,
  contactMatchStatus,
  parseSageContactItems,
  parseSageReferenceItems,
  readinessForInvoice,
  type ReadinessContext,
  type ReadinessInput,
} from "./sageMappings";

describe("contact matching", () => {
  it("marks multiple possible contact matches as ambiguous", () => {
    const matches = parseSageContactItems({
      $items: [
        { id: "1", displayed_as: "A Smith Removals" },
        { id: "2", displayed_as: "A Smith Storage" },
      ],
    });

    expect(contactMatchStatus("a smith", matches)).toBe("ambiguous");
  });
});

describe("readinessForInvoice", () => {
  it("reports missing mappings before a row can become Sage-ready", () => {
    expect(readinessForInvoice(invoice(), emptyContext())).toBe("missing_contact_mapping");
    expect(readinessForInvoice(invoice(), contextWithContact())).toBe("missing_tax_mapping");
    expect(readinessForInvoice(invoice(), contextWithContactAndTax())).toBe("missing_ledger_mapping");
  });

  it("uses confirmed mappings across import batches", () => {
    expect(readinessForInvoice(invoice({ source_invoice_id: "batch-2-row-1" }), fullContext())).toBe("ready_for_sage");
  });

  it("never makes storage invoices Sage-ready", () => {
    expect(readinessForInvoice(invoice({
      classification: "exclude_storage",
      warnings: ["Storage-related text found."],
    }), fullContext())).toBe("blocked_by_warning");
  });

  it("blocks rows that were already imported", () => {
    expect(readinessForInvoice(invoice({ source_invoice_id: "already-imported" }), fullContext())).toBe("already_imported");
  });
});

describe("reference parsing", () => {
  it("keeps inactive Sage reference entries but filters them for selection", () => {
    const entries = parseSageReferenceItems({
      $items: [
        { id: "active", code: "4000", displayed_as: "Sales", active: true },
        { id: "inactive", code: "9999", displayed_as: "Old Sales", active: false },
      ],
    }, "ledger_account");

    expect(entries).toHaveLength(2);
    expect(activeReferenceEntries(entries).map((entry) => entry.sage_entity_id)).toEqual(["active"]);
  });
});

function invoice(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    transaction_type: "removal",
    customer_name: "Acme Ltd",
    tax_code: "T1",
    nominal_code: "4010",
    classification: "import_candidate",
    review_decision: "include",
    warnings: [],
    pdf_match_status: "matched",
    source_invoice_id: "source-1",
    ...overrides,
  };
}

function emptyContext(): ReadinessContext {
  return {
    customerMappings: [],
    taxMappings: [],
    ledgerMappings: [],
    importedSourceInvoiceIds: new Set(),
  };
}

function contextWithContact(): ReadinessContext {
  return {
    ...emptyContext(),
    customerMappings: [{
      normalized_customer_name: "acme ltd",
      customer_email: null,
      postcode: null,
      sage_contact_id: "contact-1",
      sage_contact_display_name: "Acme Ltd",
      manually_confirmed: true,
    }],
  };
}

function contextWithContactAndTax(): ReadinessContext {
  return {
    ...contextWithContact(),
    taxMappings: [{
      mapping_type: "tax_rate",
      source_code: "T1",
      source_context: "",
      sage_entity_id: "tax-1",
      sage_display_name: "VAT 20%",
      manually_confirmed: true,
    }],
  };
}

function fullContext(): ReadinessContext {
  return {
    ...contextWithContactAndTax(),
    ledgerMappings: [{
      mapping_type: "ledger_account",
      source_code: "4010",
      source_context: "removal",
      sage_entity_id: "ledger-1",
      sage_display_name: "Removal sales",
      manually_confirmed: true,
    }],
    importedSourceInvoiceIds: new Set(["already-imported"]),
  };
}
