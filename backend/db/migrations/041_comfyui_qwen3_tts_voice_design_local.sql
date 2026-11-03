INSERT INTO provider_configs (
    service_type, vendor, name, api_spec, protocol, base_url,
    submit_endpoint, query_endpoint, model_list, default_model,
    priority, is_default, status, capabilities, parameter_schema,
    adapter_runtime, icon_key
)
SELECT
    'audio', 'ComfyUI', '本地 Qwen3-TTS 描述音色说话', 'custom', 'native',
    'http://127.0.0.1:8188', '/prompt', '/history/{taskId}',
    ARRAY['qwen3-tts-voice-design-local'], 'qwen3-tts-voice-design-local',
    12, false, 'enabled', ARRAY['audio'],
    '{
      "models": {
        "qwen3-tts-voice-design-local": {
          "allowed_parameters": ["model", "prompt", "voice_description", "language", "temperature", "top_p", "seed"],
          "default_params": {"language": "Auto", "temperature": 0.9, "top_p": 0.95},
          "reference_audio_min": 0,
          "reference_audio_max": 0
        }
      },
      "vendor_models": [
        {"modelName": "qwen3-tts-voice-design-local", "name": "描述音色说话 · Qwen3-TTS", "type": "audio"}
      ],
      "credit_cost": 1
    }'::jsonb,
    'go', 'comfyui'
WHERE NOT EXISTS (
    SELECT 1 FROM provider_configs
    WHERE vendor = 'ComfyUI'
      AND 'qwen3-tts-voice-design-local' = ANY(model_list)
);

UPDATE provider_configs
SET name = '本地 Stable Audio 3 环境音效（不能说话）',
    parameter_schema = jsonb_set(
      COALESCE(parameter_schema, '{}'::jsonb),
      '{vendor_models}',
      '[{"modelName":"stable-audio-3-small-sfx-local","name":"环境音效/拟音（不能说话） · Stable Audio 3","type":"audio"}]'::jsonb,
      true
    )
WHERE vendor = 'ComfyUI'
  AND 'stable-audio-3-small-sfx-local' = ANY(model_list);
