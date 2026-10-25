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
      expect(guide.steps.length > 0 || Boolean(guide.answer) || Boolean(guide.fileRequirements?.length)).toBe(true);
      for (const id of guide.relatedGuideIds ?? []) {
        expect(guides).toContain(id);
        expect(id).not.toBe(guide.id);
      }
      for (const step of guide.steps) {
        expect(Object.hasOwn(step, "screenshot")).toBe(true);
        if (step.screenshot) {
          expect(step.screenshot.src).not.toBe("");
          expect(step.screenshot.alt.trim()).not.toBe("");
        }
      }
      if (guide.toolTarget) {
        expect(["add-files", "check-import", "reconciliation", "review-transactions", "sage-conversion", "draftInvoiceSection"]).toContain(guide.toolTarget);
      }
    }
  });

  it("keeps unverified export instructions in draft and documents the supported customer upload", () => {
    const exports = helpContent.guides.filter((guide) => guide.categoryId === "removals-manager-exports");
    expect(exports).toHaveLength(3);
    for (const guide of exports) {
      if (guide.id === "export-sage-customer-csv") expect(guide.contentStatus).toBe("ready");
      else {
        expect(guide.contentStatus).toBe("draft");
        expect(guide.reviewNote).toBeTruthy();
      }
      expect(guide.steps).toHaveLength(6);
    }
    const customerExport = exports.find((guide) => guide.id === "export-sage-customer-csv")!;
    expect(customerExport.steps[5].body).toContain("Preview customer list");
    expect(customerExport.callouts?.[0].body).toContain("JobID, Customer, Tel, Mobile, Email and Address");
    expect(helpContent.guides.some((guide) => guide.contentStatus === "placeholder")).toBe(false);
  });

  it("distinguishes invoice requirements from the optional customer reference CSV", () => {
    const files = helpContent.guides.find((guide) => guide.id === "before-you-start")!.fileRequirements!;
    expect(files.find((file) => file.id === "sage-invoice-csv")?.status).toBe("required");
    expect(files.find((file) => file.id === "monthly-invoice-report")?.status).toBe("recommended");
    expect(files.find((file) => file.id === "sage-customer-csv")?.status).toBe("optional");
    expect(files.find((file) => file.id === "individual-invoice-pdfs")).toBeUndefined();
    expect(searchHelpGuides(helpContent, "20 MB").map((guide) => guide.id)).toContain("faq-upload-problem");
    expect(searchHelpGuides(helpContent, "20 MB").some((guide) => guide.categoryId === "removals-manager-exports")).toBe(false);
    expect(searchHelpGuides(helpContent, "date-range filter").map((guide) => guide.id)).toContain("faq-reporting-dates");
  });

  it("includes the ten supplied article titles and seven searchable FAQ answers", () => {
    const titles = helpContent.guides.map((guide) => guide.title);
    for (const title of [
      "How the conversion process works", "Files you'll need", "Copy or export your Monthly Invoice Report",
      "Export your Sage Invoice CSV", "Upload your Customer List CSV", "Upload and check your files",
      "Check your import and reconciliation", "Review transactions and save your batch",
      "Configure Sage and match customers", "Check and create Sage draft invoices",
    ]) expect(titles).toContain(title);
    const faqs = helpContent.guides.filter((guide) => guide.answer);
    expect(faqs).toHaveLength(7);
    for (const guide of faqs) expect(searchHelpGuides(helpContent, guide.title)).toContain(guide);
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
