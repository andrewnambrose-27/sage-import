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
  details?: string[];
  status?: "to-be-confirmed";
  reviewNote?: string;
  /** null reserves an optional screenshot slot without showing a missing image. */
  screenshot?: { src: string; alt: string; caption?: string } | null;
  callout?: HelpCallout;
}
export interface HelpFileRequirement {
  id: string;
  title: string;
  status: "required" | "recommended" | "optional" | "unsupported";
  description: string;
  note: string;
}
export interface HelpGuide {
  id: string;
  categoryId: string;
  title: string;
  summary: string;
  introduction?: string;
  answer?: string;
  keywords: string[];
  contentStatus: "placeholder" | "draft" | "ready";
  reviewNote?: string;
  toolTarget?: HelpToolTarget;
  toolLabel?: string;
  callouts?: HelpCallout[];
  fileRequirements?: HelpFileRequirement[];
  exampleFilename?: string;
  closingNote?: string;
  relatedGuideIds?: string[];
  steps: HelpStep[];
}
export interface HelpContent {
  categories: Array<{ id: string; title: string; description: string }>;
  guides: HelpGuide[];
}

// Tool instructions were checked against the current code. Removals Manager
// menu paths remain draft until checked in that application. Every step has
// an optional screenshot slot: replace null with an approved image.
// Detailed verification notes are in docs/help-content-review.md.

