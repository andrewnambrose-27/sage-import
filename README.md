# Sage Import Checker

Private MVP for checking old Removals Manager CSV exports before they are prepared for Sage Business Cloud.

This version can connect to Sage Business Cloud Accounting and, after a separate review, create one sales invoice draft at a time. It never creates contacts, sends invoices, releases/publishes invoices, creates credit notes, or runs a batch import. CSV exports are parsed in memory, normalised for review, and shown in a preview table with row-level warnings. Reviewed normalized records can be saved to Cloudflare D1, but uploaded CSV/PDF files are not stored permanently.

## Features

- Password-protected login screen
- `APP_ACCESS_PASSWORD` environment secret
- Signed HTTP-only session cookie
- Logout button
- Protected dashboard
- Upload fields for Removals Manager CSV exports and PDF reports
- Browser-only file validation for type and size
- CSV parsing for removals, deposits, ad hoc invoices and credit notes
- Normalised invoice numbers, dates, amounts and VAT values
- Monthly invoice report PDF text extraction and invoice-level reconciliation
- Customer names and service types matched from the monthly PDF where possible
- Configurable transaction classification rules
- Import-candidate, storage-exclusion, duplicate, mismatch and review summaries
- Preview table with row-level warnings
- Review screen with manual include, exclude and review-needed decisions
- Optional Cloudflare D1 persistence for reviewed normalized records and metadata
- Read-only Sage Business Cloud Accounting OAuth connection status
- Read-only Sage tax-rate, ledger-account and contact lookup/mapping screens
- Sage readiness status for reviewed invoices
- One-at-a-time Sage sales invoice draft preview and creation, with explicit confirmation

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the local environment example:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

3. Edit `.dev.vars` and set a strong password:

   ```bash
   APP_ACCESS_PASSWORD=your-private-password
   ```

4. If testing Sage OAuth locally, also set:

   ```bash
   SAGE_CLIENT_ID=your-sage-client-id
   SAGE_REDIRECT_URI=http://127.0.0.1:8788/api/sage/callback
   SAGE_CLIENT_SECRET=your-sage-client-secret
   SAGE_TOKEN_ENCRYPTION_KEY=a-long-random-secret-used-only-for-token-encryption
   ```

5. Start the app:

   ```bash
   npm run dev
   ```

6. Open the local Wrangler URL and log in with the password from `.dev.vars`.

## Production Secret

For Cloudflare Pages, add these secrets:

- `APP_ACCESS_PASSWORD`
- `SAGE_CLIENT_SECRET`
- `SAGE_TOKEN_ENCRYPTION_KEY`

Add these non-secret configuration values:

- `SAGE_CLIENT_ID`
- `SAGE_REDIRECT_URI`

For production, `SAGE_REDIRECT_URI` should usually be:

```txt
https://sage-import.27tools.co/api/sage/callback
```

Add the password using Wrangler:

```bash
npx wrangler pages secret put APP_ACCESS_PASSWORD --project-name sage-import
```

Add the Sage secrets using Wrangler:

```bash
npx wrangler pages secret put SAGE_CLIENT_SECRET --project-name sage-import
npx wrangler pages secret put SAGE_TOKEN_ENCRYPTION_KEY --project-name sage-import
```

The private tool is available at `/upload`. The root `/` page is a public live-check page.

For manual deploys:

```bash
npm run deploy
```

## Cloudflare Pages Settings

Use these build settings:

- Framework preset: `None`
- Build command: leave blank
- Build output directory: `/`

The root `index.html` file is a simple live-check page for confirming that `sage-import.27tools.co` is serving the repository. Dynamic login, upload and CSV parsing routes run through Cloudflare Pages Functions in `functions/[[path]].ts`.

## Cloudflare D1 Storage

D1 is used for reviewed normalized records only. Uploaded CSV/PDF files should still not be stored permanently.

The production database is configured in `wrangler.jsonc` as the Pages D1 binding `DB`, using `sage-import-db` and the repository's `migrations/` folder. Do not create another database or add a second dashboard binding with the same name.

List outstanding production migrations:

```bash
npx wrangler d1 migrations list sage-import-db --remote
```

Apply migrations locally:

```bash
npx wrangler d1 migrations apply sage-import-db --local
```

Apply migrations remotely:

