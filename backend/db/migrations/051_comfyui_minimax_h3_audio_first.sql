-- Add the opt-in two-stage profile without changing saved presets, pool
-- membership, worker limits, or the separate Director model's choices.
UPDATE provider_configs
SET parameter_schema = jsonb_set(
      jsonb_set(
        COALESCE(parameter_schema, '{}'::jsonb),
        '{quality_options}',
        COALESCE(parameter_schema->'quality_options', '["极速","官方8步","均衡二采","高质二采"]'::jsonb) ||
          CASE WHEN COALESCE(parameter_schema->'quality_options', '[]'::jsonb) ? '音画分采8步'
               THEN '[]'::jsonb ELSE '["音画分采8步"]'::jsonb END
      ),
      '{models}',
      COALESCE(parameter_schema->'models', '{}'::jsonb) || jsonb_build_object(
        'minimax-h3-t2v-ref2v-turbo-local',
        COALESCE(parameter_schema#>'{models,minimax-h3-t2v-ref2v-turbo-local}', '{}'::jsonb) || jsonb_build_object(
          'quality_options',
          COALESCE(parameter_schema#>'{models,minimax-h3-t2v-ref2v-turbo-local,quality_options}', '["极速","官方8步","均衡二采","高质二采"]'::jsonb) ||
            CASE WHEN COALESCE(parameter_schema#>'{models,minimax-h3-t2v-ref2v-turbo-local,quality_options}', '[]'::jsonb) ? '音画分采8步'
                 THEN '[]'::jsonb ELSE '["音画分采8步"]'::jsonb END
        )
      )
    ), updated_at = NOW()
WHERE LOWER(vendor) = 'comfyui'
  AND 'minimax-h3-t2v-ref2v-turbo-local' = ANY(model_list);
