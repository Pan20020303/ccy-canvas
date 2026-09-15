import { X } from 'lucide-react';
import type { Skill } from '../../api/skills';
import { getSkillDisplayName } from '../../skill-display';
import { getSkillCommandName } from '../settings/skill-agent-presenters';
import { SkillIcon } from './skill-library-presenters';
import './skill-library.css';

export function SkillMentionChip({ skill, onRemove, disabled, zh }: { skill: Skill; onRemove: () => void; disabled?: boolean; zh: boolean }) {
  return <span className="skill-mention-chip" title={`${getSkillDisplayName(skill)} · ${getSkillCommandName(skill)}`}>
    <SkillIcon skill={skill} small /><span className="skill-mention-name">{getSkillCommandName(skill).replace(/^\//, '')}</span>
    <button className="skill-mention-remove" type="button" disabled={disabled} onClick={onRemove} aria-label={zh ? '移除已选技能' : 'Remove selected skill'}><X size={12} className="skill-control-icon" /></button>
  </span>;
}
