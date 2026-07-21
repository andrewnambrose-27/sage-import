-- No uploaded files are stored. This migration only strengthens audit metadata
-- for the existing one-source-invoice-to-one-Sage-import reservation model.
CREATE INDEX IF NOT EXISTS idx_sage_imports_status
  ON sage_imports(import_status);
