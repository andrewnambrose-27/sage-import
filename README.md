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

For Cloudflare Workers, add the password as a Worker secret:

```bash
npx wrangler secret put APP_ACCESS_PASSWORD
```

Then deploy:

```bash
npm run deploy
```

If this is deployed on Vercel instead, add an environment variable named `APP_ACCESS_PASSWORD` in the Vercel project settings before deploying.

## Cloudflare Pages Live Check

If this repository is connected to Cloudflare Pages as a static site, use:

- Framework preset: `None`
- Build command: leave blank
- Build output directory: `/`

The root `index.html` file is a simple live-check page for confirming that `sage-import.27tools.co` is serving the repository.

## Important MVP Notes

- Do not commit real Removals Manager CSV exports. `*.csv` is ignored by git.
- Uploaded files are not sent to the Worker in this version.
- Uploads are optional at this stage, so missing files are shown as optional rather than blocking.
- CSV files are processed in memory only and are not stored permanently.
- PDF files are validated for type and size but are not parsed yet.
- Sage API/import integration is intentionally not included yet.
