import { renderContextualHelp } from "./contextualHelp";

export const workflowSteps = [
  { id: "add-files", title: "Add files", help: "upload-step" },
  { id: "check-import", title: "Check the import", help: "import-step" },
  { id: "review-transactions", title: "Review transactions", help: "review-step" },
  { id: "sage-conversion", title: "Set up Sage conversion", help: "sage-step" },
  { id: "draftInvoiceSection", title: "Create Sage draft invoices", help: "draft-step" },
] as const;

export type WorkflowStatus = "not-started" | "ready" | "in-progress" | "attention" | "completed";
export interface WorkflowSnapshot {
  fileCount: number;
  hasPastedReport?: boolean;
  hasCustomerList?: boolean;
  invalidFiles: number;
  checkState: "idle" | "checking" | "passed" | "failed";
  filesCurrent: boolean;
  rowCount: number;
  importAttention: number;
  reviewAttention: number;
  batchSaved: boolean;
  saving: boolean;
  saveFailed: boolean;
  setupComplete: boolean;
  setupAttention: number;
  connected: boolean;
  readinessCurrent: boolean;
  readyInvoices: number;
  draftState: string;
  draftSucceeded: number;
  draftFailed: number;
  draftTotal: number;
}
export interface WorkflowStepState { status: WorkflowStatus; summary: string }

// Presentation only. Counts and validation outcomes are supplied by the existing application.
// Kept self-contained so the same function is tested and emitted to the browser.
export function deriveWorkflow(snapshot: WorkflowSnapshot): WorkflowStepState[] {
  const s = snapshot;
  const count = (n: number, noun: string) => n + " " + noun + (n === 1 ? "" : "s");
  const attention = (n: number) => count(n, "item") + " need" + (n === 1 ? "s" : "") + " attention";
  const checked = s.filesCurrent && s.checkState === "passed";
  const imported = checked && s.rowCount > 0;
  const saved = imported && s.batchSaved && s.reviewAttention === 0;
  const setup = saved && s.connected && s.readinessCurrent && s.setupComplete;
  const states: WorkflowStepState[] = [
    { status: "ready", summary: "Add any exports you have." },
    { status: "not-started", summary: "Check your uploaded files first." },
    { status: "not-started", summary: "No transactions ready for review." },
    { status: "not-started", summary: "Save your reviewed batch first." },
    { status: "not-started", summary: "Not started." },
  ];
  if (s.fileCount) states[0] = { status: "in-progress", summary: count(s.fileCount, s.hasPastedReport ? "source" : "file") + " ready to check." };
  if (s.invalidFiles) states[0] = { status: "attention", summary: count(s.invalidFiles, "file") + " need" + (s.invalidFiles === 1 ? "s" : "") + " checking." };
  else if (s.checkState === "checking") states[0] = { status: "in-progress", summary: "Checking uploaded files…" };
  else if (s.checkState === "failed") states[0] = { status: "attention", summary: "File checks did not finish successfully. View the check results." };
  else if (checked) states[0] = { status: "completed", summary: count(s.fileCount, s.hasPastedReport ? "source" : "file") + (s.hasPastedReport ? " added and checked." : " uploaded and checked.") };

  if (checked) states[1] = s.rowCount
    ? { status: s.importAttention ? "attention" : "completed", summary: count(s.rowCount, "row") + " parsed · " + (s.importAttention ? attention(s.importAttention) : "No unresolved import checks.") }
    : { status: "ready", summary: s.hasCustomerList ? "Customer list checked. Add an invoice CSV export to continue." : s.hasPastedReport ? "Monthly report checked. Add a CSV export to compare invoice rows." : "PDF checks finished. Add a CSV export to read invoice rows." };
  else if (s.checkState === "failed") states[1] = { status: "attention", summary: "File check results need attention." };

  if (imported) {
    states[2] = s.reviewAttention
      ? { status: "attention", summary: count(s.reviewAttention, "transaction") + " need" + (s.reviewAttention === 1 ? "s" : "") + " reviewing." }
      : s.saving ? { status: "in-progress", summary: "Saving reviewed batch…" }
      : s.saveFailed ? { status: "attention", summary: "Batch save failed. Review the save message." }
      : saved ? { status: "completed", summary: count(s.rowCount, "transaction") + " reviewed · Batch saved." }
      : { status: "ready", summary: count(s.rowCount, "transaction") + " to review and save." };
  }
  if (saved) states[3] = setup
    ? { status: "completed", summary: "Sage settings and customer matches ready." }
    : !s.connected ? { status: "attention", summary: "Check the Sage connection above the workflow." }
    : !s.readinessCurrent ? { status: "attention", summary: "Sage readiness has not been confirmed. Check your settings." }
    : s.setupAttention ? { status: "attention", summary: attention(s.setupAttention) + " in Sage setup." }
    : { status: "ready", summary: "No included invoices ready. Review your transaction choices." };

  if (setup || (saved && s.readyInvoices)) states[4] = { status: "ready", summary: count(s.readyInvoices, "invoice") + " ready for draft checks." };
  if (s.draftState === "checking" || s.draftState === "creating" || s.draftState === "preview_valid" || s.draftState === "preview_stale") {
    states[4] = { status: "in-progress", summary: s.draftState === "creating" ? "Creating selected drafts in Sage…" : "Check and confirm the selected draft details." };
  }
  if (s.draftState === "failed" || s.draftState === "created_partial") states[4] = { status: "attention", summary: s.draftFailed ? count(s.draftFailed, "draft") + " need" + (s.draftFailed === 1 ? "s" : "") + " attention · " + s.draftSucceeded + " completed." : "Draft checks need attention." };
  if (s.draftState === "created" && s.draftTotal > 0 && s.draftSucceeded === s.draftTotal && !s.draftFailed) {
    states[4] = { status: "completed", summary: count(s.draftSucceeded, "selected draft") + " completed in Sage." + (s.readyInvoices ? " " + count(s.readyInvoices, "invoice") + " still ready." : "") };
  }
  // A changed upload keeps the old data visible but cannot retain completion ticks.
  if (!s.filesCurrent && s.rowCount) {
    for (let index = 1; index < states.length; index += 1) states[index] = { status: "attention", summary: "Files changed — check them again to update this step." };
  }
  return states;
}

