INSERT INTO provider_configs (
    service_type, vendor, name, api_spec, protocol, base_url,
    submit_endpoint, query_endpoint, model_list, default_model,
    priority, is_default, status, capabilities, parameter_schema,
    adapter_runtime, icon_key
)
SELECT
    'video', 'ComfyUI', '本地 MiniMax H3 九图 Ref2V Turbo', 'custom', 'native',
    'http://127.0.0.1:8188', '/prompt', '/history/{taskId}',
    ARRAY['minimax-h3-t2v-ref2v-turbo-local'], 'minimax-h3-t2v-ref2v-turbo-local',
    10, false, 'enabled', ARRAY['video'],
    '{
      "models": {
        "minimax-h3-t2v-ref2v-turbo-local": {
          "supports_resolution": true,
          "resolution_options": ["480p", "768p"],
          "supports_aspect_ratio": true,
          "aspect_ratio_options": ["16:9", "9:16", "1:1"],
          "supports_duration": true,
          "default_params": {"resolution": "480p", "aspect_ratio": "16:9"}
        }
      },
      "credit_cost": 1
    }'::jsonb,
    'go', 'comfyui'
WHERE NOT EXISTS (
    SELECT 1 FROM provider_configs
    WHERE vendor = 'ComfyUI'
      AND 'minimax-h3-t2v-ref2v-turbo-local' = ANY(model_list)
);
