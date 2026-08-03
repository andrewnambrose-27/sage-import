import { describe, expect, it } from "vitest";
import { appJs } from "../functions/[[path]]";

describe("embedded browser application", () => {
  it("is valid JavaScript after being emitted by the Pages Function", () => {
    expect(() => new Function(appJs)).not.toThrow();
  });

  it("includes the bulk Sage draft workflow", () => {
    expect(appJs).toContain("previewSelectedDraftInvoices");
    expect(appJs).toContain("createSelectedDraftInvoices");
    expect(appJs).toContain("Select at least one Sage-ready invoice first.");
  });
});
