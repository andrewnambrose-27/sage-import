import { describe, expect, it } from "vitest";
import { recommendLedgerAccount, recommendVatRate } from "./sageRecommendations";
import type { SageReferenceEntry, SageReferenceMapping } from "./sageMappings";

const ledger4010 = reference("ledger-4010", "ledger_account", "4010", "Sales - Services", { accountType: "Sales", accountGroup: "Income" });
const noVat = reference("vat-none", "tax_rate", null, "No VAT", { name: "No VAT", percentage: 0, usableForSales: true });

describe("ledger recommendations", () => {
  it("suggests an exact 4010 match", () => {
    expect(recommendLedgerAccount("4010", "deposit", [ledger4010])).toMatchObject({ status: "exact_code_match", candidate: { sage_entity_id: "ledger-4010" } });
  });

  it("matches numeric codes and ignores surrounding whitespace", () => {
    expect(recommendLedgerAccount(4010, "removal", [ledger4010]).candidate?.sage_entity_id).toBe("ledger-4010");
    expect(recommendLedgerAccount(" 4010 ", "removal", [ledger4010]).candidate?.sage_entity_id).toBe("ledger-4010");
  });

  it("requires a manual choice when no exact or clear compatible match exists", () => {
    expect(recommendLedgerAccount("4999", "removal", [reference("bank", "ledger_account", "1200", "Bank", {})])).toMatchObject({ status: "manual_choice_required", candidate: null });
  });

  it("does not choose among multiple exact name matches", () => {
    const entries = [reference("a", "ledger_account", "4000", "Sales", {}), reference("b", "ledger_account", "4001", "Sales", {})];
    expect(recommendLedgerAccount("9999", "removal", entries, "Sales").status).toBe("multiple_possible_matches");
  });
});

describe("VAT recommendations", () => {
  it("offers one clear No VAT rate for T9", () => {
    expect(recommendVatRate("T9", [noVat])).toMatchObject({ status: "suggested_by_source_code", candidate: { sage_entity_id: "vat-none" } });
  });

  it("does not choose when several 0% candidates exist", () => {
    expect(recommendVatRate("T9", [noVat, reference("vat-exempt", "tax_rate", null, "Exempt", { percentage: 0, usableForSales: true })]).status).toBe("suggested_by_source_code");
    expect(recommendVatRate("T9", [noVat, reference("vat-outside", "tax_rate", null, "Outside scope", { percentage: 0, usableForSales: true })]).status).toBe("multiple_possible_matches");
  });

  it("requires a manual choice when Sage has no clear No VAT candidate", () => {
    expect(recommendVatRate("T9", [reference("vat-standard", "tax_rate", null, "Standard rate", { percentage: 20 })]).status).toBe("manual_choice_required");
  });
});

describe("saved mappings", () => {
  it("retains the genuine Sage entity ID used for restoration", () => {
    const mapping: SageReferenceMapping = { sage_business_id: "business-1", mapping_type: "ledger_account", source_code: "4010", source_context: "deposit", sage_entity_id: "ledger-4010", sage_display_name: "4010 - Sales - Services", manually_confirmed: true };
    expect(mapping.sage_entity_id).toBe("ledger-4010");
  });
});

function reference(id: string, reference_type: "tax_rate" | "ledger_account", source_code: string | null, sage_display_name: string, raw: Record<string, unknown>): SageReferenceEntry {
  return { reference_type, sage_entity_id: id, source_code, sage_display_name, is_active: true, raw };
}
