import { useState } from 'react';
import { Braces, FileText, Globe, Loader2 } from 'lucide-react';
import type { Skill } from '../../api/skills';
import { getSkillDisplayName } from '../../skill-display';

export type LibraryStatus = { loading?: boolean; error?: string; onRetry?: () => void };
export type SkillSort = 'latest' | 'name';
export function sortLibrarySkills(skills: Skill[], sort: SkillSort): Skill[] {
  const timestamp = (value: string) => Date.parse(value) || 0;
  return [...skills].sort((a, b) => sort === 'name'
    ? getSkillDisplayName(a).localeCompare(getSkillDisplayName(b), 'zh-CN') || a.id.localeCompare(b.id)
    : timestamp(b.updated_at || b.created_at) - timestamp(a.updated_at || a.created_at) || a.id.localeCompare(b.id));
}
export function skillScopeLabel(skill: Skill, zh: boolean) {
  return skill.scope === 'global' ? (zh ? '官方' : 'Official') : skill.scope === 'team' ? (zh ? '团队' : 'Team') : (zh ? '我的' : 'Mine');
}
export function safeSkillMediaUrl(value: unknown): string {
  return typeof value === 'string' && /^(https?:\/\/|\/(?!\/)|data:image\/(png|jpeg|webp|gif);base64,)/i.test(value.trim()) ? value.trim() : '';
}
export function SkillIcon({ skill, small = false }: { skill: Skill; small?: boolean }) {
  const [failedSrc, setFailedSrc] = useState('');
  const src = skill.icon?.trim() || '';
  const isImage = Boolean(safeSkillMediaUrl(src));
  const isEmoji = !isImage && /\p{Extended_Pictographic}/u.test(src) && [...src].length <= 12;
  const Icon = skill.kind === 'code' ? Braces : skill.kind === 'http' ? Globe : FileText;
  const palette = [...(skill.category || skill.id)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5;
  return <span className={`skill-artwork skill-artwork-${palette}${small ? ' skill-artwork-small' : ''}`} aria-hidden="true">
    {isImage && failedSrc !== src ? <img className="skill-artwork-image" src={src} alt="" loading="lazy" onError={() => setFailedSrc(src)} /> : isEmoji ? <span className="skill-artwork-emoji">{src}</span> : <Icon className="skill-artwork-symbol" size={small ? 17 : 25} strokeWidth={1.5} />}
  </span>;
}
export function LibraryFeedback({ loading, error, onRetry, zh }: LibraryStatus & { zh: boolean }) {
  if (loading) return <div className="skill-feedback" role="status"><Loader2 className="skill-spinner" size={16} />{zh ? '正在加载技能…' : 'Loading skills…'}</div>;
  if (error) return <div className="skill-feedback skill-feedback-error" role="alert"><span className="skill-error-message">{error}</span><button className="skill-text-button" onClick={onRetry}>{zh ? '重试' : 'Retry'}</button></div>;
  return null;
}
