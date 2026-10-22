UPDATE provider_configs
SET name = '本地 MiniMax H3 文生/参考生 Turbo',
    model_list = ARRAY['minimax-h3-t2v-ref2v-turbo-local'],
    default_model = 'minimax-h3-t2v-ref2v-turbo-local',
    parameter_schema = '{
      "models": {
        "minimax-h3-t2v-ref2v-turbo-local": {
          "supports_resolution": true,
          "resolution_options": ["480p", "768p"],
          "supports_aspect_ratio": true,
          "aspect_ratio_options": ["16:9", "9:16", "1:1"],
          "supports_duration": true,
          "default_params": {"resolution": "480p", "aspect_ratio": "16:9", "input_reference_min": 0, "input_reference_max": 9}
        }
      },
      "credit_cost": 1
    }'::jsonb,
    updated_at = NOW()
WHERE vendor = 'ComfyUI'
  AND ('minimax-h3-ref2v-9ref-turbo-local' = ANY(model_list)
       OR 'minimax-h3-t2v-ref2v-turbo-local' = ANY(model_list));
