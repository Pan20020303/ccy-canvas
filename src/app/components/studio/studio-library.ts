import type { SavedAsset, HistoryItem } from '../../store';
import { getHistoryItemAssetUrl } from '../../history-assets';
import { getModelTemplate } from '../../model-templates';
import { getProviderModelPresentation, modelServiceType, type AppProviderConfig, type GeneratePayload } from '../../api/providerConfigs';

export type AssetRole = 'person' | 'model' | 'garment' | 'reference';
export type StudioAsset = SavedAsset & { source: 'library' | 'history' | 'generated' };
export type ReferenceAsset = StudioAsset & { role: AssetRole };
export type AssetMeta = { favorite?: boolean; tags?: string[]; role?: AssetRole };
export type StudioPreset = { id: string; name: string; prompt: string; size: string; quality: string; polish: boolean };
export type StudioPreferences = { metadata: Record<string, AssetMeta>; templates: StudioPreset[]; size: number; layout: 'grid' | 'list' };
export type LibraryFilter = { search: string; kind: string; folder: string; tag: string; favorite: boolean; source: string; date: string; sort: string };
export const DEFAULT_FILTER: LibraryFilter = { search: '', kind: 'all', folder: 'all', tag: '', favorite: false, source: 'all', date: 'all', sort: 'newest' };
export const MAX_REFERENCES = 16;
export const roleName = (role: AssetRole, zh: boolean) => ({ person: zh ? '人物' : 'Person', model: zh ? '模特' : 'Model', garment: zh ? '服装' : 'Garment', reference: zh ? '参考图片' : 'Reference' })[role];
export const preferencesKey = (userId: string) => `ccy-tryon-preferences:${userId}`;
export function readPreferences(userId: string): StudioPreferences {
  const fallback: StudioPreferences = { metadata: {}, templates: [], size: 220, layout: 'grid' };
  try {
    const value = JSON.parse(localStorage.getItem(preferencesKey(userId)) || 'null');
    if (!value || typeof value !== 'object') return fallback;
    const metadata: Record<string, AssetMeta> = {};
    for (const [key, raw] of Object.entries(value.metadata ?? {})) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as AssetMeta;
      metadata[key] = { favorite: item.favorite === true, tags: Array.isArray(item.tags) ? item.tags.filter(t => typeof t === 'string').slice(0, 20) : [], role: ['person', 'model', 'garment', 'reference'].includes(item.role ?? '') ? item.role : undefined };
    }
    return { metadata, templates: Array.isArray(value.templates) ? value.templates.filter((t: StudioPreset) => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.prompt === 'string' && typeof t.size === 'string' && typeof t.quality === 'string' && typeof t.polish === 'boolean').slice(0, 50) : [], size: Math.max(150, Math.min(360, Number(value.size) || 220)), layout: value.layout === 'list' ? 'list' : 'grid' };
  } catch { return fallback; }
}
export function assetRole(asset: StudioAsset, metadata: Record<string, AssetMeta>): AssetRole {
  return metadata[asset.id]?.role ?? (asset.category === 'character' ? 'person' : asset.category === 'object' ? 'garment' : 'reference');
}
export function mergeLibrary(assets: SavedAsset[], history: HistoryItem[]): StudioAsset[] {
  const urls = new Set(assets.map(a => a.url));
  const saved: StudioAsset[] = assets.filter(a => ['image', 'video', 'audio'].includes(a.kind) && a.url).map(a => ({ ...a, source: a.id.startsWith('tryon-') ? 'generated' : 'library' }));
  for (const h of history) {
    if (!['image', 'video', 'audio'].includes(h.mediaType)) continue;
    const url = h.mediaType !== 'image' && /^(https?:\/\/|\/)/i.test(h.content ?? '') ? h.content! : getHistoryItemAssetUrl(h);
    if (!url || urls.has(url)) continue;
    urls.add(url);
    saved.push({ id: `history-${h.id}`, name: h.title, category: 'other', thumbnail: h.mediaType === 'image' ? url : '', url, kind: h.mediaType as 'image' | 'video' | 'audio', text: h.promptExcerpt, createdAt: h.timestamp, source: 'history' });
  }
  return saved;
}
export function filterLibrary(assets: StudioAsset[], metadata: Record<string, AssetMeta>, filter: LibraryFilter, now = Date.now()) {
  const query = filter.search.trim().toLocaleLowerCase();
  const days = filter.date === '7' ? 7 : filter.date === '30' ? 30 : 0;
  return assets.filter(a => (!query || [a.name, ...(metadata[a.id]?.tags ?? [])].join(' ').toLocaleLowerCase().includes(query))
    && (filter.kind === 'all' || a.kind === filter.kind)
    && (filter.folder === 'all' || (a.folderId ?? '') === filter.folder)
    && (!filter.tag || metadata[a.id]?.tags?.includes(filter.tag))
    && (!filter.favorite || metadata[a.id]?.favorite)
    && (filter.source === 'all' || a.source === filter.source)
    && (!days || a.createdAt >= now - days * 86400000))
    .sort((a, b) => filter.sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : filter.sort === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);
}
export function toSavedAsset(asset: StudioAsset): SavedAsset {
  const { source: _source, ...saved } = asset;
  return saved;
}
export type StudioModel = { key: string; name: string; label: string; provider: AppProviderConfig; sizes: string[]; qualities: string[]; maxReferences: number; minReferences: number; cost: number };
export function studioModels(configs: AppProviderConfig[]): StudioModel[] {
  const { hiddenModels, displayNames } = getProviderModelPresentation(configs);
  return configs.flatMap(provider => Array.from(new Set([provider.default_model, ...provider.model_list])).filter(name => name && modelServiceType(provider, name) === 'image' && !hiddenModels.has(name) && !/dall-e/i.test(name)).map(name => {
    const template = getModelTemplate(name, { ...provider, service_type: 'image' });
    const schema = provider.parameter_schema?.models?.[name] ?? provider.parameter_schema;
    const cost = schema?.credit_cost ?? provider.parameter_schema?.credit_cost ?? 1;
    const sizes = template?.supportsAspectRatio ? template.aspectRatioOptions ?? [] : [];
    return { key: `${provider.id}:${name}`, name, label: displayNames.get(name) ?? name, provider, sizes, qualities: template?.supportsQuality ? template.qualityOptions ?? [] : [], minReferences: template?.referenceImageRange?.min ?? 2, maxReferences: Math.min(MAX_REFERENCES, template?.referenceImageRange?.max ?? MAX_REFERENCES), cost: Math.max(0, Math.round(cost)) };
  }).filter(model => model.maxReferences >= 2));
}
export function buildTryOnPayload(model: StudioModel, refs: ReferenceAsset[], prompt: string, size: string, quality: string, polish: boolean): Omit<GeneratePayload, 'node_id' | 'request_id'> {
  if (!refs.some(r => r.role === 'person' || r.role === 'model')) throw new Error('请先选择人物或模特图片。');
  if (!refs.some(r => r.role === 'garment')) throw new Error('请先选择要试穿的服装图片。');
  if (refs.length > model.maxReferences || refs.length < model.minReferences) throw new Error(`当前模型需要 ${model.minReferences}–${model.maxReferences} 张参考图片。`);
  if (new Set(refs.map(r => r.url)).size !== refs.length) throw new Error('人物和服装需要使用不同的图片。');
  const description = refs.map((ref, i) => `参考图 ${i + 1}：${roleName(ref.role, true)}（${ref.name}）。`).join('\n');
  return { service_type: 'image', provider_config_id: model.provider.id, model: model.name, reference_images: refs.map(r => r.url), prompt: `请根据参考图片制作真实的模特试衣效果。\n${description}\n保持人物/模特的身份特征和体型，将服装参考中的衣服穿在人物身上；保持服装的颜色、图案、材质与版型，不把服装图片中的人脸替换到目标人物上。\n${prompt.trim()}${polish ? '\n补充要求：服装自然贴合，布料褶皱合理，人体比例准确，光影一致，清晰展示穿搭。' : ''}`, ...(model.sizes.includes(size) ? { size } : {}), ...(model.qualities.includes(quality) ? { quality: quality.toLowerCase() } : {}) };
}
export function validateUpload(file: File) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('请上传 JPG、PNG 或 WebP 图片。');
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('图片不能为空，且每张不能超过 20 MB。');
}
