INSERT INTO provider_configs (
 service_type,vendor,name,api_spec,protocol,base_url,submit_endpoint,query_endpoint,
 model_list,default_model,priority,is_default,status,capabilities,parameter_schema,adapter_runtime,icon_key
)
SELECT 'image','ComfyUI','本地 FLUX.2 Klein Base · 0–4 图参考','custom','native',
 'http://127.0.0.1:8188','/prompt','/history/{taskId}',
 ARRAY['flux2-klein-base-4b-local','flux2-klein-base-9b-local'],'flux2-klein-base-4b-local',14,false,'enabled',ARRAY['image'],
 '{"supports_resolution":true,"resolution_options":["512px","768px","1024px"],"supports_aspect_ratio":true,"aspect_ratio_options":["1:1","16:9","9:16","4:3","3:4","3:2","2:3"],"defaults":{"resolution":"768px","aspect_ratio":"1:1"},"allowed_parameters":["model","prompt","size","resolution","seed","output_count","reference_images","steps","cfg"],"models":{"flux2-klein-base-4b-local":{"reference_image_max":4},"flux2-klein-base-9b-local":{"reference_image_max":4}},"vendor_models":[{"modelName":"flux2-klein-base-4b-local","name":"FLUX.2 Klein Base 4B · 本地多参考","type":"image"},{"modelName":"flux2-klein-base-9b-local","name":"FLUX.2 Klein Base 9B · 本地多参考（非商用许可）","type":"image"}],"credit_cost":1}'::jsonb,
 'go','comfyui'
WHERE NOT EXISTS(SELECT 1 FROM provider_configs WHERE vendor='ComfyUI' AND 'flux2-klein-base-4b-local'=ANY(model_list));

INSERT INTO provider_configs (
 service_type,vendor,name,api_spec,protocol,base_url,submit_endpoint,query_endpoint,
 model_list,default_model,priority,is_default,status,capabilities,parameter_schema,adapter_runtime,icon_key
)
SELECT 'image','ComfyUI','本地 Krea-2 Turbo · Darkbrush','custom','native',
 'http://127.0.0.1:8188','/prompt','/history/{taskId}',
 ARRAY['krea2-turbo-local'],'krea2-turbo-local',15,false,'enabled',ARRAY['image'],
 '{"supports_resolution":true,"resolution_options":["512px","768px","1024px"],"supports_aspect_ratio":true,"aspect_ratio_options":["1:1","16:9","9:16","4:3","3:4","3:2","2:3"],"defaults":{"resolution":"768px","aspect_ratio":"1:1"},"allowed_parameters":["model","prompt","size","resolution","seed","output_count","steps","lora","lora_strength"],"models":{"krea2-turbo-local":{"reference_image_max":0}},"vendor_models":[{"modelName":"krea2-turbo-local","name":"Krea-2 Turbo · 本地衍生版 / Darkbrush","type":"image"}],"credit_cost":1}'::jsonb,
 'go','comfyui'
WHERE NOT EXISTS(SELECT 1 FROM provider_configs WHERE vendor='ComfyUI' AND 'krea2-turbo-local'=ANY(model_list));
