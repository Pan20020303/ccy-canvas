INSERT INTO provider_configs (
    service_type, vendor, name, api_spec, protocol, base_url,
    submit_endpoint, query_endpoint, model_list, default_model,
    priority, is_default, status, capabilities, parameter_schema,
    adapter_runtime, icon_key
)
SELECT
    'audio', 'ComfyUI', '本地 Stable Audio 3 文生音效', 'custom', 'native',
    'http://127.0.0.1:8188', '/prompt', '/history/{taskId}',
    ARRAY['stable-audio-3-small-sfx-local'], 'stable-audio-3-small-sfx-local',
    11, false, 'enabled', ARRAY['audio'],
    '{
      "models": {
        "stable-audio-3-small-sfx-local": {
          "allowed_parameters": ["model", "prompt", "duration", "seed"],
          "default_params": {"duration": 10},
          "supports_duration": true,
          "duration_min": 1,
          "duration_max": 47,
          "reference_audio_min": 0,
          "reference_audio_max": 0
        }
      },
      "vendor_models": [
        {"modelName": "stable-audio-3-small-sfx-local", "name": "描述生成音效 · Stable Audio 3", "type": "audio"}
      ],
      "credit_cost": 1
    }'::jsonb,
    'go', 'comfyui'
WHERE NOT EXISTS (
    SELECT 1 FROM provider_configs
    WHERE vendor = 'ComfyUI'
      AND 'stable-audio-3-small-sfx-local' = ANY(model_list)
);

UPDATE provider_configs
SET parameter_schema = jsonb_set(
    COALESCE(parameter_schema, '{}'::jsonb),
    '{vendor_models}',
    '[{"modelName":"cosyvoice3-local","name":"音色复刻 · CosyVoice3","type":"audio"}]'::jsonb,
    true
)
WHERE vendor = 'ComfyUI'
  AND 'cosyvoice3-local' = ANY(model_list);

UPDATE provider_configs
SET parameter_schema = jsonb_set(
    COALESCE(parameter_schema, '{}'::jsonb),
    '{vendor_models}',
    '[{"modelName":"stable-audio-3-small-sfx-local","name":"描述生成音效 · Stable Audio 3","type":"audio"}]'::jsonb,
    true
)
WHERE vendor = 'ComfyUI'
  AND 'stable-audio-3-small-sfx-local' = ANY(model_list);
