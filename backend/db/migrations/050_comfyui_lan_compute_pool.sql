-- Opt the existing local MiniMax H3 provider into the LAN worker pool. New
-- ComfyUI machines join by creating another enabled provider config with the
-- same compute_pool value and their own base_url/worker_name.
UPDATE provider_configs
SET parameter_schema = COALESCE(parameter_schema, '{}'::jsonb) || jsonb_build_object(
        'compute_pool', 'minimax-h3-lan',
        'worker_name', CASE
            WHEN COALESCE(parameter_schema->>'worker_name', '') <> ''
                THEN parameter_schema->>'worker_name'
            ELSE '本机'
        END,
        'max_concurrency', CASE
            WHEN COALESCE(parameter_schema->>'max_concurrency', '') ~ '^[1-9][0-9]*$'
                THEN (parameter_schema->>'max_concurrency')::int
            ELSE 1
        END
    ),
    updated_at = NOW()
WHERE LOWER(vendor) = 'comfyui'
  AND (
      'minimax-h3-t2v-ref2v-turbo-local' = ANY(model_list)
      OR 'minimax-h3-ref2v-9ref-turbo-local' = ANY(model_list)
      OR 'minimax-h3-director-local' = ANY(model_list)
  );
