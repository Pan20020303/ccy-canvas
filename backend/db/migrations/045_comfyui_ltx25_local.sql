INSERT INTO provider_configs (
    service_type, vendor, name, api_spec, protocol, base_url,
    submit_endpoint, query_endpoint, model_list, default_model,
    priority, is_default, status, capabilities, parameter_schema,
    adapter_runtime, icon_key
)
SELECT
    'video', 'ComfyUI', '本地 LTX-2.5 文生/多图参考 · 同步音频', 'custom', 'native',
    'http://127.0.0.1:8188', '/prompt', '/history/{taskId}',
    ARRAY['ltx-2.5-distilled-av-local'], 'ltx-2.5-distilled-av-local',
    11, false, 'enabled', ARRAY['video'],
    '{
      "allowed_parameters": ["model", "prompt", "duration", "aspect_ratio", "resolution", "reference_images", "reference_mode", "seed"],
      "aspect_ratio_options": ["16:9", "9:16", "1:1"],
      "resolution_options": ["480p", "720p"],
      "supports_aspect_ratio": true,
      "supports_resolution": true,
      "supports_duration": true,
      "defaults": {"duration": 5, "aspect_ratio": "16:9", "resolution": "480p", "input_reference_min": 0, "input_reference_max": 6},
      "models": {
        "ltx-2.5-distilled-av-local": {
          "allowed_parameters": ["model", "prompt", "duration", "aspect_ratio", "resolution", "reference_images", "reference_mode", "seed"],
          "aspect_ratio_options": ["16:9", "9:16", "1:1"],
          "resolution_options": ["480p", "720p"],
          "supports_aspect_ratio": true,
          "supports_resolution": true,
          "supports_duration": true,
          "default_params": {"duration": 5, "aspect_ratio": "16:9", "resolution": "480p", "input_reference_min": 0, "input_reference_max": 6}
        }
      },
      "vendor_models": [{"modelName": "ltx-2.5-distilled-av-local", "name": "LTX-2.5 22B Distilled · 本地音视频", "type": "video"}],
      "credit_cost": 1
    }'::jsonb,
    'go', 'comfyui'
WHERE NOT EXISTS (
    SELECT 1 FROM provider_configs
    WHERE vendor = 'ComfyUI' AND 'ltx-2.5-distilled-av-local' = ANY(model_list)
);
