-- Expose the three newly installed MiniMax H3 workflows as independent
-- canvas models. The two U09 entries use the dual-stage API graph; the drama
-- workbench uses the maintained H3 Director adapter because the supplied UI
-- JSON references private CodexDrama* nodes that are not distributed with it.
UPDATE provider_configs
SET name = '本地 MiniMax H3 · 原生 / 导演台 / U09 二采 / 短剧工作台',
    model_list = ARRAY[
      'minimax-h3-t2v-ref2v-turbo-local',
      'minimax-h3-director-local',
      'minimax-h3-u09-redraw-dual-fast-local',
      'minimax-h3-u09-no-codec-dual-upscale-local',
      'minimax-h3-drama-workbench-local'
    ],
    parameter_schema = jsonb_set(
      jsonb_set(
        COALESCE(parameter_schema, '{}'::jsonb),
        '{allowed_parameters}',
        '["model","prompt","duration","aspect_ratio","resolution","quality","reference_images","reference_video","reference_videos","reference_audio","reference_audios","reference_mode","seed"]'::jsonb,
        true
      ),
      '{models}',
      COALESCE(parameter_schema->'models', '{}'::jsonb) || '{
        "minimax-h3-u09-redraw-dual-fast-local": {
          "allowed_parameters": ["model","prompt","duration","aspect_ratio","resolution","quality","reference_images","reference_video","reference_videos","reference_audio","reference_audios","reference_mode","seed"],
          "supports_resolution": true,
          "resolution_options": ["480p","768p"],
          "supports_aspect_ratio": true,
          "aspect_ratio_options": ["16:9","9:16","1:1"],
          "supports_duration": true,
          "supports_quality": true,
          "quality_options": ["平衡 8+3步","精细 12+4步"],
          "defaults": {"duration":5,"aspect_ratio":"16:9","resolution":"768p","quality":"平衡 8+3步","input_reference_min":0,"input_reference_max":9}
        },
        "minimax-h3-u09-no-codec-dual-upscale-local": {
          "allowed_parameters": ["model","prompt","duration","aspect_ratio","resolution","quality","reference_images","reference_video","reference_videos","reference_audio","reference_audios","reference_mode","seed"],
          "supports_resolution": true,
          "resolution_options": ["480p","768p"],
          "supports_aspect_ratio": true,
          "aspect_ratio_options": ["16:9","9:16","1:1"],
          "supports_duration": true,
          "supports_quality": true,
          "quality_options": ["原生 20+3步","精细 24+4步"],
          "defaults": {"duration":5,"aspect_ratio":"16:9","resolution":"768p","quality":"原生 20+3步","input_reference_min":0,"input_reference_max":9}
        },
        "minimax-h3-drama-workbench-local": {
          "allowed_parameters": ["model","prompt","duration","aspect_ratio","resolution","quality","reference_images","reference_video","reference_videos","reference_audio","reference_audios","reference_mode","seed"],
          "supports_resolution": true,
          "resolution_options": ["480p","768p"],
          "supports_aspect_ratio": true,
          "aspect_ratio_options": ["16:9","9:16","1:1"],
          "supports_duration": true,
          "supports_quality": true,
          "quality_options": ["极速","均衡二采","高质二采"],
          "defaults": {"duration":30,"aspect_ratio":"9:16","resolution":"480p","quality":"极速","input_reference_min":0,"input_reference_max":9}
        }
      }'::jsonb,
      true
    ) || jsonb_build_object(
      'vendor_models', '[
        {"modelName":"minimax-h3-t2v-ref2v-turbo-local","name":"MiniMax H3 · 本地原生/参考生成","type":"video"},
        {"modelName":"minimax-h3-director-local","name":"MiniMax H3 · 导演台连续生成","type":"video"},
        {"modelName":"minimax-h3-u09-redraw-dual-fast-local","name":"MiniMax H3 · U09 二采重绘双模型极速版","type":"video"},
        {"modelName":"minimax-h3-u09-no-codec-dual-upscale-local","name":"MiniMax H3 · U09 无编解码二采放大","type":"video"},
        {"modelName":"minimax-h3-drama-workbench-local","name":"MiniMax H3 · 短剧工作台","type":"video"}
      ]'::jsonb,
      'vendor_all_models', '[
        {"modelName":"minimax-h3-t2v-ref2v-turbo-local","name":"MiniMax H3 · 本地原生/参考生成","type":"video"},
        {"modelName":"minimax-h3-director-local","name":"MiniMax H3 · 导演台连续生成","type":"video"},
        {"modelName":"minimax-h3-u09-redraw-dual-fast-local","name":"MiniMax H3 · U09 二采重绘双模型极速版","type":"video"},
        {"modelName":"minimax-h3-u09-no-codec-dual-upscale-local","name":"MiniMax H3 · U09 无编解码二采放大","type":"video"},
        {"modelName":"minimax-h3-drama-workbench-local","name":"MiniMax H3 · 短剧工作台","type":"video"}
      ]'::jsonb
    ),
    updated_at = NOW()
WHERE LOWER(vendor) = 'comfyui'
  AND 'minimax-h3-t2v-ref2v-turbo-local' = ANY(model_list);
