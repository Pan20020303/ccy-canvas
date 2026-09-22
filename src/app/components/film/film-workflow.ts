import { ASSET_PROMPT_TEMPLATES, filmSkillBody, filmPromptSkills, filmTextModel, FILM_STYLES, type FilmAsset, type FilmProject } from './film-project';
import type { FilmModel } from './film-project';
import type { Skill } from '../../api/skills';
import type { GeneratePayload } from '../../api/providerConfigs';
import { scriptDoctorApproved, scriptDoctorIssue } from './film-script-doctor';

export const ASSET_TYPE_NAMES = { character: '人物', scene: '场景', prop: '道具', audio: '音频' };
const running = (p: FilmProject, kinds: string[]) => p.jobs.some(j => kinds.includes(j.kind) && ['submitting', 'running', 'unknown'].includes(j.status));

export function filmAssetPreparationIssue(p: FilmProject): string | undefined {
  if (!p.script.trim()) return '请先上传或填写剧本。';
  if (running(p, ['extract', 'describe', 'asset'])) return '场景、角色或道具仍在处理中，请等待完成后再生成分镜。';
  if (!p.assets.length) return '请先提取场景角色道具，或手动导入资产。';
  const missing = p.assets.filter(a => a.type !== 'audio' && !a.url);
  if (missing.length) return `还有 ${missing.length} 个资产缺少参考图（${missing.slice(0, 3).map(a => a.name).join('、')}${missing.length > 3 ? '…' : ''}），请上传或生成后再进行分镜。`;
  if (scriptDoctorApproved(p) && !p.scriptDoctor?.adopted?.assetsReviewed) return '优化稿已采用，请核对人物、场景、道具是否仍完整，再确认资产已核对。已有素材不会被删除。';
}

export function filmStepIssue(p: FilmProject, step: number): string | undefined {
  if (step > 0 && !p.script.trim()) return '请先上传或填写剧本。';
  // Existing shots remain editable so older projects can repair their bindings.
  if (step >= 3 && !p.shots.length) {
    const doctor = scriptDoctorIssue(p);
    if (doctor) return doctor;
    const issue = filmAssetPreparationIssue(p);
    if (issue) return issue;
  }
  if (step >= 4 && !p.shots.length) return '请先生成分镜脚本或手动添加镜头。';
  if (step >= 4 && p.settings.method !== 'reference' && p.shots.some(s => !s.imageUrl)) return '当前制作方式需要先完成各镜头的分镜图，再进入分镜视频。';
  if (step === 5 && p.shots.some(s => !s.videoUrl)) return '请先生成或上传所有分镜视频，再进行成片预览。';
}

export function filmAssetTemplate(p: FilmProject, type: FilmAsset['type']) {
  if (type === 'audio') return '';
  return p.settings.assetPromptTemplates?.[type]?.trim() || ASSET_PROMPT_TEMPLATES[type];
}

export function filmAssetDescriptionPayload(p: FilmProject, asset: FilmAsset, models: FilmModel[], skills: Skill[]): GeneratePayload {
  const model = filmTextModel(p, models, 'extract');
  const skillId = p.settings.extractSkillId;
  const skill = filmPromptSkills(skills).find(s => s.id === skillId);
  if (skillId && !skill) throw new Error('资产提取技能不可用，请在制作设置中重新选择。');
  return { service_type: 'text', provider_config_id: model.provider.id, model: model.model,
    prompt: `为以下${ASSET_TYPE_NAMES[asset.type]}编写可直接用于生成参考图的中文提示词。只输出提示词正文，200至500字，不输出JSON、解释或追问。忠实保留剧本设定，不新增剧情。\n${skill ? `资产描述技能：\n${filmSkillBody(skill)}\n` : ''}描述模板：${filmAssetTemplate(p, asset.type)}\n当前画幅：${asset.generation?.image?.ratio || p.settings.ratio}，不照搬技能示例中的其他比例、分辨率或模型名。\n统一风格：${FILM_STYLES.find(s => s.id === p.settings.style)?.prompt || ''}\n资产名称：${asset.name}\n已有描述：${asset.description}\n已有提示词：${asset.generationPrompt || ''}\n剧本：\n${p.script}` };
}
