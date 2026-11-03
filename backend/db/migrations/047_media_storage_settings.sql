-- Credentials and historical read profiles never live in plaintext.
CREATE TABLE IF NOT EXISTS media_storage_settings (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    revision bigint NOT NULL DEFAULT 1,
    encrypted_config text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
