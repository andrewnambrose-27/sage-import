ALTER TABLE sage_reference_mappings ADD COLUMN sage_business_id TEXT NOT NULL DEFAULT '';
ALTER TABLE customer_mappings ADD COLUMN sage_business_id TEXT NOT NULL DEFAULT '';

UPDATE sage_reference_mappings
SET sage_business_id = COALESCE((
  SELECT sage_business_id
  FROM sage_connections
  WHERE disconnected_at IS NULL
  ORDER BY connected_at DESC
  LIMIT 1
), '')
WHERE sage_business_id = '';

UPDATE customer_mappings
SET sage_business_id = COALESCE((
  SELECT sage_business_id
  FROM sage_connections
  WHERE disconnected_at IS NULL
  ORDER BY connected_at DESC
  LIMIT 1
), '')
WHERE sage_business_id = '';

DROP INDEX IF EXISTS idx_sage_reference_mappings_dedupe;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sage_reference_mappings_business_dedupe
  ON sage_reference_mappings(sage_business_id, mapping_type, source_code, source_context);

DROP INDEX IF EXISTS idx_customer_mappings_dedupe;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_mappings_business_dedupe
  ON customer_mappings(sage_business_id, normalized_customer_name, COALESCE(customer_email, ''), COALESCE(postcode, ''));
