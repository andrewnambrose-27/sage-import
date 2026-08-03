import { describe, expect, it } from "vitest";
import { appJs } from "../functions/[[path]]";

describe("embedded browser application", () => {
  it("is valid JavaScript after being emitted by the Pages Function", () => {
    expect(() => new Function(appJs)).not.toThrow();
  });

  it("includes the bulk Sage draft workflow", () => {
    expect(appJs).toContain("previewSelectedDraftInvoices");
    expect(appJs).toContain("createSelectedDraftInvoices");
    expect(appJs).toContain('document.querySelector("#draftBatchActions")');
    expect(appJs).toContain("Select at least one Sage-ready invoice first.");
  });

  it("defaults to a remembered GBP display currency without converting values", () => {
    expect(appJs).toContain('document.querySelector("#currencySelector")');
    expect(appJs).toContain('window.localStorage.getItem("sage_import_display_currency")');
    expect(appJs).toContain('return supportedDisplayCurrencies.has(saved) ? saved : "GBP"');
    expect(appJs).toContain('new Intl.NumberFormat("en-GB"');
  });
});
