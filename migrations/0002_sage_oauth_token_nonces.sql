ALTER TABLE sage_connections ADD COLUMN access_token_nonce TEXT NOT NULL DEFAULT '';
ALTER TABLE sage_connections ADD COLUMN refresh_token_nonce TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_sage_connections_active
  ON sage_connections(disconnected_at);
