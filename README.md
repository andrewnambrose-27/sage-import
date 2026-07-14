# Sage Import Checker

Private MVP for checking old Removals Manager CSV exports before they are prepared for Sage Business Cloud.

This first version does not connect to Sage and does not permanently store uploaded customer data. CSV exports are parsed in memory, normalised for review, and shown in a preview table with row-level warnings.

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

## Important MVP Notes

- Do not commit real Removals Manager CSV exports. `*.csv` is ignored by git.
- Uploaded files are not sent to the Worker in this version.
- Uploads are optional at this stage, so missing files are shown as optional rather than blocking.
- CSV files are processed in memory only and are not stored permanently.
- The monthly invoice report PDF is read in memory for reconciliation only.
- Individual invoice PDFs are validated for type and size but are not parsed yet.
- Rows marked `needs_review` or `exclude_storage` are not export-eligible by default.
- Sage API/import integration is intentionally not included yet.
