UPDATE provider_configs
SET parameter_schema = jsonb_set(
  jsonb_set(
    jsonb_set(
      COALESCE(parameter_schema, '{}'::jsonb),
      '{allowed_parameters}',
      '["model","prompt","duration","aspect_ratio","resolution","quality","reference_images","reference_mode","seed"]'::jsonb,
      true
    ),
    '{supports_quality}', 'true'::jsonb, true
  ),
  '{quality_options}', '["极速","标准","高质量"]'::jsonb, true
)
|| jsonb_build_object(
  'defaults', COALESCE(parameter_schema->'defaults', '{}'::jsonb) || '{"quality":"标准"}'::jsonb,
  'models', COALESCE(parameter_schema->'models', '{}'::jsonb) || jsonb_build_object(
    'ltx-2.5-distilled-av-local',
    COALESCE(parameter_schema#>'{models,ltx-2.5-distilled-av-local}', '{}'::jsonb)
      || '{"allowed_parameters":["model","prompt","duration","aspect_ratio","resolution","quality","reference_images","reference_mode","seed"],"supports_quality":true,"quality_options":["极速","标准","高质量"]}'::jsonb
      || jsonb_build_object(
        'defaults', COALESCE(parameter_schema#>'{models,ltx-2.5-distilled-av-local,defaults}', '{}'::jsonb) || '{"quality":"标准"}'::jsonb
      )
  )
)
WHERE vendor = 'ComfyUI'
  AND 'ltx-2.5-distilled-av-local' = ANY(model_list);
