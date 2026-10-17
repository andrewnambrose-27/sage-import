import { describe, expect, it } from "vitest";
import { helpContent } from "./helpContent";
import { helpCentreJs, renderHelpCentre, searchHelpGuides } from "./helpCentre";

describe("Help Centre content and search", () => {
  it("has stable unique category, guide and step IDs with valid references", () => {
    const categories = helpContent.categories.map((category) => category.id);
    const guides = helpContent.guides.map((guide) => guide.id);
    const steps = helpContent.guides.flatMap((guide) => guide.steps.map((step) => step.id));
    for (const ids of [categories, guides, steps]) {
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => /^[a-z][a-z0-9-]+$/.test(id))).toBe(true);
    }
    expect(categories).toHaveLength(5);
    for (const categoryId of categories) {
      expect(helpContent.guides.some((guide) => guide.categoryId === categoryId)).toBe(true);
    }
    for (const guide of helpContent.guides) {
      expect(categories).toContain(guide.categoryId);
      expect(guide.steps.length).toBeGreaterThan(0);
      if (guide.toolTarget) {
        expect(["add-files", "check-import", "reconciliation", "review-transactions", "sage-conversion", "draftInvoiceSection"]).toContain(guide.toolTarget);
      }
    }
  });

  it("searches titles, categories, keywords, steps and callouts without changing content", () => {
    const original = JSON.stringify(helpContent);
    expect(searchHelpGuides(helpContent, "  SAGE  DRAFTS ").map((guide) => guide.id)).toContain("create-sage-drafts");
    expect(searchHelpGuides(helpContent, "Réconciliation").map((guide) => guide.id)).toContain("check-import-reconciliation");
    expect(searchHelpGuides(helpContent, "bulk visible").map((guide) => guide.id)).toContain("review-save-batch");
    expect(searchHelpGuides(helpContent, "no-such-topic-xyz")).toEqual([]);
    expect(searchHelpGuides(helpContent, "   ")).toHaveLength(helpContent.guides.length);
    expect(JSON.stringify(helpContent)).toBe(original);
  });

  it("emits valid browser JavaScript and a self-contained search function", () => {
    expect(() => new Function(helpCentreJs)).not.toThrow();
    const browserSearch = new Function("return (" + searchHelpGuides.toString() + ")")() as typeof searchHelpGuides;
    expect(browserSearch(helpContent, "customers")).toEqual(searchHelpGuides(helpContent, "customers"));
  });

  it("safely embeds editable content as JSON without allowing script termination", () => {
    const content = structuredClone(helpContent);
    content.guides[0].title = '</script><img src="x" onerror="alert(1)">';
    const html = renderHelpCentre(content);
    expect(html).not.toContain(content.guides[0].title);
    const json = html.match(/<script id="helpContentData" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    expect(JSON.parse(json!).guides[0].title).toBe(content.guides[0].title);
  });
});
