-- HopBase OpenAI Images compatible gateway. The row is intentionally created
-- disabled and without a key: model availability is scoped to each HopBase
-- key and must be verified with GET /v1/models before enabling it.
INSERT INTO provider_configs (
    service_type, vendor, name, api_spec, protocol, base_url,
    encrypted_api_key, submit_endpoint, query_endpoint,
    model_list, default_model, priority, is_default, status, capabilities,
    parameter_schema, adapter_runtime, icon_key
)
SELECT
    'image', 'HopBase', 'HopBase · 图片生成（待密钥核验）', 'openai',
    'openai_compatible', 'https://api.hop-base.com/v1', '',
    '/images/generations', '/images/tasks?task_id={taskId}',
    ARRAY[
        'seedream-5-0-pro', 'seedream-5-0-lite', 'seedream-4-5',
        'gpt-image-2', 'gemini-2.5-flash-image',
        'gemini-3-pro-image', 'gemini-3-pro-image-c',
        'gemini-3-pro-image-preview', 'gemini-3-pro-image-preview-c',
        'gemini-3.1-flash-image', 'gemini-3.1-flash-image-c',
        'gemini-3.1-flash-image-preview', 'gemini-3.1-flash-image-preview-c',
        'gemini-3.1-flash-lite-image'
    ],
    'seedream-5-0-pro', 4, false, 'disabled', ARRAY['image'],
    '{
      "supports_resolution": true,
      "resolution_options": ["1K", "1.5K", "2K", "3K", "4K"],
      "supports_aspect_ratio": true,
      "aspect_ratio_options": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
      "supports_quality": true,
      "quality_options": ["auto", "low", "medium", "high"],
      "supports_output_format": true,
      "output_format_options": ["png", "jpeg", "webp"],
      "allowed_parameters": ["model", "prompt", "n", "size", "quality", "background", "output_format", "response_format", "input_fidelity", "image"],
      "defaults": {"resolution": "2K", "aspect_ratio": "1:1", "quality": "medium", "output_format": "png"},
      "models": {
        "seedream-5-0-pro": {"resolution_options": ["1K", "1.5K", "2K"], "reference_image_max": 10, "output_format_options": ["png", "jpeg"]},
        "seedream-5-0-lite": {"resolution_options": ["2K", "3K", "4K"], "reference_image_max": 14, "output_format_options": ["png", "jpeg"]},
        "seedream-4-5": {"resolution_options": ["2K", "4K"], "reference_image_max": 14, "output_format_options": ["jpeg"]},
        "gemini-2.5-flash-image": {"resolution_options": ["1K"]},
        "gemini-3-pro-image": {"resolution_options": ["1K", "2K", "4K"]},
        "gemini-3-pro-image-c": {"resolution_options": ["1K", "2K", "4K"]},
        "gemini-3.1-flash-image": {"resolution_options": ["1K", "2K"]},
        "gemini-3.1-flash-image-c": {"resolution_options": ["1K", "2K"]},
        "gemini-3.1-flash-lite-image": {"resolution_options": ["1K"]}
      },
      "vendor_models": [
        {"modelName": "seedream-5-0-pro", "name": "Seedream 5.0 Pro", "type": "image"},
        {"modelName": "seedream-5-0-lite", "name": "Seedream 5.0 Lite", "type": "image"},
        {"modelName": "seedream-4-5", "name": "Seedream 4.5", "type": "image"},
        {"modelName": "gpt-image-2", "name": "GPT Image 2", "type": "image"},
        {"modelName": "gemini-2.5-flash-image", "name": "Gemini 2.5 Flash Image", "type": "image"},
        {"modelName": "gemini-3-pro-image", "name": "Gemini 3 Pro Image", "type": "image"},
        {"modelName": "gemini-3-pro-image-c", "name": "Gemini 3 Pro Image C", "type": "image"},
        {"modelName": "gemini-3-pro-image-preview", "name": "Gemini 3 Pro Image Preview", "type": "image"},
        {"modelName": "gemini-3-pro-image-preview-c", "name": "Gemini 3 Pro Image Preview C", "type": "image"},
        {"modelName": "gemini-3.1-flash-image", "name": "Gemini 3.1 Flash Image", "type": "image"},
        {"modelName": "gemini-3.1-flash-image-c", "name": "Gemini 3.1 Flash Image C", "type": "image"},
        {"modelName": "gemini-3.1-flash-image-preview", "name": "Gemini 3.1 Flash Image Preview", "type": "image"},
        {"modelName": "gemini-3.1-flash-image-preview-c", "name": "Gemini 3.1 Flash Image Preview C", "type": "image"},
        {"modelName": "gemini-3.1-flash-lite-image", "name": "Gemini 3.1 Flash Lite Image", "type": "image"}
      ],
      "credit_cost": 1
    }'::jsonb,
    'go', 'hopbase'
WHERE NOT EXISTS (
    SELECT 1 FROM provider_configs
    WHERE vendor = 'HopBase' AND service_type = 'image'
);