export function renderWorkflowHeader(index: number): string {
  const step = workflowSteps[index];
  const open = index === 0;
  return `<div class="workflow-heading"><h2 id="${step.id}-heading"><button type="button" class="workflow-toggle" id="${step.id}-toggle" data-workflow-toggle="${index}" aria-expanded="${open}" aria-controls="${step.id}-body" aria-describedby="${step.id}-summary"><span class="step-badge" aria-hidden="true">${index + 1}</span><span class="workflow-title">${step.title}<span class="workflow-status">${open ? "Ready" : "Not started"}</span></span><svg class="workflow-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></h2>${renderContextualHelp(step.help)}</div><p class="workflow-summary" id="${step.id}-summary"></p>`;
}

export function renderWorkflowProgress(): string {
  return `<nav class="workflow-progress" aria-label="Conversion progress"><p id="workflowProgressLabel" role="status" aria-live="polite">Step 1 of 5 — Add files</p><ol>${workflowSteps.map((step, index) => `<li><button type="button" data-workflow-open="${index}" aria-label="Step ${index + 1}: ${step.title}"${index === 0 ? ' aria-current="step"' : ""}><span class="workflow-segment" aria-hidden="true"></span><span class="workflow-sr-only" data-workflow-progress-status>Not started</span></button></li>`).join("")}</ol></nav>`;
}

