# Sage Import Checker

Private MVP for checking old Removals Manager CSV exports before they are prepared for Sage Business Cloud.

This version does not connect to Sage. CSV exports are parsed in memory, normalised for review, and shown in a preview table with row-level warnings. Reviewed normalized records can be saved to Cloudflare D1, but uploaded CSV/PDF files are not stored permanently.

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

4. Start the app:

   ```bash
   npm run dev
   ```

5. Open the local Wrangler URL and log in with the password from `.dev.vars`.

## Production Secret

For Cloudflare Pages, add the password as an environment variable/secret named `APP_ACCESS_PASSWORD`.

Using Wrangler:

```bash
npx wrangler pages secret put APP_ACCESS_PASSWORD --project-name sage-import
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

Create the database:

```bash
npx wrangler d1 create sage-import-db
```

Add the returned database as a Pages D1 binding named `DB`. You can do this in Cloudflare Pages under **Settings > Bindings > D1 database bindings**, or by adding the returned `d1_databases` block to `wrangler.jsonc` once the real `database_id` is known.

Apply migrations locally:

```bash
npx wrangler d1 migrations apply sage-import-db --local
```

Apply migrations remotely:

```bash
npx wrangler d1 migrations apply sage-import-db --remote
```

For local Pages development, the `DB` binding must be available before the "Save reviewed batch" action will persist data. Without the binding, upload, parsing, reconciliation and review still work in memory.

The initial migration lives at `migrations/0001_initial_d1_storage.sql` and creates:

- `import_batches`
- `source_invoices`
- `sage_connections`
- `customer_mappings`
- `sage_reference_mappings`
- `sage_imports`

Money is stored as integer minor units, for example pence, to avoid floating-point storage errors. OAuth token columns are present for a later Sage integration stage, but Sage API access is not implemented yet; tokens must be encrypted before anything is written to those columns.

## Important MVP Notes

- Do not commit real Removals Manager CSV exports. `*.csv` is ignored by git.
- Uploaded CSV files are sent to the Worker for in-memory parsing only.
- Uploads are optional at this stage, so missing files are shown as optional rather than blocking.
- CSV files are processed in memory and are not stored permanently.
- The monthly invoice report PDF is read in memory for reconciliation only.
- Individual invoice PDFs are validated for type and size but are not parsed yet.
- Rows marked `needs_review` or `exclude_storage` are not export-eligible by default.
- The D1 save action stores normalized/reconciled row metadata, warnings and raw CSV row values for debugging, not the uploaded files.
- Sage API/import integration is intentionally not included yet.
