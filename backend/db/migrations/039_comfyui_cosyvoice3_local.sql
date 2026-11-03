INSERT INTO provider_configs (
    service_type, vendor, name, api_spec, protocol, base_url,
    submit_endpoint, query_endpoint, model_list, default_model,
    priority, is_default, status, capabilities, parameter_schema,
    adapter_runtime, icon_key
)
SELECT
    'audio', 'ComfyUI', '本地 CosyVoice3 语音克隆', 'custom', 'native',
    'http://127.0.0.1:8188', '/prompt', '/history/{taskId}',
    ARRAY['cosyvoice3-local'], 'cosyvoice3-local',
    10, false, 'enabled', ARRAY['audio'],
    '{
      "models": {
        "cosyvoice3-local": {
          "allowed_parameters": ["model", "prompt", "reference_audio", "speed", "seed"],
          "default_params": {"speed": 1.0},
          "reference_audio_min": 1,
          "reference_audio_max": 1
        }
      },
      "credit_cost": 1
    }'::jsonb,
    'go', 'comfyui'
WHERE NOT EXISTS (
    SELECT 1 FROM provider_configs
    WHERE vendor = 'ComfyUI'
      AND 'cosyvoice3-local' = ANY(model_list)
);
