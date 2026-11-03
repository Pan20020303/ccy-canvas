INSERT INTO provider_configs (
    service_type, vendor, name, api_spec, protocol, base_url,
    submit_endpoint, query_endpoint, model_list, default_model,
    priority, is_default, status, capabilities, parameter_schema,
    adapter_runtime, icon_key
)
SELECT
    'video', 'ComfyUI', '本地 Wan Animate 2 动作复刻', 'custom', 'native',
    'http://127.0.0.1:8188', '/prompt', '/history/{taskId}',
    ARRAY['wan-animate-2-motion-local'], 'wan-animate-2-motion-local',
    13, false, 'enabled', ARRAY['video'],
    '{
      "models": {
        "wan-animate-2-motion-local": {
          "allowed_parameters": ["model", "prompt", "duration", "aspect_ratio", "reference_images", "reference_video", "reference_mode", "seed"],
          "default_params": {"duration": 3, "aspect_ratio": "9:16", "reference_mode": "motion_mimic"},
          "supports_duration": true,
          "duration_options": [1, 2, 3, 4, 5],
          "supports_aspect_ratio": true,
          "aspect_ratio_options": ["16:9", "9:16", "1:1"],
          "reference_image_min": 1,
          "reference_image_max": 1,
          "reference_video_min": 1,
          "reference_video_max": 1
        }
      },
      "vendor_models": [
        {"modelName": "wan-animate-2-motion-local", "name": "动作复刻 · Wan Animate 2（本地 6-Step）", "type": "video"}
      ],
      "credit_cost": 1
    }'::jsonb,
    'go', 'comfyui'
WHERE NOT EXISTS (
    SELECT 1 FROM provider_configs
    WHERE vendor = 'ComfyUI'
      AND 'wan-animate-2-motion-local' = ANY(model_list)
);
