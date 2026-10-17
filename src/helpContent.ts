/** Edit guide copy here. Keep published category, guide and step IDs stable. */
export type HelpToolTarget = "add-files" | "check-import" | "reconciliation" | "review-transactions" | "sage-conversion" | "draftInvoiceSection";

export interface HelpCallout {
  type: "note" | "tip" | "important";
  title: string;
  body: string;
}

export interface HelpStep {
  id: string;
  title: string;
  body: string;
  screenshot?: { src: string; alt: string; caption?: string };
  callout?: HelpCallout;
}

export interface HelpGuide {
  id: string;
  categoryId: string;
  title: string;
  summary: string;
  keywords: string[];
  contentStatus: "placeholder" | "ready";
  toolTarget?: HelpToolTarget;
  toolLabel?: string;
  callouts?: HelpCallout[];
  steps: HelpStep[];
}

export interface HelpContent {
  categories: Array<{ id: string; title: string; description: string }>;
  guides: HelpGuide[];
}

// These short starter entries will be replaced with detailed copy in the next task.
// Screenshots are optional: add { src: "/help/screenshots/file.png", alt, caption }
// to a step when an approved image is available. Do not add customer data to images.
export const helpContent: HelpContent = {
  categories: [
    { id: "getting-started", title: "Getting started", description: "What you'll need and how the process works." },
    { id: "removals-manager-exports", title: "Removals Manager exports", description: "Find and download the correct files." },
    { id: "using-conversion-tool", title: "Using the conversion tool", description: "Upload, check and review your data." },
    { id: "sage-setup-invoices", title: "Sage setup & invoices", description: "Match customers and create drafts." },
    { id: "troubleshooting-faqs", title: "Troubleshooting & FAQs", description: "Solutions to common problems and questions." },
  ],
  guides: [
    {
      id: "process-overview", categoryId: "getting-started", title: "How the conversion process works",
      summary: "An introduction to the five steps from export files to Sage drafts.",
      keywords: ["overview", "workflow", "first import"], contentStatus: "placeholder", toolTarget: "add-files", toolLabel: "Go to Add files",
      callouts: [{ type: "note", title: "You stay in control", body: "Checking and reviewing files does not create invoices in Sage. Draft creation has a separate confirmation." }],
      steps: [
        { id: "overview-prepare", title: "Prepare your export files", body: "Gather the available CSV exports and supporting PDFs for the period you want to check." },
        { id: "overview-review", title: "Check, review and prepare drafts", body: "Follow the numbered steps in the tool, resolving warnings and customer matches before checking the final draft details." },
      ],
    },
    {
      id: "before-you-start", categoryId: "getting-started", title: "What to have ready",
      summary: "A starting checklist for files, Sage access and the connected business.",
      keywords: ["requirements", "checklist", "prepare"], contentStatus: "placeholder", toolTarget: "add-files", toolLabel: "Go to Add files",
      steps: [
        { id: "prepare-records", title: "Gather the source records", body: "Have your original exports available so you can check any warnings against them." },
        { id: "prepare-business", title: "Check the connected Sage business", body: "Confirm that the tool shows the business you intend to use before preparing invoices." },
      ],
    },
    {
      id: "choose-csv-exports", categoryId: "removals-manager-exports", title: "Choose your CSV exports",
      summary: "Identify removal invoices, deposits, ad hoc invoices and credit notes.",
      keywords: ["download", "removals manager", "csv", "export"], contentStatus: "placeholder", toolTarget: "add-files", toolLabel: "Go to Add files",
      steps: [
        { id: "csv-choose-period", title: "Identify the reporting period", body: "Use exports for the period you want to check. Detailed Removals Manager download instructions will be added here." },
        { id: "csv-match-upload", title: "Match each file to its upload field", body: "Keep removal invoices, separate deposits, ad hoc invoices and credit notes in their corresponding CSV fields." },
      ],
    },
    {
      id: "supporting-pdf-reports", categoryId: "removals-manager-exports", title: "Prepare supporting PDF reports",
      summary: "Understand where the monthly invoice report and invoice PDFs fit.",
      keywords: ["monthly", "report", "pdf", "download"], contentStatus: "placeholder", toolTarget: "add-files", toolLabel: "Go to Add files",
      steps: [
        { id: "pdf-monthly-report", title: "Find the monthly invoice report", body: "Use the matching monthly report where available to support invoice-level checks. Export instructions and screenshots will be added here." },
        { id: "pdf-individual-invoices", title: "Gather individual invoice PDFs", body: "If available, select these in the Individual invoice PDFs field. Multiple files are supported." },
      ],
    },
    {
      id: "upload-and-check-files", categoryId: "using-conversion-tool", title: "Upload and check your files",
      summary: "Add your exports and run the initial checks.",
      keywords: ["upload", "drag", "drop", "check files"], contentStatus: "placeholder", toolTarget: "add-files", toolLabel: "Go to Add files",
      steps: [
        { id: "upload-select-files", title: "Add the files you have", body: "Choose files or drag them into the matching upload fields. Read any file type or size messages." },
        { id: "upload-run-checks", title: "Select Check files", body: "Use the summary and warnings in Step 2 to decide what needs further review." },
      ],
    },
    {
      id: "check-import-reconciliation", categoryId: "using-conversion-tool", title: "Read the import and reconciliation results",
      summary: "Review totals, duplicates and differences between CSV and PDF records.",
      keywords: ["reconciliation", "mismatch", "vat", "totals", "duplicates"], contentStatus: "placeholder", toolTarget: "reconciliation", toolLabel: "Go to Reconciliation",
      steps: [
        { id: "check-summary", title: "Read the import summary", body: "Check row counts, candidate values and warnings before continuing." },
        { id: "check-differences", title: "Investigate differences", body: "Where a monthly report is provided, compare the reconciliation results with your original records." },
      ],
    },
    {
      id: "review-save-batch", categoryId: "using-conversion-tool", title: "Review transactions and save a batch",
      summary: "Use filters, review decisions and the reviewed batch controls.",
      keywords: ["include", "exclude", "filter", "save", "storage", "review"], contentStatus: "placeholder", toolTarget: "review-transactions", toolLabel: "Go to Review transactions",
      callouts: [{ type: "important", title: "Check the active filter", body: "Bulk review actions apply to the visible rows. Storage rows remain excluded." }],
      steps: [
        { id: "review-decisions", title: "Check each transaction", body: "Use the filters to find rows needing attention and review the Include, Exclude or Review decisions." },
        { id: "review-save", title: "Save the reviewed batch", body: "Check the totals before saving. Use Export review CSV if you need a copy of the review." },
      ],
    },
    {
      id: "sage-mappings-customers", categoryId: "sage-setup-invoices", title: "Set up conversions and match customers",
      summary: "Prepare VAT, category and customer matches for Sage.",
      keywords: ["sage", "setup", "vat", "nominal", "category", "contacts", "customers"], contentStatus: "placeholder", toolTarget: "sage-conversion", toolLabel: "Go to Sage conversion",
      steps: [
        { id: "sage-reference-mappings", title: "Check the source code conversions", body: "Choose the Sage VAT rates and categories for the uploaded tax and nominal codes." },
        { id: "sage-customer-matches", title: "Confirm customer matches", body: "Search for the correct Sage contact and confirm the match. Suggested contacts are not accepted automatically.", callout: { type: "tip", title: "Refresh changed options", body: "Use Refresh Sage options after changing VAT settings or categories in Sage." } },
      ],
    },
    {
      id: "create-sage-drafts", categoryId: "sage-setup-invoices", title: "Check and create draft invoices",
      summary: "Select ready invoices, check their details and confirm draft creation.",
      keywords: ["sage", "invoices", "drafts", "confirmation", "ready"], contentStatus: "placeholder", toolTarget: "draftInvoiceSection", toolLabel: "Go to Create Sage draft invoices",
      callouts: [{ type: "note", title: "Drafts only", body: "The tool creates editable drafts. It does not send, release or publish them." }],
      steps: [
        { id: "draft-select-check", title: "Select and check ready invoices", body: "After saving the reviewed batch and resolving readiness issues, select invoices and check their final Sage details." },
        { id: "draft-confirm-create", title: "Confirm draft creation", body: "Review the details, tick the confirmation and use Create selected drafts in Sage when ready." },
      ],
    },
    {
      id: "resolve-blocked-actions", categoryId: "troubleshooting-faqs", title: "Why is an action unavailable?",
      summary: "Find the messages that explain a disabled check, save or draft action.",
      keywords: ["disabled", "blocked", "error", "cannot", "warnings", "missing"], contentStatus: "placeholder", toolTarget: "check-import", toolLabel: "Go to Check the import",
      steps: [
        { id: "blocked-read-message", title: "Read the nearby message", body: "Look for file warnings, review requirements or readiness messages beside the action." },
        { id: "blocked-review-setup", title: "Check the preceding steps", body: "Confirm that the required files, review decisions, saved batch and Sage matches are ready. A more detailed troubleshooting checklist will be added here." },
      ],
    },
    {
      id: "files-session-currency", categoryId: "troubleshooting-faqs", title: "Files, progress and display currency",
      summary: "Common questions about uploaded files, Help and currency labels.",
      keywords: ["privacy", "storage", "reload", "progress", "currency", "gbp", "eur", "usd"], contentStatus: "placeholder",
      steps: [
        { id: "session-keep-originals", title: "Keep your original files", body: "Uploads are not stored permanently. Saved reviewed batches contain reviewed records and metadata. Reloading or leaving the page clears selected files." },
        { id: "session-help-currency", title: "Use Help without leaving the tool", body: "Opening and closing Help keeps the current conversion session in place. Display currency changes labels only and does not apply exchange rates." },
      ],
    },
  ],
};