export const helpContent: HelpContent = {
  "categories": [
    {
      "id": "getting-started",
      "title": "Getting started",
      "description": "What you'll need and how the process works."
    },
    {
      "id": "removals-manager-exports",
      "title": "Removals Manager exports",
      "description": "Find and download the correct files."
    },
    {
      "id": "using-conversion-tool",
      "title": "Using the conversion tool",
      "description": "Upload, check and review your data."
    },
    {
      "id": "sage-setup-invoices",
      "title": "Sage setup & invoices",
      "description": "Match customers and create drafts."
    },
    {
      "id": "troubleshooting-faqs",
      "title": "Troubleshooting & FAQs",
      "description": "Solutions to common problems and questions."
    }
  ],
  "guides": [
    {
      "id": "process-overview",
      "categoryId": "getting-started",
      "title": "How the conversion process works",
      "summary": "An introduction to the five steps from export files to Sage drafts.",
      "contentStatus": "ready",
      "introduction": "This tool helps you transfer invoice information from Removals Manager into Sage by preparing draft invoices for review.",
      "keywords": [
        "overview",
        "workflow",
        "first import",
        "process"
      ],
      "toolTarget": "add-files",
      "toolLabel": "Go to Add files",
      "callouts": [
        {
          "type": "note",
          "title": "About the export guides",
          "body": "The Removals Manager export instructions are supplied for review and are marked Draft. Their menu paths and download methods have not yet been checked in Removals Manager."
        }
      ],
      "steps": [
        {
          "id": "overview-prepare",
          "title": "Export your files",
          "body": "Download the relevant invoice reports and CSV files from Removals Manager. Our export guides explain where to find each file.",
          "screenshot": null
        },
        {
          "id": "overview-review",
          "title": "Upload and check",
          "body": "Add your exported files to the conversion tool. Check the import results and review any warnings before continuing.",
          "screenshot": null
        },
        {
          "id": "overview-transactions",
          "title": "Review your transactions",
          "body": "Review the invoice information, check for missing or incorrect details, and save your batch when you are satisfied.",
          "screenshot": null
        },
        {
          "id": "overview-sage",
          "title": "Configure Sage",
          "body": "Set up your Sage connection and match your Removals Manager customers with their corresponding Sage customer records.",
          "screenshot": null
        },
        {
          "id": "overview-drafts",
          "title": "Create draft invoices",
          "body": "Check your final invoice information and create your draft invoices in Sage.",
          "screenshot": null
        }
      ],
      "closingNote": "Always review the generated information before finalising or issuing invoices in Sage.",
      "relatedGuideIds": [
        "before-you-start",
        "upload-and-check-files",
        "create-sage-drafts"
      ]
    },
    {
      "id": "before-you-start",
      "categoryId": "getting-started",
      "title": "Files you'll need",
      "summary": "Understand which exports the current conversion tool can use.",
      "contentStatus": "ready",
      "introduction": "Before starting a conversion, you'll need to export the relevant files from Removals Manager.",
      "keywords": [
        "requirements",
        "required",
        "optional",
        "recommended",
        "files",
        "addresses",
        "Sage Customer CSV"
      ],
      "toolTarget": "add-files",
      "toolLabel": "Go to Add files",
      "callouts": [
        {
          "type": "note",
          "title": "No individual upload field is mandatory",
          "body": "Check files needs at least one selected file. At least one supported invoice CSV is required to produce invoice rows. PDFs on their own only receive basic file checks. Reconciliation needs both a supported invoice CSV and the Monthly invoice report PDF."
        }
      ],
      "fileRequirements": [
        {
          "id": "monthly-invoice-report",
          "title": "Monthly Invoice Report (PDF)",
          "status": "recommended",
          "description": "Used to compare invoice totals and VAT, identify customers and services, and help distinguish removals deposits.",
          "note": "Use the Monthly invoice report PDF field. This upload is optional, but recommended for customer names, services and reconciliation. The report needs readable text; scanned image-only PDFs are not read as invoice data."
        },
        {
          "id": "sage-invoice-csv",
          "title": "Sage Invoice CSV",
          "status": "required",
          "description": "Contains invoice information used during conversion, including tax codes and Sage-related reference information.",
          "note": "Use Removal invoices CSV for the main removals invoice export. No particular CSV field is mandatory, but at least one supported invoice CSV is needed for invoice processing. The exact Removals Manager export and its compatibility still need checking in the draft export guide."
        },
        {
          "id": "sage-customer-csv",
          "title": "Sage Customer CSV",
          "status": "unsupported",
          "description": "This separate export is intended to contain customer information, including addresses. Its exact contents have not yet been checked.",
          "note": "This version has no Sage Customer CSV upload and does not use it to create or match customer records or fill addresses. Do not put it in an invoice CSV field. It may be kept as a separate reference if useful; it is not needed for processing invoices."
        },
        {
          "id": "other-invoice-csvs",
          "title": "Other supported CSV files",
          "status": "optional",
          "description": "Depending on your work, you may also have separate deposits, ad-hoc invoices or credit notes to include.",
          "note": "Use Removal deposits CSV, Ad Hoc invoices CSV and Credit notes CSV for the corresponding exports. Each field accepts one CSV. These files can be checked and reviewed; the tool does not create Sage credit notes."
        },
        {
          "id": "individual-invoice-pdfs",
          "title": "Individual invoice PDFs",
          "status": "optional",
          "description": "You can select more than one individual invoice PDF in the Individual invoice PDFs field.",
          "note": "These files are checked for file type and size only. They are not read for invoice data and do not replace the Monthly invoice report PDF for reconciliation."
        }
      ],
      "steps": [],
      "closingNote": "Make sure your exports cover the period you want to process and keep the original files until your Sage drafts have been checked.",
      "relatedGuideIds": [
        "supporting-pdf-reports",
        "choose-csv-exports",
        "export-sage-customer-csv",
        "upload-and-check-files"
      ]
    },
    {
      "id": "supporting-pdf-reports",
      "categoryId": "removals-manager-exports",
      "title": "Copy or export your Monthly Invoice Report",
      "summary": "Copy the monthly report table from Removals Manager, or upload a PDF.",
      "introduction": "The report helps identify customers and compare invoice totals. Pasted tables contain no separate VAT figure, so VAT remains sourced from the CSV and is not checked against the pasted report. PDF reports can also check VAT where it is supplied.",
      "keywords": [
        "copy",
        "paste",
        "export",
        "download",
        "monthly",
        "invoice report",
        "pdf",
        "print",
        "From",
        "To"
      ],
      "contentStatus": "draft",
      "reviewNote": "Draft instructions supplied for review. The Removals Manager menu path, report options, date controls and new-tab behaviour have not yet been verified in that application. Check these steps against your version before relying on them.",
      "toolTarget": "add-files",
      "toolLabel": "Go to Add files",
      "steps": [
        {
          "id": "pdf-monthly-report",
          "title": "Open the invoice generator",
          "body": "In Removals Manager, go to RM → Invoices → Generate.",
          "screenshot": null
        },
        {
          "id": "pdf-select-report",
          "title": "Select your report",
          "body": "Choose Invoice Report from the available report options.",
          "screenshot": null
        },
        {
          "id": "pdf-select-dates",
          "title": "Select your dates",
          "body": "Enter the From and To dates for the period you want to export.",
          "screenshot": null
        },
        {
          "id": "pdf-print-version",
          "title": "Generate the printable report",
          "body": "Select Print Version. The report should open in a new browser tab.",
          "screenshot": null
        },
        {
          "id": "pdf-save-report",
          "title": "Copy the complete report table",
          "body": "In the report tab, select all (Ctrl+A on Windows or Cmd+A on Mac) and copy. Include the column headings. Return to the tool and paste into Paste report table, then add your CSV exports and select Check files.",
          "screenshot": null
        },
        {
          "id": "pdf-name-file",
          "title": "Use a PDF instead if preferred",
          "body": "Alternatively, use your browser's Print option and choose Save as PDF. In the tool, expand Or upload a PDF instead and choose that file. Use one monthly report source at a time: pasted table or PDF.",
          "screenshot": null
        }
      ],
      "exampleFilename": "Invoice-Report-September-2026.pdf",
      "callouts": [
        {
          "type": "tip",
          "title": "Check the reporting period",
          "body": "Check that the report covers the correct period and that the invoice row count shown after checking matches your report. Storage rows are excluded from reconciliation as before."
        }
      ],
      "relatedGuideIds": [
        "before-you-start",
        "choose-csv-exports",
        "upload-and-check-files",
        "check-import-reconciliation"
      ]
    },
    {
      "id": "choose-csv-exports",
      "categoryId": "removals-manager-exports",
      "title": "Export your Sage Invoice CSV",
      "summary": "Download the Sage invoice data CSV from Removals Manager.",
      "introduction": "This CSV provides invoice information used during conversion, including tax codes and Sage-related codes.",
      "keywords": [
        "sage",
        "invoice",
        "csv",
        "export",
        "download",
        "file management"
      ],
      "contentStatus": "draft",
      "reviewNote": "Draft instructions supplied for review. The Removals Manager menu labels, file-generation action, new-tab behaviour and CSV download method have not yet been verified. A real export must also be checked against the tool's supported invoice CSV format.",
      "toolTarget": "add-files",
      "toolLabel": "Go to Add files",
      "steps": [
        {
          "id": "csv-open-maintenance",
          "title": "Open Sage maintenance",
          "body": "In Removals Manager, go to System Maintenance → Sage.",
          "screenshot": null
        },
        {
          "id": "csv-open-export",
          "title": "Open the export options",
          "body": "Select File Management, then Generate Sage CSV File.",
          "screenshot": null
        },
        {
          "id": "csv-choose-period",
          "title": "Choose your date range",
          "body": "Enter the From and To dates for the period you want to export.",
          "screenshot": null
        },
        {
          "id": "csv-generate-report",
          "title": "Generate the report",
          "body": "Select the option to generate the file report.",
          "screenshot": null
        },
        {
          "id": "csv-download-file",
          "title": "Download the CSV",
          "body": "When the report opens in a new browser tab, save the output as a CSV file.",
          "screenshot": null
        },
        {
          "id": "csv-match-upload",
          "title": "Name your file",
          "body": "Save the CSV to your computer and include the month and year in its filename.",
          "screenshot": null
        }
      ],
      "exampleFilename": "Sage-Invoices-September-2026.csv",
      "callouts": [
        {
          "type": "tip",
          "title": "Use a matching reporting period",
          "body": "Use the same reporting period as your Monthly Invoice Report where applicable."
        }
      ],
      "relatedGuideIds": [
        "supporting-pdf-reports",
        "before-you-start",
        "upload-and-check-files"
      ]
    },
    {
      "id": "export-sage-customer-csv",
      "categoryId": "removals-manager-exports",
      "title": "Export your Sage Customer CSV",
      "summary": "Export customer information from Removals Manager.",
      "introduction": "This optional export provides customer details, including addresses, which may help when matching or preparing customer records.",
      "keywords": [
        "sage",
        "customer",
        "csv",
        "export",
        "addresses",
        "download"
      ],
      "contentStatus": "draft",
      "reviewNote": "Draft instructions supplied for review. The customer export's menu path, date controls, file contents and download method have not been verified in Removals Manager. Optional here refers to a separate reference export: the current conversion tool cannot import this file.",
      "toolTarget": "sage-conversion",
      "toolLabel": "Go to Customer matching",
      "callouts": [
        {
          "type": "important",
          "title": "No customer CSV upload in this version",
          "body": "The conversion tool does not read a Sage Customer CSV or use it to fill addresses. Use Customer matching to search for and confirm existing Sage contacts. Customer addresses need checking in Sage."
        },
        {
          "type": "tip",
          "title": "Keep customer details as a reference",
          "body": "This file may be particularly helpful when customer address information is required. In this version it can only be a separate reference; it is not an upload used by the tool."
        }
      ],
      "steps": [
        {
          "id": "customer-open-maintenance",
          "title": "Open Sage maintenance",
          "body": "In Removals Manager, go to System Maintenance → Sage.",
          "screenshot": null
        },
        {
          "id": "customer-open-management",
          "title": "Open File Management",
          "body": "Find the Generate Sage Customer CSV File option.",
          "screenshot": null
        },
        {
          "id": "customer-select-export",
          "title": "Select the customer export",
          "body": "Choose Generate Sage Customer CSV File.",
          "screenshot": null
        },
        {
          "id": "customer-select-dates",
          "title": "Select your dates",
          "body": "Enter the From and To dates for the customer information you need.",
          "screenshot": null
        },
        {
          "id": "customer-generate-report",
          "title": "Generate the report",
          "body": "Select the option to generate the customer CSV report.",
          "screenshot": null
        },
        {
          "id": "customer-save-csv",
          "title": "Save the CSV file",
          "body": "Download the generated CSV to your computer and give it a descriptive filename.",
          "screenshot": null,
          "status": "to-be-confirmed",
          "reviewNote": "To be confirmed: the exact download method has not been tested. The wording below is proposed for review, not a confirmed download instruction."
        }
      ],
      "exampleFilename": "Sage-Customers-September-2026.csv",
      "relatedGuideIds": [
        "before-you-start",
        "sage-mappings-customers",
        "faq-missing-customers"
      ]
    },
    {
      "id": "upload-and-check-files",
      "categoryId": "using-conversion-tool",
      "title": "Upload and check your files",
      "summary": "Add your Removals Manager exports and check that the information can be read.",
      "contentStatus": "ready",
      "keywords": [
        "upload",
        "drag",
        "drop",
        "check files",
        "validation",
        "CSV",
        "PDF"
      ],
      "toolTarget": "add-files",
      "toolLabel": "Go to Add files",
      "steps": [
        {
          "id": "upload-open-tool",
          "title": "Open the conversion tool",
          "body": "Open the main application and go to Add files.",
          "screenshot": null,
          "details": [
            "There is no separate Start a new conversion action. Opening or closing Help does not clear your current conversion."
          ]
        },
        {
          "id": "upload-select-files",
          "title": "Add your files",
          "body": "Upload the relevant Removals Manager CSV files to their corresponding fields.",
          "screenshot": null,
          "details": [
            "Use Removal invoices CSV for the main removals invoice export. Choose CSV opens the file picker; you can also drop a file into its field. A Sage Customer CSV is not supported."
          ]
        },
        {
          "id": "upload-invoice-reports",
          "title": "Add invoice reports",
          "body": "Where available, add your Monthly Invoice Report PDF or supported individual invoice PDFs.",
          "screenshot": null,
          "details": [
            "Use Monthly invoice report PDF for the report used in reconciliation. Individual invoice PDFs allows multiple files, but these are checked for file type and size only; they are not read as invoice data."
          ]
        },
        {
          "id": "upload-additional-files",
          "title": "Include additional information",
          "body": "If applicable, upload separate deposit, ad-hoc invoice or credit note files using their corresponding fields.",
          "screenshot": null,
          "details": [
            "The fields are Removal deposits CSV, Ad Hoc invoices CSV and Credit notes CSV."
          ]
        },
        {
          "id": "upload-run-checks",
          "title": "Check your files",
          "body": "Select Check files to start the application's file checking process.",
          "screenshot": null
        },
        {
          "id": "upload-review-results",
          "title": "Review the results",
          "body": "Read any warnings or validation messages before moving on.",
          "screenshot": null
        }
      ],
      "callouts": [
        {
          "type": "note",
          "title": "Choose the files relevant to your work",
          "body": "Not every upload field is required. The files needed depend on the information you want to process and the current application's validation rules."
        },
        {
          "type": "important",
          "title": "File limits and processing",
          "body": "CSV fields accept one .csv file each; PDF fields accept .pdf files, with multiple files allowed only in Individual invoice PDFs. Files must not be empty and must be no larger than 20 MB each. At least one supported invoice CSV is needed to produce invoice rows."
        }
      ],
      "relatedGuideIds": [
        "before-you-start",
        "check-import-reconciliation",
        "faq-upload-problem"
      ]
    },
    {
      "id": "check-import-reconciliation",
      "categoryId": "using-conversion-tool",
      "title": "Check your import and reconciliation",
      "summary": "Understand the results of your file checks and identify differences.",
      "contentStatus": "ready",
      "introduction": "After checking your files, review the information that the tool has identified.",
      "keywords": [
        "reconciliation",
        "mismatch",
        "VAT",
        "totals",
        "duplicates",
        "deposit",
        "credit notes"
      ],
      "toolTarget": "check-import",
      "toolLabel": "Go to Check the import",
      "steps": [
        {
          "id": "check-summary",
          "title": "Review the summary",
          "body": "Check the results for missing information, warnings or differences.",
          "screenshot": null,
          "details": [
            "Read Total rows, Import candidates, Excluded storage, Needs review and Duplicate warnings in Check the import."
          ]
        },
        {
          "id": "check-differences",
          "title": "Check invoice values",
          "body": "Compare the relevant invoice totals and VAT figures against your Removals Manager reports.",
          "screenshot": null,
          "details": [
            "In Reconciliation, compare CSV total with Report total. Add an invoice CSV and either paste the monthly report table or upload its PDF. Pasted reports have no separate VAT column, so CSV VAT is retained and is not checked against the pasted report. PDF VAT is compared where supplied. Individual invoice PDFs do not supply these comparison figures."
          ]
        },
        {
          "id": "check-deposits-adjustments",
          "title": "Review deposits and adjustments",
          "body": "Check that deposits, credit notes and any additional transactions have been handled appropriately.",
          "screenshot": null,
          "details": [
            "Deposits, possible duplicates and overlaps require review. Storage rows remain excluded. Credit note CSVs can be checked, but the tool does not create Sage credit notes or turn negative amounts into sales invoice drafts."
          ]
        },
        {
          "id": "check-resolve-differences",
          "title": "Resolve any differences",
          "body": "Investigate warnings or unexpected amounts before proceeding.",
          "screenshot": null
        },
        {
          "id": "check-continue",
          "title": "Continue when ready",
          "body": "Move on once the displayed results are consistent with your source information.",
          "screenshot": null
        }
      ],
      "callouts": [
        {
          "type": "important",
          "title": "A file check is not approval",
          "body": "Do not assume that a successful file check means the invoices reconcile. Read the status and warnings for each invoice; differences and missing records still need investigation."
        }
      ],
      "relatedGuideIds": [
        "supporting-pdf-reports",
        "review-save-batch",
        "faq-totals-mismatch"
      ]
    },
    {
      "id": "review-save-batch",
      "categoryId": "using-conversion-tool",
      "title": "Review transactions and save your batch",
      "summary": "Review the imported transactions and prepare them for Sage.",
      "contentStatus": "ready",
      "keywords": [
        "include",
        "exclude",
        "filter",
        "save",
        "batch",
        "storage",
        "review",
        "reopen",
        "edit"
      ],
      "toolTarget": "review-transactions",
      "toolLabel": "Go to Review transactions",
      "steps": [
        {
          "id": "review-open",
          "title": "Open transaction review",
          "body": "Continue to Review transactions.",
          "screenshot": null
        },
        {
          "id": "review-decisions",
          "title": "Review invoice information",
          "body": "Check customer details, dates, descriptions, amounts and VAT information.",
          "screenshot": null,
          "details": [
            "Use Include, Exclude or Review needed where a review action is available. You cannot directly edit invoice amounts, dates or descriptions in this table; correct the source export if those values are wrong."
          ]
        },
        {
          "id": "review-warnings",
          "title": "Investigate warnings",
          "body": "Resolve outstanding problems wherever possible.",
          "screenshot": null
        },
        {
          "id": "review-save",
          "title": "Save your batch",
          "body": "Select Save reviewed batch when your transactions are ready.",
          "screenshot": null,
          "details": [
            "Wait for the save confirmation before preparing drafts. Export review CSV provides a copy of the review if needed. Saving records the reviewed data; it does not create invoices in Sage."
          ]
        },
        {
          "id": "review-sage-setup",
          "title": "Continue to Sage setup",
          "body": "Go to Set up Sage conversion to configure the next stage.",
          "screenshot": null
        }
      ],
      "callouts": [
        {
          "type": "important",
          "title": "Check the active filter",
          "body": "Bulk actions affect only the visible rows under the selected filter. Check the filter before using Include all visible, Exclude all visible or Mark all for review. Storage rows remain excluded."
        },
        {
          "type": "note",
          "title": "Saved batches and editing",
          "body": "There is no saved-batch browsing or general reopen screen. Saved rows are locked for draft safety. The tool can recognise a matching re-upload and reconnect it to a saved batch; if Refresh saved batch details appears, it refreshes eligible customer and review details from the current upload. Keep your original exports."
        }
      ],
      "relatedGuideIds": [
        "check-import-reconciliation",
        "sage-mappings-customers",
        "resolve-blocked-actions"
      ]
    },
    {
      "id": "sage-mappings-customers",
      "categoryId": "sage-setup-invoices",
      "title": "Configure Sage and match customers",
      "summary": "Set up your Sage conversion and check customer matches.",
      "contentStatus": "ready",
      "introduction": "Before creating invoices, the tool needs to identify the correct Sage customer records.",
      "keywords": [
        "sage",
        "setup",
        "VAT",
        "nominal",
        "category",
        "contacts",
        "customers",
        "addresses"
      ],
      "toolTarget": "sage-conversion",
      "toolLabel": "Go to Set up Sage conversion",
      "steps": [
        {
          "id": "sage-open-setup",
          "title": "Open Sage setup",
          "body": "Continue to Set up Sage conversion and the Customer matching section.",
          "screenshot": null
        },
        {
          "id": "sage-reference-mappings",
          "title": "Configure your settings",
          "body": "Check the Sage connection and conversion settings required by the application.",
          "screenshot": null,
          "details": [
            "Confirm the connected business name in Sage connection. In VAT conversion and Nominal code conversion, choose the equivalent Sage options and use Save VAT choice and Save category choice. Use Refresh Sage options after changing VAT settings or categories in Sage."
          ]
        },
        {
          "id": "sage-customer-matches",
          "title": "Review customer matches",
          "body": "Check that customers imported from Removals Manager are matched to the correct Sage records.",
          "screenshot": null,
          "details": [
            "Use Search Sage contacts, select the correct existing contact, then select Save contact. Suggested matches are not accepted automatically. Saved matches can be reviewed using Change contact."
          ]
        },
        {
          "id": "sage-unmatched-customers",
          "title": "Resolve unmatched customers",
          "body": "Review any unmatched or uncertain customer information.",
          "screenshot": null,
          "details": [
            "Check the source report and search again before saving a match. Where the tool offers Create with TEST details, it creates a customer only after confirmation and uses temporary TEST address details. Complete those details in Sage before sending an invoice. The tool does not import a Sage Customer CSV."
          ]
        },
        {
          "id": "sage-check-configuration",
          "title": "Check your configuration",
          "body": "Make sure the customer mapping and relevant invoice settings are correct before continuing.",
          "screenshot": null
        }
      ],
      "callouts": [
        {
          "type": "important",
          "title": "Confirm the business and customer",
          "body": "Do not accept a customer match just because its name is similar. Check that both the connected Sage business and the selected customer are correct."
        }
      ],
      "relatedGuideIds": [
        "before-you-start",
        "create-sage-drafts",
        "faq-missing-customers"
      ]
    },
    {
      "id": "create-sage-drafts",
      "categoryId": "sage-setup-invoices",
      "title": "Check and create Sage draft invoices",
      "summary": "Perform your final checks and create draft invoices in Sage.",
      "contentStatus": "ready",
      "keywords": [
        "sage",
        "invoices",
        "drafts",
        "confirmation",
        "ready",
        "send",
        "email"
      ],
      "toolTarget": "draftInvoiceSection",
      "toolLabel": "Go to Create Sage draft invoices",
      "steps": [
        {
          "id": "draft-open-final-checks",
          "title": "Open the final checks",
          "body": "Continue to Create Sage draft invoices.",
          "screenshot": null,
          "details": [
            "Save the reviewed batch first, complete the Sage matches and select one or more Sage-ready invoices."
          ]
        },
        {
          "id": "draft-select-check",
          "title": "Review the invoice information",
          "body": "Check customers, invoice dates, line descriptions, amounts and VAT codes.",
          "screenshot": null,
          "details": [
            "Check each selected due date, then select Check selected draft details. The button includes the number selected. Review each preview, including its VAT rate, category and totals."
          ]
        },
        {
          "id": "draft-review-warnings",
          "title": "Check for warnings",
          "body": "Read and resolve any outstanding errors or warnings.",
          "screenshot": null,
          "details": [
            "After changing a selection or due date, check the draft details again. If a result is uncertain, check Sage before trying to create the same invoice again."
          ]
        },
        {
          "id": "draft-confirm-create",
          "title": "Create your draft invoices",
          "body": "When you are satisfied, use the application's action to create the draft invoices in Sage.",
          "screenshot": null,
          "details": [
            "Tick the confirmation box, select the enabled Create button showing the number of drafts, and confirm the prompt. For one selected invoice the button reads Create 1 draft in Sage."
          ]
        },
        {
          "id": "draft-review-sage",
          "title": "Review your Sage drafts",
          "body": "Open Sage and check that the draft invoices have been created correctly.",
          "screenshot": null
        }
      ],
      "callouts": [
        {
          "type": "important",
          "title": "Check before issuing",
          "body": "Draft invoices should be checked before they are finalised, issued or sent to customers. The tool creates editable drafts; it does not send, release or publish invoices."
        }
      ],
      "relatedGuideIds": [
        "sage-mappings-customers",
        "faq-draft-send",
        "resolve-blocked-actions"
      ]
    },
    {
      "id": "faq-which-files",
      "categoryId": "troubleshooting-faqs",
      "title": "Which Removals Manager files do I need?",
      "summary": "Choose the exports relevant to the invoices you are converting.",
      "contentStatus": "ready",
      "answer": "Start with the exports relevant to the invoices you are converting. The Files you'll need guide explains what each file is used for and which uploads are required or optional.",
      "keywords": [
        "required",
        "optional",
        "files",
        "CSV",
        "PDF"
      ],
      "steps": [],
      "relatedGuideIds": [
        "before-you-start",
        "upload-and-check-files"
      ],
      "toolTarget": "add-files",
      "toolLabel": "Go to Add files"
    },
    {
      "id": "faq-upload-problem",
      "categoryId": "troubleshooting-faqs",
      "title": "My file will not upload. What should I check?",
      "summary": "Check file types, downloads and the upload limits.",
      "contentStatus": "ready",
      "answer": "Check that you have selected the correct file type and export. Make sure the file has downloaded completely and that it has not been renamed with the wrong extension. Use .csv for CSV fields and .pdf for PDF fields. Files must not be empty or exceed 20 MB each. A Sage Customer CSV is not a supported invoice upload.",
      "keywords": [
        "upload",
        "error",
        "extension",
        "size",
        "20 MB"
      ],
      "steps": [],
      "relatedGuideIds": [
        "before-you-start",
        "upload-and-check-files"
      ],
      "toolTarget": "add-files",
      "toolLabel": "Go to Add files"
    },
    {
      "id": "faq-missing-customers",
      "categoryId": "troubleshooting-faqs",
      "title": "Why are some customer details missing?",
      "summary": "Understand where customer names come from and how addresses are handled.",
      "contentStatus": "ready",
      "answer": "The invoice export may not contain every customer detail. This version reads customer names from the Monthly invoice report PDF where possible and lets you confirm existing Sage contacts in Customer matching. It does not import a Sage Customer CSV or use it to fill addresses. Any customer created using Create with TEST details has temporary address details that must be completed in Sage.",
      "keywords": [
        "customer",
        "addresses",
        "missing",
        "TEST",
        "Sage Customer CSV"
      ],
      "steps": [],
      "relatedGuideIds": [
        "before-you-start",
        "sage-mappings-customers",
        "export-sage-customer-csv"
      ],
      "toolTarget": "sage-conversion",
      "toolLabel": "Go to Customer matching"
    },
    {
      "id": "faq-totals-mismatch",
      "categoryId": "troubleshooting-faqs",
      "title": "Why do invoice totals not match?",
      "summary": "Check the reporting period, deposits and adjustments.",
      "contentStatus": "ready",
      "answer": "Check the reporting dates and whether deposits, additional invoices or credit notes have been included. Review any reconciliation warnings before proceeding.",
      "keywords": [
        "totals",
        "mismatch",
        "VAT",
        "deposit",
        "credit notes"
      ],
      "steps": [],
      "relatedGuideIds": [
        "check-import-reconciliation",
        "supporting-pdf-reports"
      ],
      "toolTarget": "reconciliation",
      "toolLabel": "Go to Reconciliation"
    },
    {
      "id": "faq-reporting-dates",
      "categoryId": "troubleshooting-faqs",
      "title": "Can I change the reporting dates?",
      "summary": "Use new source exports when you need a different reporting period.",
      "contentStatus": "ready",
      "answer": "You can use new exports for a different reporting period. The conversion tool reads the dates in your files; it does not provide a date-range filter to change which invoices are imported. The From and To controls described in the draft Removals Manager export guides still need checking in that application. Keep the current conversion's source files and review before replacing uploads.",
      "keywords": [
        "dates",
        "From",
        "To",
        "month",
        "period",
        "range"
      ],
      "steps": [],
      "relatedGuideIds": [
        "supporting-pdf-reports",
        "choose-csv-exports",
        "upload-and-check-files"
      ],
      "toolTarget": "add-files",
      "toolLabel": "Go to Add files"
    },
    {
      "id": "faq-draft-send",
      "categoryId": "troubleshooting-faqs",
      "title": "Does creating a Sage draft send an invoice to the customer?",
      "summary": "Understand what the draft creation action does.",
      "contentStatus": "ready",
      "answer": "No. The tool creates editable Sage sales invoice drafts and does not send, release or publish them. Check the actual status and information in Sage before finalising or sending anything.",
      "keywords": [
        "send",
        "email",
        "draft",
        "publish",
        "finalise"
      ],
      "steps": [],
      "relatedGuideIds": [
        "create-sage-drafts"
      ],
      "toolTarget": "draftInvoiceSection",
      "toolLabel": "Go to Create Sage draft invoices"
    },
    {
      "id": "resolve-blocked-actions",
      "categoryId": "troubleshooting-faqs",
      "title": "What should I do if I find an error?",
      "summary": "Review the warning and compare it with your original source records.",
      "contentStatus": "ready",
      "answer": "Review the warning and compare the relevant information with your original Removals Manager export. Correct the source information or the conversion data using the supported application workflow before continuing. You can change available review decisions and Sage matches, but cannot directly edit invoice amounts or descriptions in the tool. Saved review rows are locked for draft safety; there is no general saved-batch edit screen.",
      "keywords": [
        "disabled",
        "blocked",
        "error",
        "cannot",
        "warnings",
        "missing",
        "edit"
      ],
      "steps": [],
      "relatedGuideIds": [
        "check-import-reconciliation",
        "review-save-batch",
        "sage-mappings-customers"
      ],
      "toolTarget": "check-import",
      "toolLabel": "Go to Check the import"
    },
    {
      "id": "files-session-currency",
      "categoryId": "troubleshooting-faqs",
      "title": "Files, progress and display currency",
      "summary": "How Help, uploaded files and currency labels affect your current session.",
      "contentStatus": "ready",
      "keywords": [
        "privacy",
        "storage",
        "reload",
        "progress",
        "currency",
        "GBP",
        "EUR",
        "USD"
      ],
      "relatedGuideIds": [
        "before-you-start",
        "review-save-batch"
      ],
      "steps": [
        {
          "id": "session-keep-originals",
          "title": "Keep your original files",
          "body": "Uploads are not stored permanently. Saved reviewed batches contain reviewed records and metadata. Reloading or leaving the page clears selected files.",
          "screenshot": null
        },
        {
          "id": "session-help-currency",
          "title": "Use Help without leaving the tool",
          "body": "Opening and closing Help keeps the current conversion session in place. Display currency changes labels only and does not apply exchange rates.",
          "screenshot": null
        }
      ]
    }
  ]
};
