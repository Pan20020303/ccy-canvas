import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Search, Settings2 } from 'lucide-react';
import type { Skill } from '../../api/skills';
import { filterSkillLibrary, getSkillCategoryLabel, getSkillDisplayName } from '../../skill-display';
import { LibraryFeedback, SkillIcon, skillScopeLabel, type LibraryStatus } from './skill-library-presenters';
import './skill-library.css';

export type SkillQuickPickerProps = LibraryStatus & {
  anchorRef: RefObject<HTMLButtonElement | null>; skills: Skill[];
  onPick: (skill: Skill) => void; onOpenAll: () => void; onClose: () => void; zh: boolean;
};
export function SkillQuickPicker({ anchorRef, skills, onPick, onOpenAll, onClose, zh, ...status }: SkillQuickPickerProps) {
  const [keyword, setKeyword] = useState('');
  const [position, setPosition] = useState<{ left: number; width: number; maxHeight: number; top?: number; bottom?: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const matches = useMemo(() => filterSkillLibrary(skills.filter(skill => skill.enabled), { keyword }), [skills, keyword]);
  const visible = matches.slice(0, keyword.trim() ? 30 : 5);
  useLayoutEffect(() => {
    const update = () => {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      const width = Math.min(390, window.innerWidth - 24);
      const above = rect.top - 20, below = window.innerHeight - rect.bottom - 20;
      const placeAbove = above >= 180 || above >= below;
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), maxHeight: Math.max(80, Math.min(400, placeAbove ? above : below)), ...(placeAbove ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }) });
    };
    update(); window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [anchorRef]);
  const positioned = Boolean(position);
  useEffect(() => { if (positioned) searchRef.current?.focus(); }, [positioned]);
  useEffect(() => {
    const anchor = anchorRef.current;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopImmediatePropagation();
        const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[data-skill-pick]') ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
      if (event.key === 'Tab' && panelRef.current) {
        const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>('input, button:not([disabled])'));
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
        if (!event.shiftKey && index === items.length - 1) { event.preventDefault(); items[0]?.focus(); }
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => { window.removeEventListener('keydown', keydown, true); anchor?.focus(); };
  }, [anchorRef]);
  if (!position) return null;
  return createPortal(<>
    <button className="skill-picker-backdrop" aria-label={zh ? '关闭技能选择' : 'Close skill picker'} tabIndex={-1} onClick={onClose} />
    <section ref={panelRef} className="skill-quick-picker" style={position} role="dialog" aria-label={zh ? '选择技能' : 'Choose a skill'} aria-modal="true" onKeyDown={event => event.stopPropagation()}>
      <div className="skill-picker-search-row"><label className="skill-search"><Search size={14} className="skill-search-icon" /><input ref={searchRef} className="skill-search-input" aria-label={zh ? '搜索可用技能' : 'Search available skills'} placeholder={zh ? '搜索' : 'Search'} value={keyword} onChange={event => setKeyword(event.target.value)} /></label><button className="skill-icon-button skill-picker-settings" aria-label={zh ? '打开技能库' : 'Open skill library'} onClick={() => { onClose(); onOpenAll(); }}><Settings2 size={16} className="skill-control-icon" /></button></div>
      <LibraryFeedback {...status} zh={zh} />
      <div className="skill-picker-list">{visible.map(skill => <button key={skill.id} className="skill-picker-item" data-skill-pick={skill.id} onClick={() => { onPick(skill); onClose(); }} title={skill.description || getSkillDisplayName(skill)}><SkillIcon skill={skill} small /><span className="skill-picker-name">{getSkillDisplayName(skill)}</span><span className="skill-picker-description">{skill.description || getSkillCategoryLabel(skill)}</span><span className={`skill-scope skill-scope-${skill.scope}`}>{skillScopeLabel(skill, zh)}</span></button>)}{!visible.length && !status.loading && !status.error && <p className="skill-empty-small">{zh ? '没有找到可用技能' : 'No matching skills'}</p>}</div>
      {matches.length > visible.length && <button className="skill-picker-more" onClick={() => { onClose(); onOpenAll(); }}>{zh ? `查看全部 ${matches.length} 个技能` : `Browse all ${matches.length} skills`}<ChevronRight size={13} className="skill-control-icon" /></button>}
    </section>
  </>, document.body);
}
