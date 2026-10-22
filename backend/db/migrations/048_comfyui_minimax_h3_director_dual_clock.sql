UPDATE provider_configs
SET name = '本地 MiniMax H3 双时钟 / 导演台 / 二采',
    model_list = ARRAY['minimax-h3-t2v-ref2v-turbo-local', 'minimax-h3-director-local'],
    parameter_schema = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(parameter_schema, '{}'::jsonb),
          '{allowed_parameters}',
          '["model","prompt","duration","aspect_ratio","resolution","quality","reference_images","reference_video","reference_videos","reference_audio","reference_audios","reference_mode","seed"]'::jsonb,
          true
        ),
        '{supports_quality}', 'true'::jsonb, true
      ),
      '{quality_options}', '["极速","均衡二采","高质二采"]'::jsonb, true
    )
    || jsonb_build_object(
      'defaults', COALESCE(parameter_schema->'defaults', '{}'::jsonb)
        || '{"duration":3,"aspect_ratio":"16:9","resolution":"480p","quality":"极速","input_reference_min":0,"input_reference_max":9}'::jsonb,
      'models', COALESCE(parameter_schema->'models', '{}'::jsonb)
        || jsonb_build_object(
          'minimax-h3-t2v-ref2v-turbo-local',
          '{"allowed_parameters":["model","prompt","duration","aspect_ratio","resolution","quality","reference_images","reference_video","reference_videos","reference_audio","reference_audios","reference_mode","seed"],"supports_resolution":true,"resolution_options":["480p","768p"],"supports_aspect_ratio":true,"aspect_ratio_options":["16:9","9:16","1:1"],"supports_duration":true,"supports_quality":true,"quality_options":["极速","均衡二采","高质二采"],"defaults":{"duration":3,"aspect_ratio":"16:9","resolution":"480p","quality":"极速","input_reference_min":0,"input_reference_max":9}}'::jsonb,
          'minimax-h3-director-local',
          '{"allowed_parameters":["model","prompt","duration","aspect_ratio","resolution","quality","reference_images","reference_video","reference_videos","reference_audio","reference_audios","reference_mode","seed"],"supports_resolution":true,"resolution_options":["480p","768p"],"supports_aspect_ratio":true,"aspect_ratio_options":["16:9","9:16","1:1"],"supports_duration":true,"supports_quality":true,"quality_options":["极速","均衡二采","高质二采"],"defaults":{"duration":30,"aspect_ratio":"9:16","resolution":"480p","quality":"极速","input_reference_min":0,"input_reference_max":9}}'::jsonb
        )
    ),
    updated_at = NOW()
WHERE vendor = 'ComfyUI'
  AND 'minimax-h3-t2v-ref2v-turbo-local' = ANY(model_list);
