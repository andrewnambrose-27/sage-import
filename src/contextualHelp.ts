import { helpContent } from "./helpContent";

interface HelpInfoOptions {
  id?: string;
  tooltip?: string;
  label?: string;
}

interface ContextualHelpEntry {
  guideId: string;
  label: string;
  tooltip: string;
}

/** One entry per placement, using the existing guide IDs and actual UI labels. */
export const contextualHelp = {
  "upload-step": { guideId: "upload-and-check-files", label: "Add files", tooltip: "Learn how to upload and check your files." },
  "removal-invoices": { guideId: "choose-csv-exports", label: "Removal invoices CSV", tooltip: "Find out where to download your Sage invoice data." },
  "removal-deposits": { guideId: "before-you-start", label: "Removal deposits CSV", tooltip: "Check which deposit files the tool can use." },
  "ad-hoc-invoices": { guideId: "before-you-start", label: "Ad Hoc invoices CSV", tooltip: "Check which additional invoice files to include." },
  "credit-notes": { guideId: "before-you-start", label: "Credit notes CSV", tooltip: "Learn how credit note files are used during review." },
  "monthly-report": { guideId: "supporting-pdf-reports", label: "Monthly invoice report PDF", tooltip: "Learn how to export this report from Removals Manager." },
  "individual-invoices": { guideId: "before-you-start", label: "Individual invoice PDFs", tooltip: "Check what individual invoice PDFs can be used for." },
  "import-step": { guideId: "check-import-reconciliation", label: "Check the import", tooltip: "Understand import results, totals and warnings." },
  "reconciliation": { guideId: "check-import-reconciliation", label: "Reconciliation", tooltip: "Understand invoice differences and how to resolve them." },
  "review-step": { guideId: "review-save-batch", label: "Review transactions", tooltip: "Learn how to review transactions and save your batch." },
  "save-batch": { guideId: "review-save-batch", label: "Save reviewed batch", tooltip: "Learn what saving a reviewed batch does." },
  "sage-step": { guideId: "sage-mappings-customers", label: "Set up Sage conversion", tooltip: "Get help with Sage conversion settings and customer matches." },
  "customer-matching": { guideId: "sage-mappings-customers", label: "Customer matching", tooltip: "Learn how customers are matched between Removals Manager and Sage." },
  "draft-step": { guideId: "create-sage-drafts", label: "Create Sage draft invoices", tooltip: "Learn what happens when you create invoices in Sage." },
  "draft-action": { guideId: "create-sage-drafts", label: "Final draft creation", tooltip: "Check the final confirmation and what creating a draft does." },
} satisfies Record<string, ContextualHelpEntry>;

const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));

/** Framework-free component: the existing Help Centre handles data-help-open. */
export function renderHelpInfo(guideId?: string, options: HelpInfoOptions = {}): string {
  const guide = helpContent.guides.find((item) => item.id === guideId);
  const tooltip = options.tooltip ?? (guide ? `Read ${guide.title}.` : "Browse the Help Centre for guidance.");
  const label = guide ? `${options.label ? `Help for ${options.label}` : "Help"}: ${guide.title}` : "Open the Help Centre";
  const tooltipId = `help-tooltip-${options.id ?? crypto.randomUUID()}`;
  return `<span class="help-info">
    <button type="button" class="help-info-button" data-help-open="${escape(guide?.id ?? "")}" aria-haspopup="dialog" aria-controls="help-guides" aria-expanded="false" aria-label="${escape(label)}" aria-describedby="${escape(tooltipId)}">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v6M12 7h.01"></path></svg>
    </button>
    <span id="${escape(tooltipId)}" class="help-info-tooltip" role="tooltip" hidden>${escape(tooltip)}</span>
  </span>`;
}

export function renderContextualHelp(key: keyof typeof contextualHelp): string {
  const entry = contextualHelp[key];
  return renderHelpInfo(entry.guideId, { id: key, label: entry.label, tooltip: entry.tooltip });
}

export const helpInfoCss = String.raw`
.help-info { display: inline-flex; flex: 0 0 auto; vertical-align: middle; }
.help-info .help-info-button {
  display: inline-grid; place-items: center; width: 36px; min-width: 36px; height: 36px; min-height: 36px;
  padding: 0; border: 1px solid transparent; border-radius: 50%; background: transparent; color: var(--sage);
  cursor: pointer; touch-action: manipulation;
}
.help-info .help-info-button:hover, .help-info .help-info-button:focus-visible { background: #e3f0eb; border-color: #abcfc2; }
.help-info .help-info-tooltip {
  position: fixed; z-index: 40; width: max-content; max-width: min(260px, calc(100vw - 24px));
  margin: 0; padding: 10px 12px; border: 1px solid var(--sage-dark); border-radius: 8px;
  background: var(--sage-dark); color: #fff; box-shadow: 0 5px 18px rgb(10 74 66 / 15%);
  font-size: 0.82rem; font-weight: 500; line-height: 1.5; text-transform: none; letter-spacing: normal;
}
.help-info-heading { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.help-info-heading h3 { margin: 0; min-width: 0; }
.help-info-action { display: inline-flex; align-items: center; gap: 6px; }
.help-info .help-info-button svg { width: 18px; height: 18px; }
.draft-final-step-copy .help-info-heading { margin-bottom: 0; }
@media (max-width: 820px), (pointer: coarse) {
  .help-info .help-info-button { width: 44px; min-width: 44px; height: 44px; min-height: 44px; }
  .button-row .help-info-action { width: 100%; }
}
`;
