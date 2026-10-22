-- Provider configs: multi-vendor model configuration
-- Each row = one vendor entry shown in the admin table (图1)
CREATE TABLE provider_configs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_type     VARCHAR(32)  NOT NULL CHECK (service_type IN ('text', 'image', 'video', 'audio')),
    vendor           VARCHAR(64)  NOT NULL,      -- OpenAI / Runway / Luma / 自定义
    name             VARCHAR(128) NOT NULL,       -- display name (e.g. "OpenAI Sora")
    api_spec         VARCHAR(32)  NOT NULL DEFAULT 'openai',  -- openai / custom
    base_url         VARCHAR(512) NOT NULL DEFAULT '',
    encrypted_api_key TEXT        NOT NULL DEFAULT '',
    submit_endpoint  VARCHAR(256) NOT NULL DEFAULT '',   -- video: e.g. /v1/videos/generations
    query_endpoint   VARCHAR(256) NOT NULL DEFAULT '',   -- video: e.g. /v1/videos/tasks/{taskId}
    model_list       TEXT[]       NOT NULL DEFAULT '{}',  -- available models
    default_model    VARCHAR(128) NOT NULL DEFAULT '',
    priority         INT          NOT NULL DEFAULT 0,
    is_default       BOOLEAN      NOT NULL DEFAULT false,
    status           VARCHAR(16)  NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX provider_configs_type_status_idx ON provider_configs(service_type, status, priority);
