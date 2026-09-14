UPDATE provider_configs
SET parameter_schema = jsonb_set(
      jsonb_set(
        COALESCE(parameter_schema, '{}'::jsonb),
        '{quality_options}',
        '["极速","官方8步","均衡二采","高质二采"]'::jsonb,
        true
      ),
      '{models,minimax-h3-t2v-ref2v-turbo-local,quality_options}',
      '["极速","官方8步","均衡二采","高质二采"]'::jsonb,
      true
    ),
    updated_at = NOW()
WHERE vendor = 'ComfyUI'
  AND 'minimax-h3-t2v-ref2v-turbo-local' = ANY(model_list);
