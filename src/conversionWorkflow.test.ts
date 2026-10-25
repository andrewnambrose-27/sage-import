import { describe, expect, it } from "vitest";
import { deriveWorkflow, renderWorkflowHeader, renderWorkflowProgress, type WorkflowSnapshot } from "./conversionWorkflow";
import { hasBlockingWarning, type ReadinessInput } from "./sageMappings";

const initial: WorkflowSnapshot = {
  fileCount: 0, invalidFiles: 0, checkState: "idle", filesCurrent: false, rowCount: 0,
  importAttention: 0, reviewAttention: 0, batchSaved: false, saving: false, saveFailed: false,
  setupComplete: false, setupAttention: 0, connected: false, readinessCurrent: false,
  readyInvoices: 0, draftState: "no_invoices_selected", draftSucceeded: 0, draftFailed: 0, draftTotal: 0,
};
const parsed: WorkflowSnapshot = { ...initial, fileCount: 2, checkState: "passed", filesCurrent: true, rowCount: 124 };
const ready: WorkflowSnapshot = { ...parsed, batchSaved: true, connected: true, readinessCurrent: true, setupComplete: true, readyInvoices: 124 };
const statuses = (s: WorkflowSnapshot) => deriveWorkflow(s).map((step) => step.status);

describe("conversion workflow status from application state", () => {
  it("starts ready to add files without marking later steps complete", () => {
    expect(statuses(initial)).toEqual(["ready", "not-started", "not-started", "not-started", "not-started"]);
    expect(statuses({ ...initial, fileCount: 1 })[0]).toBe("in-progress");
    expect(statuses({ ...initial, fileCount: 1, invalidFiles: 1 })[0]).toBe("attention");
  });
  it("allows successful optional PDF-only checks without claiming invoice processing is complete", () => {
    expect(statuses({ ...initial, fileCount: 1, checkState: "passed", filesCurrent: true })).toEqual(["completed", "ready", "not-started", "not-started", "not-started"]);
  });
  it("counts a pasted report as a source and requires a CSV before invoice processing", () => {
    const snapshot = { ...initial, fileCount: 1, hasPastedReport: true, checkState: "passed" as const, filesCurrent: true };
    expect(statuses(snapshot)).toEqual(["completed", "ready", "not-started", "not-started", "not-started"]);
    expect(deriveWorkflow(snapshot)[0].summary).toBe("1 source added and checked.");
    expect(deriveWorkflow(snapshot)[1].summary).toContain("Add a CSV export");
    expect(statuses({ ...parsed, hasPastedReport: true, filesCurrent: false })[1]).toBe("attention");
  });
  it("requires actual parsed rows and reports unresolved checks separately from successful upload checks", () => {
    expect(statuses(parsed)).toEqual(["completed", "completed", "ready", "not-started", "not-started"]);
    expect(statuses({ ...parsed, importAttention: 3, reviewAttention: 2 })).toEqual(["completed", "attention", "attention", "not-started", "not-started"]);
    expect(deriveWorkflow({ ...parsed, importAttention: 3 })[1].summary).toContain("3 items need attention");
  });
  it("never completes failed or changed file checks even with previous saved data and draft results", () => {
    expect(statuses({ ...ready, filesCurrent: false, checkState: "idle", draftState: "created", draftTotal: 1, draftSucceeded: 1 }).every((status) => status !== "completed")).toBe(true);
    expect(statuses({ ...parsed, checkState: "failed", rowCount: 0 }).slice(0, 3)).toEqual(["attention", "attention", "not-started"]);
  });
  it("requires a successful saved batch with resolved review decisions", () => {
    expect(statuses({ ...parsed, saving: true })[2]).toBe("in-progress");
    expect(statuses({ ...parsed, saveFailed: true })[2]).toBe("attention");
    expect(statuses({ ...parsed, batchSaved: true })[2]).toBe("completed");
    expect(statuses({ ...parsed, batchSaved: true, reviewAttention: 1 })[2]).toBe("attention");
  });
  it("requires a live connection, confirmed readiness and relevant settings before completing Sage setup", () => {
    expect(statuses(ready)[3]).toBe("completed");
    expect(statuses({ ...ready, connected: false })[3]).toBe("attention");
    expect(statuses({ ...ready, readinessCurrent: false })[3]).toBe("attention");
    expect(statuses({ ...ready, setupComplete: false, setupAttention: 2 })[3]).toBe("attention");
    expect(statuses({ ...ready, batchSaved: false })[3]).toBe("not-started");
  });
  it("requires confirmed successful creation, never just a valid preview, and retains partial failures", () => {
    expect(statuses({ ...ready, draftState: "preview_valid" })[4]).toBe("in-progress");
    expect(statuses({ ...ready, draftState: "created" })[4]).not.toBe("completed");
    expect(statuses({ ...ready, draftState: "created", draftTotal: 2, draftSucceeded: 1 })[4]).not.toBe("completed");
    expect(statuses({ ...ready, draftState: "created_partial", draftTotal: 2, draftSucceeded: 1, draftFailed: 1 })[4]).toBe("attention");
    const completed = { ...ready, draftState: "created", draftTotal: 2, draftSucceeded: 2, readyInvoices: 122 };
    expect(statuses(completed)[4]).toBe("completed");
    expect(deriveWorkflow(completed)[4].summary).toBe("2 selected drafts completed in Sage. 122 invoices still ready.");
  });
  it("reuses the Sage blocking warning predicate without treating informational candidate text as blocking", () => {
    const row: ReadinessInput = { transaction_type: "removal", tax_code: "T1", nominal_code: "4010", classification: "import_candidate", warnings: ["Normal invoice row appears importable."], review_decision: "include" };
    expect(hasBlockingWarning(row)).toBe(false);
    expect(hasBlockingWarning({ ...row, warnings: ["Overlapping invoice rows."] })).toBe(true);
    expect(hasBlockingWarning({ ...row, classification: "amount_mismatch" })).toBe(true);
  });
});

describe("workflow headers", () => {
  it("keeps Help separate from the accordion button and exposes the initial expanded state", () => {
    const first = renderWorkflowHeader(0);
    expect(first).toContain('aria-expanded="true" aria-controls="add-files-body"');
    expect(renderWorkflowHeader(1)).toContain('aria-expanded="false" aria-controls="check-import-body"');
    expect(first.indexOf("</button>")).toBeLessThan(first.indexOf("data-help-open"));
    expect(renderWorkflowProgress().match(/data-workflow-open=/g)).toHaveLength(5);
  });
});