export const workflowControllerJs = String.raw`
let activeWorkflowStep = 0;
let expandedWorkflowStep = 0;
let workflowStates = [];
let workflowInitialised = false;
function initialiseWorkflow() {
  workflowInitialised = true;
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-workflow-toggle], [data-workflow-open]") : null;
    if (!button || button.disabled) return;
    const index = Number(button.dataset.workflowToggle ?? button.dataset.workflowOpen);
    if (button.hasAttribute("data-workflow-toggle") && expandedWorkflowStep === index) {
      expandedWorkflowStep = -1;
      updateWorkflow();
    } else openWorkflowStep(index);
  });
  document.addEventListener("workflow:reveal", (event) => {
    const target = document.getElementById(event.detail.id);
    if (!target) return;
    const index = workflowSteps.findIndex((step) => target.closest(".workflow-card")?.id === step.id);
    if (index >= 0) openWorkflowStep(index, { focus: false, scroll: false });
    window.setTimeout(() => {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ behavior: workflowMotion(), block: "start" });
    }, workflowMotion() === "auto" ? 0 : 220);
  });
  updateWorkflow();
  const target = document.getElementById(window.location.hash.slice(1));
  if (target?.closest(".workflow-card")) document.dispatchEvent(new CustomEvent("workflow:reveal", { detail: { id: target.id } }));
}
function workflowMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
function openWorkflowStep(index, options = {}) {
  if (!workflowSteps[index]) return;
  activeWorkflowStep = index;
  expandedWorkflowStep = index;
  updateWorkflow();
  const button = document.getElementById(workflowSteps[index].id + "-toggle");
  if (options.focus !== false) button.focus({ preventScroll: true });
  if (options.scroll !== false) window.setTimeout(() => {
    if (expandedWorkflowStep === index) document.getElementById(workflowSteps[index].id).scrollIntoView({ behavior: workflowMotion(), block: "start" });
  }, workflowMotion() === "auto" ? 0 : 220);
}
function advanceWorkflow(from, to) {
  updateWorkflow();
  // An operation finishing in the background must not steal the user's place or Help focus.
  if (expandedWorkflowStep !== from || document.querySelector("#help-guides").open) return;
  if (workflowStates.slice(0, from + 1).every((state) => state.status === "completed")) openWorkflowStep(to);
}
function updateWorkflow() {
  if (!workflowInitialised) return;
  const snapshot = workflowSnapshot();
  workflowStates = deriveWorkflow(snapshot);
  const labels = { "not-started": "Not started", ready: "Ready", "in-progress": "In progress", attention: "Needs attention", completed: "Completed" };
  workflowSteps.forEach((step, index) => {
    const card = document.getElementById(step.id);
    const button = document.getElementById(step.id + "-toggle");
    const body = document.getElementById(step.id + "-body");
    const open = expandedWorkflowStep === index;
    const state = workflowStates[index];
    const displayStatus = open && state.status === "ready" ? "in-progress" : state.status;
    card.dataset.status = displayStatus;
    card.classList.toggle("is-active", open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", "Step " + (index + 1) + ": " + step.title + ". " + labels[displayStatus]);
    button.querySelector(".step-badge").textContent = state.status === "completed" ? "✓" : String(index + 1);
    button.querySelector(".workflow-status").textContent = labels[displayStatus];
    document.getElementById(step.id + "-summary").textContent = state.summary;
    // Keep every input/table and its listeners mounted. Inert removes hidden controls from Tab order.
    if (!open && body.contains(document.activeElement)) button.focus({ preventScroll: true });
    body.inert = !open;
    body.classList.toggle("is-collapsed", !open);
    const segment = document.querySelector('[data-workflow-open="' + index + '"]');
    segment.classList.toggle("is-completed", state.status === "completed");
    segment.querySelector("[data-workflow-progress-status]").textContent = labels[state.status];
    if (activeWorkflowStep === index) segment.setAttribute("aria-current", "step");
    else segment.removeAttribute("aria-current");
  });
  const label = "Step " + (activeWorkflowStep + 1) + " of 5 — " + workflowSteps[activeWorkflowStep].title + (expandedWorkflowStep < 0 ? " (collapsed)" : "");
  const progress = document.querySelector("#workflowProgressLabel");
  if (progress.textContent !== label) progress.textContent = label;
  document.querySelector("#continueReviewButton").disabled = !snapshot.filesCurrent || snapshot.rowCount === 0;
  document.querySelector("#viewFileResultsButton").hidden = snapshot.checkState === "idle" || snapshot.checkState === "checking";
}
`;

