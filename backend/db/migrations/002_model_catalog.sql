CREATE TABLE relay_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'default',
  provider_type text NOT NULL DEFAULT 'newapi_openai_compatible',
  base_url text NOT NULL DEFAULT '',
  encrypted_api_key text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES relay_providers(id),
  external_model_name text NOT NULL,
  display_name text NOT NULL,
  capability text NOT NULL CHECK (capability IN ('text', 'image', 'video', 'audio')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'enabled', 'disabled')),
  parameter_schema jsonb NOT NULL DEFAULT '{}',
  default_parameters jsonb NOT NULL DEFAULT '{}',
  pricing_rule jsonb NOT NULL DEFAULT '{}',
  cost_snapshot jsonb NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, external_model_name)
);

CREATE TABLE model_permission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES model_definitions(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  role text,
  allowed boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX model_definitions_status_idx ON model_definitions(status, sort_order);
CREATE INDEX model_permission_rules_model_idx ON model_permission_rules(model_id);
