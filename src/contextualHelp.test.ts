import { describe, expect, it } from "vitest";
import { contextualHelp, renderContextualHelp, renderHelpInfo } from "./contextualHelp";
import { helpContent } from "./helpContent";

describe("contextual Help buttons", () => {
  it("connects every placement to an existing guide with a unique tooltip", () => {
    const ids = new Set<string>();
    for (const key of Object.keys(contextualHelp) as Array<keyof typeof contextualHelp>) {
      const entry = contextualHelp[key];
      expect(helpContent.guides.some((guide) => guide.id === entry.guideId)).toBe(true);
      const html = renderContextualHelp(key);
      expect(html).toContain(`data-help-open="${entry.guideId}"`);
      expect(html).toContain('type="button"');
      expect(html).toContain('aria-haspopup="dialog"');
      expect(html).toContain('aria-controls="help-guides"');
      const tooltipId = html.match(/aria-describedby="([^"]+)"/)![1];
      expect(html).toContain(`id="${tooltipId}"`);
      expect(ids.has(tooltipId)).toBe(false);
      ids.add(tooltipId);
    }
  });

  it("falls back to the Help Centre when a guide is missing or invalid", () => {
    for (const id of [undefined, "", "guide-does-not-exist"]) {
      const html = renderHelpInfo(id);
      expect(html).toContain('data-help-open=""');
      expect(html).toContain('aria-label="Open the Help Centre"');
      expect(html).toContain("Browse the Help Centre for guidance.");
    }
  });

  it("provides default and custom descriptions without allowing HTML injection", () => {
    expect(renderHelpInfo("supporting-pdf-reports")).toContain("Read Copy or export your Monthly Invoice Report.");
    const html = renderHelpInfo("supporting-pdf-reports", { id: "custom-help", label: "Monthly report", tooltip: '<img src="x" onerror="alert(1)">' });
    expect(html).toContain('aria-label="Help for Monthly report: Copy or export your Monthly Invoice Report"');
    expect(html).not.toContain('<img src="x"');
    expect(html).toContain("&lt;img");
  });
});
