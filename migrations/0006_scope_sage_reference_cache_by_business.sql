ALTER TABLE sage_reference_cache ADD COLUMN sage_business_id TEXT NOT NULL DEFAULT '';

UPDATE sage_reference_cache
SET sage_business_id = COALESCE((
  SELECT sage_business_id
  FROM sage_connections
  WHERE disconnected_at IS NULL
  ORDER BY connected_at DESC
  LIMIT 1
), '')
WHERE sage_business_id = '';

DROP INDEX IF EXISTS idx_sage_reference_cache_dedupe;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sage_reference_cache_business_dedupe
  ON sage_reference_cache(sage_business_id, reference_type, sage_entity_id);

DROP INDEX IF EXISTS idx_sage_reference_cache_type;
CREATE INDEX IF NOT EXISTS idx_sage_reference_cache_business_type
  ON sage_reference_cache(sage_business_id, reference_type);
