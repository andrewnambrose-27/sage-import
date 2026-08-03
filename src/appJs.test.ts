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
    expect(appJs).toContain('draftCreateButton.disabled = count === 0 || busy || (previewValid && !draftConfirmCheckbox.checked)');
    expect(appJs).toContain('draftConfirmCheckbox.disabled = count === 0 || busy');
    expect(appJs).toContain("Tick the confirmation box before creating the selected drafts in Sage.");
    expect(appJs).toContain("should be created in Sage after the details check passes.");
    expect(appJs).toContain("activeDraftPreviews.every");
    expect(appJs).toContain('if (!draftPreviewMatchesSelection())');
    expect(appJs).toContain('" details to continue"');
  });

  it("offers to refresh older saved customer details before draft creation", () => {
    expect(appJs).toContain("Refresh saved batch details");
    expect(appJs).toContain("review_refresh_required");
    expect(appJs).toContain("Customer and review details were refreshed from this upload.");
  });

  it("defaults to a remembered GBP display currency without converting values", () => {
    expect(appJs).toContain('document.querySelector("#currencySelector")');
    expect(appJs).toContain('window.localStorage.getItem("sage_import_display_currency")');
    expect(appJs).toContain('return supportedDisplayCurrencies.has(saved) ? saved : "GBP"');
    expect(appJs).toContain('new Intl.NumberFormat("en-GB"');
  });

  it("keeps the customer list compact until the user expands it", () => {
    expect(appJs).toContain('document.querySelector("#toggleCustomerMappingsButton")');
    expect(appJs).toContain("customerCount > 5");
    expect(appJs).toContain('"Show 5 contacts" : "Expand all contacts"');
    expect(appJs).toContain('classList.toggle("customer-list-collapsed"');
  });

  it("reports the file check outcome on the Check files button", () => {
    expect(appJs).toContain('setCheckButtonState("checking")');
    expect(appJs).toContain('"Files checked successfully"');
    expect(appJs).toContain('"Files checked - review needed"');
  });
});
