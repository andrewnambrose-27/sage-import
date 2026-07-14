import { describe, expect, it } from "vitest";
import {
  extractInvoiceNumber,
  normalizeDate,
  normalizeRow,
  parseMoney,
  parseRemovalsCsv,
} from "./removalsParser";

describe("extractInvoiceNumber", () => {
  it("extracts Removals Manager invoice numbers from common references", () => {
    expect(extractInvoiceNumber("RM inv no.4632")).toBe("4632");
    expect(extractInvoiceNumber("RM invoice 4632")).toBe("4632");
    expect(extractInvoiceNumber("inv no 4632")).toBe("4632");
  });

  it("returns null when no invoice number is present", () => {
    expect(extractInvoiceNumber("monthly storage charge")).toBeNull();
    expect(extractInvoiceNumber("")).toBeNull();
  });
});

describe("normalizeDate", () => {
  it("normalises ISO and UK dates to ISO format", () => {
    expect(normalizeDate("2026-04-30")).toBe("2026-04-30");
    expect(normalizeDate("26/05/2026")).toBe("2026-05-26");
  });

  it("rejects missing and impossible dates", () => {
    expect(normalizeDate("")).toBeNull();
    expect(normalizeDate("31/02/2026")).toBeNull();
  });
});

describe("parseMoney", () => {
  it("normalises money values to numbers", () => {
    expect(parseMoney("3615.53")).toBe(3615.53);
    expect(parseMoney("1,695.00")).toBe(1695);
    expect(parseMoney("£70.00")).toBe(70);
    expect(parseMoney("(15.50)")).toBe(-15.5);
  });

  it("rejects empty and invalid money values", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("not money")).toBeNull();
  });
});

describe("row validation", () => {
  it("flags empty fields without discarding the row", () => {
    const row = normalizeRow(
      ["SI", "", "4010", "", "", "", "", "", "T1", ""],
      1,
      { transactionType: "removal", sourceFile: "removals.csv" },
    );

    expect(row.warnings).toEqual([
      "Missing invoice number.",
      "Missing or invalid date.",
      "Invalid amount.",
      "Invalid VAT.",
      "Missing description.",
    ]);
    expect(row.raw).toHaveLength(10);
  });

  it("flags unknown row formats and keeps the raw row", () => {
    const rows = parseRemovalsCsv("unexpected,row\n", {
      transactionType: "ad_hoc",
      sourceFile: "adhoc.csv",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].transaction_type).toBe("ad_hoc");
    expect(rows[0].raw).toEqual(["unexpected", "row"]);
    expect(rows[0].warnings).toContain("Unknown row format: expected at least 10 columns.");
  });
});
