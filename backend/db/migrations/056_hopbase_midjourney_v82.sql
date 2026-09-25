-- Midjourney has its own HopBase plan group. The user supplies its key in admin.
INSERT INTO provider_configs (
    service_type, vendor, name, api_spec, protocol, base_url,
    encrypted_api_key, submit_endpoint, query_endpoint,
    model_list, default_model, priority, is_default, status, capabilities,
    parameter_schema, adapter_runtime, icon_key
)
SELECT
    'image', 'HopBase', 'HopBase · Midjourney 8.2', 'custom', 'native',
    'https://api.hop-base.com', '', '/v1/images/generations', '/v1/video/tasks/{taskId}',
    ARRAY['midjourney-v8-2'], 'midjourney-v8-2', 4, false, 'disabled', ARRAY['image'],
    '{
      "allowed_parameters": ["model", "prompt", "images", "n"],
      "supports_resolution": true,
      "resolution_options": ["1K", "2K"],
      "supports_aspect_ratio": true,
      "supports_auto_aspect": false,
      "aspect_ratio_options": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"],
      "supports_quality": false,
      "supports_output_format": false,
      "defaults": {"resolution": "1K", "aspect_ratio": "1:1", "n": 4},
      "vendor_models": [{"modelName": "midjourney-v8-2", "name": "Midjourney 8.2", "type": "image"}]
    }'::jsonb, 'go', 'midjourney'
WHERE NOT EXISTS (
    SELECT 1 FROM provider_configs
    WHERE vendor = 'HopBase' AND service_type = 'image' AND 'midjourney-v8-2' = ANY(model_list)
);
