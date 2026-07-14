PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  reporting_month TEXT,
  original_file_names TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reviewed', 'saved', 'sage_pending', 'sage_created', 'failed')),
  invoice_count INTEGER NOT NULL DEFAULT 0,
  import_candidate_count INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS source_invoices (
  id TEXT PRIMARY KEY,
  import_batch_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('removal', 'deposit', 'ad_hoc', 'credit_note')),
  rm_invoice_number TEXT,
  rm_job_id TEXT,
  customer_name TEXT,
  normalized_customer_name TEXT,
  invoice_date TEXT,
  description TEXT NOT NULL,
  net_amount_minor INTEGER,
  vat_amount_minor INTEGER,
  gross_amount_minor INTEGER,
  rm_tax_code TEXT,
  rm_nominal_code TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('import_candidate', 'exclude_storage', 'needs_review', 'possible_duplicate', 'possible_storage_credit', 'missing_customer', 'amount_mismatch', 'vat_mismatch')),
  review_decision TEXT NOT NULL CHECK (review_decision IN ('include', 'exclude', 'review')),
  warnings_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  raw_source_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_invoices_source_hash
  ON source_invoices(source_hash);

CREATE INDEX IF NOT EXISTS idx_source_invoices_import_batch_id
  ON source_invoices(import_batch_id);

CREATE INDEX IF NOT EXISTS idx_source_invoices_rm_invoice_number
  ON source_invoices(rm_invoice_number);

CREATE TABLE IF NOT EXISTS sage_connections (
  id TEXT PRIMARY KEY,
  sage_business_id TEXT NOT NULL,
  sage_business_name TEXT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  encryption_nonce TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  last_refreshed_at TEXT,
  connected_at TEXT NOT NULL,
  disconnected_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sage_connections_business_id
  ON sage_connections(sage_business_id);

CREATE TABLE IF NOT EXISTS customer_mappings (
  id TEXT PRIMARY KEY,
  normalized_customer_name TEXT NOT NULL,
  customer_email TEXT,
  postcode TEXT,
  sage_contact_id TEXT NOT NULL,
  sage_contact_display_name TEXT NOT NULL,
  manually_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (manually_confirmed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_mappings_dedupe
  ON customer_mappings(normalized_customer_name, COALESCE(customer_email, ''), COALESCE(postcode, ''));

CREATE TABLE IF NOT EXISTS sage_reference_mappings (
  id TEXT PRIMARY KEY,
  mapping_type TEXT NOT NULL CHECK (mapping_type IN ('tax_rate', 'ledger_account')),
  source_code TEXT NOT NULL,
  sage_entity_id TEXT NOT NULL,
  sage_display_name TEXT NOT NULL,
  manually_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (manually_confirmed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sage_reference_mappings_dedupe
  ON sage_reference_mappings(mapping_type, source_code);

CREATE TABLE IF NOT EXISTS sage_imports (
  id TEXT PRIMARY KEY,
  source_invoice_id TEXT NOT NULL,
  sage_contact_id TEXT,
  sage_invoice_id TEXT,
  import_status TEXT NOT NULL CHECK (import_status IN ('pending', 'created', 'failed', 'uncertain', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  safe_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_invoice_id) REFERENCES source_invoices(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sage_imports_source_invoice_id
  ON sage_imports(source_invoice_id);