export const workflowCss = String.raw`
.workflow-progress { margin-top: 32px; }
.workflow-progress p { margin: 0 0 8px; color: var(--muted); font-size: .9rem; font-weight: 700; }
.workflow-progress ol { list-style: none; padding: 0; margin: 0; display: flex; gap: 8px; }
.workflow-progress li { flex: 1; }
.workflow-progress button { display: block; width: 100%; padding: 12px 0; border: 0; background: transparent; box-shadow: none; }
.workflow-segment { display: block; height: 5px; border-radius: 8px; background: #dce4e1; }
.workflow-progress button.is-completed .workflow-segment { background: var(--sage); }
.workflow-progress button[aria-current] .workflow-segment { outline: 2px solid var(--sage); outline-offset: 3px; }
.dashboard-shell .workflow-card { padding: 0; overflow: visible; transition: border-color 180ms, box-shadow 180ms; }
.dashboard-shell .workflow-card.is-active { border-color: #5d9d8e; box-shadow: 0 0 0 1px #8bb9ad, 0 12px 28px rgba(12,77,62,.08); }
.workflow-heading { display: flex; align-items: center; gap: 4px; padding: 16px 22px 0; }
.workflow-heading h2 { flex: 1; min-width: 0; margin: 0; }
.workflow-toggle { display: flex; align-items: center; gap: 14px; width: 100%; background: transparent; color: inherit; border: 0; border-radius: 6px; padding: 6px 0; text-align: left; box-shadow: none; font: inherit; }
.workflow-toggle:hover { background: #f5faf7; color: inherit; }
.workflow-title { flex: 1; font-size: 1.5rem; line-height: 1.25; }
.workflow-status { display: block; font-size: .75rem; font-weight: 600; color: var(--muted); margin-top: 5px; }
.workflow-toggle .step-badge { flex: 0 0 48px; background: #e7ecea; color: #586760; }
.workflow-card[data-status="ready"] .step-badge { background: #dcefe8; color: #126c5c; }
.workflow-card[data-status="in-progress"] .step-badge, .workflow-card[data-status="completed"] .step-badge { background: var(--sage); color: white; }
.workflow-card[data-status="attention"] .step-badge { background: #fff0d4; color: #805312; }
.workflow-card[data-status="attention"] .workflow-status { color: #805312; }
.workflow-chevron { width: 20px; height: 20px; flex: 0 0 20px; transition: transform 180ms; }
.workflow-toggle[aria-expanded="true"] .workflow-chevron { transform: rotate(180deg); }
.workflow-summary { margin: 8px 22px 20px 84px; font-size: .9rem; color: var(--muted); }
.workflow-body { display: grid; grid-template-rows: 1fr; transition: grid-template-rows 200ms ease; }
.workflow-body.is-collapsed { grid-template-rows: 0fr; visibility: hidden; transition: grid-template-rows 200ms ease, visibility 0s 200ms; }
.workflow-body-inner { min-height: 0; overflow: hidden; }
.workflow-content { padding: 0 22px 22px; }
.workflow-content > .section-heading { margin-top: 0; }
.workflow-content > .section-heading p { margin-top: 0; }
.workflow-continue { display: flex; justify-content: flex-end; margin-top: 20px; }
.workflow-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 600px) {
  .workflow-heading { padding: 12px 14px 0; }
  .workflow-toggle { gap: 10px; }
  .workflow-title { font-size: 1.2rem; }
  .workflow-toggle .step-badge { width: 40px; height: 40px; flex-basis: 40px; font-size: 1.25rem; }
  .workflow-summary { margin: 8px 14px 18px 64px; }
  .workflow-content { padding: 0 14px 18px; }
}
@media (prefers-reduced-motion: reduce) {
  .workflow-body, .workflow-body.is-collapsed, .workflow-chevron, .dashboard-shell .workflow-card { transition: none; }
}
`;
