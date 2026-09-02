UPDATE provider_configs
SET name = '本地 LTX-2.5 文生/多图参考 · 同步音频',
    parameter_schema = (parameter_schema #- '{duration_options}' #- '{models,ltx-2.5-distilled-av-local,duration_options}')
    || jsonb_build_object(
        'defaults', COALESCE(parameter_schema->'defaults', '{}'::jsonb)
            || '{"duration":5,"input_reference_min":0,"input_reference_max":6}'::jsonb,
        'models', COALESCE(parameter_schema->'models', '{}'::jsonb)
            || jsonb_build_object(
                'ltx-2.5-distilled-av-local',
                (COALESCE(parameter_schema#>'{models,ltx-2.5-distilled-av-local}', '{}'::jsonb) - 'duration_options')
                    || jsonb_build_object(
                        'default_params', COALESCE(parameter_schema#>'{models,ltx-2.5-distilled-av-local,default_params}', '{}'::jsonb)
                            || '{"duration":5,"input_reference_min":0,"input_reference_max":6}'::jsonb
                    )
            )
    ),
    updated_at = NOW()
WHERE vendor = 'ComfyUI'
  AND 'ltx-2.5-distilled-av-local' = ANY(model_list);
