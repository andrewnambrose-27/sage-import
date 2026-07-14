CREATE TABLE IF NOT EXISTS sage_reference_cache (
  id TEXT PRIMARY KEY,
  reference_type TEXT NOT NULL CHECK (reference_type IN ('tax_rate', 'ledger_account')),
  sage_entity_id TEXT NOT NULL,
  source_code TEXT,
  sage_display_name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  raw_reference_json TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sage_reference_cache_dedupe
  ON sage_reference_cache(reference_type, sage_entity_id);

CREATE INDEX IF NOT EXISTS idx_sage_reference_cache_type
  ON sage_reference_cache(reference_type);

ALTER TABLE sage_reference_mappings ADD COLUMN source_context TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS idx_sage_reference_mappings_dedupe;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sage_reference_mappings_dedupe
  ON sage_reference_mappings(mapping_type, source_code, source_context);
