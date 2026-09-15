INSERT INTO provider_configs (
    service_type, vendor, name, api_spec, protocol, base_url,
    submit_endpoint, query_endpoint, model_list, default_model,
    priority, is_default, status, capabilities, parameter_schema,
    adapter_runtime, icon_key
)
SELECT
    'image', 'ComfyUI', '本地 Z-Image Turbo · 像素风 LoRA', 'custom', 'native',
    'http://127.0.0.1:8188', '/prompt', '/history/{taskId}',
    ARRAY['z-image-turbo-local', 'z-image-turbo-v60-local'], 'z-image-turbo-local',
    13, false, 'enabled', ARRAY['image'],
    '{
      "supports_resolution": true,
      "resolution_options": ["512px", "768px", "1024px"],
      "supports_aspect_ratio": true,
      "aspect_ratio_options": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
      "defaults": {"resolution":"768px","aspectRatio":"1:1"},
      "allowed_parameters": ["model","prompt","size","resolution","seed","output_count","steps","sampler","scheduler","lora","lora_strength"],
      "models": {
        "z-image-turbo-local": {"reference_image_max":0},
        "z-image-turbo-v60-local": {"reference_image_max":0}
      },
      "vendor_models": [
        {"modelName":"z-image-turbo-local","name":"Z-Image Turbo · 原版 BF16（本地）","type":"image"},
        {"modelName":"z-image-turbo-v60-local","name":"Z-Image Turbo · V60 FP16（本地）","type":"image"}
      ],
      "credit_cost": 1
    }'::jsonb,
    'go', 'comfyui'
WHERE NOT EXISTS (
    SELECT 1 FROM provider_configs
    WHERE vendor = 'ComfyUI' AND 'z-image-turbo-local' = ANY(model_list)
);
