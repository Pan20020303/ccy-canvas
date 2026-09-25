-- H3 and H3 Max are separate HopBase groups and may require different keys.
-- Leave both channels disabled until their keys are set and GET /v1/models
-- confirms model access. No existing provider is modified.
INSERT INTO provider_configs (
    service_type, vendor, name, api_spec, protocol, base_url,
    encrypted_api_key, submit_endpoint, query_endpoint,
    model_list, default_model, priority, is_default, status, capabilities,
    parameter_schema, adapter_runtime, icon_key
)
SELECT
    'video', 'HopBase', 'HopBase · MiniMax H3', 'custom', 'native',
    'https://api.hop-base.com', '',
    '/v1/video/generate', '/v1/video/tasks/{taskId}',
    ARRAY['MiniMax-H3'], 'MiniMax-H3', 4, false, 'disabled', ARRAY['video'],
    '{
      "allowed_parameters": ["model", "content", "resolution", "duration", "ratio", "aigc_watermark"],
      "resolution_options": ["768P", "2K"],
      "aspect_ratio_options": ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      "supports_resolution": true,
      "supports_aspect_ratio": true,
      "supports_auto_aspect": false,
      "supports_duration": true,
      "defaults": {"resolution": "768P", "duration": 5, "aspect_ratio": "16:9"},
      "vendor_models": [{"modelName": "MiniMax-H3", "name": "MiniMax H3", "type": "video"}]
    }'::jsonb,
    'go', 'minimax'
WHERE NOT EXISTS (
    SELECT 1 FROM provider_configs
    WHERE vendor = 'HopBase' AND service_type = 'video' AND 'MiniMax-H3' = ANY(model_list)
);

INSERT INTO provider_configs (
    service_type, vendor, name, api_spec, protocol, base_url,
    encrypted_api_key, submit_endpoint, query_endpoint,
    model_list, default_model, priority, is_default, status, capabilities,
    parameter_schema, adapter_runtime, icon_key
)
SELECT
    'video', 'HopBase', 'HopBase · MiniMax H3 Max', 'custom', 'native',
    'https://api.hop-base.com', '',
    '/v1/video/generate', '/v1/video/tasks/{taskId}',
    ARRAY['MiniMax-H3-Max'], 'MiniMax-H3-Max', 4, false, 'disabled', ARRAY['video'],
    '{
      "allowed_parameters": ["model", "content", "resolution", "duration", "ratio", "aigc_watermark"],
      "resolution_options": ["480P", "768P"],
      "aspect_ratio_options": ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      "supports_resolution": true,
      "supports_aspect_ratio": true,
      "supports_auto_aspect": false,
      "supports_duration": true,
      "defaults": {"resolution": "768P", "duration": 5, "aspect_ratio": "16:9"},
      "vendor_models": [{"modelName": "MiniMax-H3-Max", "name": "MiniMax H3 Max", "type": "video"}]
    }'::jsonb,
    'go', 'minimax'
WHERE NOT EXISTS (
    SELECT 1 FROM provider_configs
    WHERE vendor = 'HopBase' AND service_type = 'video' AND 'MiniMax-H3-Max' = ANY(model_list)
);
