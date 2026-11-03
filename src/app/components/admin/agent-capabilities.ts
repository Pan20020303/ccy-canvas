import type { Skill } from '../../api/skills';

export function isAgentGuideSkill(skill: Skill) {
 const spec = skill.spec || {};
 if (typeof spec.content_md !== 'string' || !spec.content_md.trim() || String(spec.user_template || '').trim() || String(spec.system_prompt || '').trim()) return false;
 return skill.kind === 'prompt' || skill.kind === 'code' && ['creator-suite','toonflow'].includes(String(spec.source)) && spec.source_type === 'skill';
}
export function isRunnableAgentSkill(skill: Skill, child = false) {
 return skill.enabled && (child ? isAgentGuideSkill(skill) : skill.kind === 'prompt' || skill.kind === 'http' || isAgentGuideSkill(skill));
}