```bash
npx wrangler d1 migrations apply sage-import-db --remote
```

Confirm the applied production schema:

```bash
npx wrangler d1 migrations list sage-import-db --remote
npx wrangler d1 execute sage-import-db --remote --command "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name;"
```

For local Pages development, the `DB` binding must be available before the "Save reviewed batch" action will persist data. Without the binding, upload, parsing, reconciliation and review still work in memory.

The migrations live in `migrations/`:

- `0001_initial_d1_storage.sql`
- `0002_sage_oauth_token_nonces.sql`
- `0003_sage_reference_cache_and_mapping_context.sql`
- `0004_sage_draft_invoice_safety.sql`

They create and extend:

- `import_batches`
- `source_invoices`
- `sage_connections`
- `customer_mappings`
- `sage_reference_mappings`
- `sage_imports`

Money is stored as integer minor units, for example pence, to avoid floating-point storage errors. Sage OAuth tokens are encrypted with Web Crypto AES-GCM before they are stored in D1, and token values are never returned to the browser.

## Sage OAuth

The Sage connection is read-only at this stage. It uses Sage Business Cloud Accounting OAuth authorization code flow and the Sage Accounting API to identify the connected business. The app stores encrypted access and refresh tokens in D1 so future read-only Sage API calls can refresh access tokens server-side.

Current hard-coded Sage endpoints live in `src/sage.ts`:

- Authorization: `https://www.sageone.com/oauth2/auth/central`
- Token: `https://oauth.accounting.sage.com/token`
- Accounting API: `https://api.accounting.sage.com/v3.1`

## First Sage Draft Invoice Milestone

The draft workflow is intentionally narrow:

- Save the reviewed batch first. Saved transactions are locked before drafting.
- Select **Preview draft** beside one `ready_for_sage` invoice.
- Check the customer, Removals Manager reference, date, due date, line items, tax/ledger mappings, totals and reconciliation comparison.
- Confirm the due date and tick the one-off confirmation box before **Create one draft invoice in Sage** is enabled.

The app uses `POST /v3.1/sales_invoices` with the official Sage `sales_invoice` request wrapper. It sends `contact_id`, `date`, `due_date`, `reference`, and `invoice_lines`, each with `description`, `quantity`, `unit_price`, `ledger_account_id`, and `tax_rate_id`. It does not call any release, send, email or publish endpoint.

Before creation, the app searches Sage using the `RM inv no.<number>` reference, then reserves the source invoice in D1 using the unique `sage_imports.source_invoice_id` constraint. A confirmed Sage ID is saved as `created`. A network timeout, server error, or response without an ID is recorded as `uncertain` and is never retried automatically; check Sage first. A Sage validation rejection is recorded as `failed`.

The due date defaults to 30 days after the invoice date for the preview. Confirm or change it to the customer’s actual agreed terms before creating the draft.

## Sage Reference Mappings

The mapping screens are still read-only against Sage. They can fetch and cache safe metadata for:

- Sage tax rates
- Sage ledger accounts
- Sage contacts returned by manual search

Confirmed mappings are stored in D1. The app deliberately does not assume that a Removals Manager tax code such as `T1` maps to any particular Sage tax rate, and it does not assume that an old nominal code such as `4010` maps to any particular Sage ledger account.

An invoice is only marked `ready_for_sage` when it is included, not storage, not blocked by unresolved warnings/mismatches, has confirmed contact/tax/ledger mappings, and has not already been imported. The app still does not create Sage contacts, invoices or credit notes.

## Important MVP Notes

- Do not commit real Removals Manager CSV exports. `*.csv` is ignored by git.
- Uploaded CSV files are sent to the Worker for in-memory parsing only.
- Uploads are optional at this stage, so missing files are shown as optional rather than blocking.
- CSV files are processed in memory and are not stored permanently.
- The monthly invoice report PDF is read in memory for reconciliation only.
- Individual invoice PDFs are validated for type and size but are not parsed yet.
- Rows marked `needs_review` or `exclude_storage` are not export-eligible by default.
- The D1 save action stores normalized/reconciled row metadata, warnings and raw CSV row values for debugging, not the uploaded files.
- This milestone creates a single Sage sales invoice draft only. Contact creation, credit notes, sending/releasing, and batch import remain intentionally out of scope.
