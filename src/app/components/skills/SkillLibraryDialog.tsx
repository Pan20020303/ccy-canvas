import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowDownWideNarrow, ChevronLeft, ChevronRight, Compass, FileUp, Grid2X2, Loader2, MoreHorizontal, Search, Sparkles, X } from 'lucide-react';
import { createSkill, type Skill } from '../../api/skills';
import { filterSkillLibrary, getSkillCategoryOptions, getSkillDisplayName, getSkillCategoryLabel, type SkillSourceFilter } from '../../skill-display';
import { parseSkillMarkdown } from '../settings/skill-import';
import { LibraryFeedback, SkillIcon, sortLibrarySkills, skillScopeLabel, type SkillSort, type LibraryStatus } from './skill-library-presenters';
import { SkillDetail } from './SkillDetail';
import './skill-library.css';

export type SkillLibraryDialogProps = LibraryStatus & {
  open: boolean; skills: Skill[]; onClose: () => void; onPick: (skill: Skill) => void;
  onSkillsChanged?: (nextSkills?: Skill[]) => void | Promise<void>; zh: boolean;
};
const PAGE_SIZE = 20;
export function SkillLibraryDialog({ open, skills, onClose, onPick, onSkillsChanged, zh, ...status }: SkillLibraryDialogProps) {
  const [source, setSource] = useState<SkillSourceFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<SkillSort>('latest');
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [localSkills, setLocalSkills] = useState(skills);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => setLocalSkills(skills), [skills]);
  useEffect(() => { if (!open) setDetailId(null); }, [open]);
  const detail = localSkills.find(skill => skill.id === detailId) ?? null;
  const sourceSkills = useMemo(() => filterSkillLibrary(localSkills.filter(skill => skill.enabled), { source }), [localSkills, source]);
  const categories = useMemo(() => getSkillCategoryOptions(sourceSkills), [sourceSkills]);
  const filtered = useMemo(() => sortLibrarySkills(filterSkillLibrary(sourceSkills, { keyword, category }), sort), [sourceSkills, keyword, category, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const pageStart = Math.max(1, Math.min(currentPage - 2, pages - 4));
  const pageNumbers = Array.from({ length: Math.min(5, pages) }, (_, i) => pageStart + i);
  useEffect(() => { setPage(1); }, [keyword, category, source, sort]);
  useEffect(() => { listRef.current?.scrollTo?.({ top: 0 }); }, [currentPage, keyword, category, source, sort, detailId]);
  const choose = (skill: Skill) => { if (skill.enabled) { onPick(skill); onClose(); } };
  const importSkill = async (file: File) => {
    setUploading(true); setUploadError('');
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error(zh ? '文件不能超过 2MB' : 'Maximum file size is 2MB');
      const content = await file.text();
      if (!content.trim()) throw new Error(zh ? '技能文件不能为空' : 'The skill file is empty');
      const created = await createSkill(parseSkillMarkdown(content, file.name.replace(/\.(md|markdown|txt)$/i, '')));
      const next = [...localSkills.filter(skill => skill.id !== created.id), created];
      setLocalSkills(next); setSource('personal'); setKeyword(''); setCategory(''); setPage(1); setDetailId(created.id);
      await onSkillsChanged?.(next);
    } catch (error) { setUploadError(`${zh ? '上传失败：' : 'Upload failed: '}${error instanceof Error ? error.message : String(error)}`); }
    finally { setUploading(false); }
  };
  const selectSource = (next: SkillSourceFilter) => { setSource(next); setCategory(''); setDetailId(null); };
  const sectionTitle = source === 'all' ? (zh ? '探索' : 'Explore') : (zh ? '我的技能' : 'My skills');
  return <Dialog.Root open={open} onOpenChange={next => { if (!next && !uploading) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="skill-library-backdrop" />
    <Dialog.Content className="skill-library-dialog" aria-describedby={undefined} onKeyDown={event => event.stopPropagation()} onOpenAutoFocus={event => { event.preventDefault(); searchRef.current?.focus(); }} onEscapeKeyDown={event => { event.stopPropagation(); if (uploading) event.preventDefault(); }}>
      <aside className="skill-library-sidebar">
        <Dialog.Title className="skill-library-title">{zh ? '技能' : 'Skills'}</Dialog.Title>
        <nav className="skill-library-nav" aria-label={zh ? '技能导航' : 'Skill navigation'}>
          <button className={`skill-nav-item ${source === 'all' ? 'is-active' : ''}`} aria-current={source === 'all' ? 'page' : undefined} onClick={() => selectSource('all')}><Compass size={17} className="skill-control-icon" />{zh ? '探索' : 'Explore'}</button>
          <button className={`skill-nav-item ${source === 'personal' ? 'is-active' : ''}`} aria-current={source === 'personal' ? 'page' : undefined} onClick={() => selectSource('personal')}><Grid2X2 size={17} className="skill-control-icon" />{zh ? '我的技能' : 'My skills'}</button>
        </nav>
        <button className="skill-upload-button" disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? <Loader2 size={15} className="skill-spinner" /> : <FileUp size={15} className="skill-control-icon" />}{zh ? (uploading ? '正在上传…' : '上传技能') : (uploading ? 'Uploading…' : 'Upload skill')}</button>
        <input ref={fileRef} className="skill-hidden-input" type="file" aria-label={zh ? '上传技能文件' : 'Upload skill file'} accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importSkill(file); }} />
      </aside>
      <main className="skill-library-main">
        <header className="skill-library-header">
          {detail ? <nav className="skill-breadcrumb" aria-label={zh ? '技能位置' : 'Skill breadcrumb'}><button className="skill-text-button" onClick={() => setDetailId(null)}>{sectionTitle}</button><ChevronRight size={14} className="skill-control-icon" /><span className="skill-breadcrumb-name">{getSkillDisplayName(detail)}</span></nav> : <h3 className="skill-library-heading">{sectionTitle}</h3>}
          <div className="skill-library-header-actions">
            {!detail && <><label className="skill-sort"><ArrowDownWideNarrow size={14} className="skill-control-icon" /><select className="skill-sort-select" aria-label={zh ? '技能排序' : 'Sort skills'} value={sort} onChange={event => setSort(event.target.value as SkillSort)}><option value="latest">{zh ? '最新' : 'Latest'}</option><option value="name">{zh ? '名称' : 'Name'}</option></select></label><label className="skill-search skill-library-search"><Search size={14} className="skill-search-icon" /><input ref={searchRef} className="skill-search-input" aria-label={zh ? '搜索技能' : 'Search skills'} placeholder={zh ? '搜索技能' : 'Search skills'} value={keyword} onChange={event => setKeyword(event.target.value)} /></label></>}
            <Dialog.Close className="skill-icon-button" aria-label={zh ? '关闭技能库' : 'Close skill library'} disabled={uploading}><X size={18} className="skill-control-icon" /></Dialog.Close>
          </div>
        </header>
        {uploadError && <div className="skill-feedback skill-feedback-error" role="alert">{uploadError}</div>}
        {detail ? <SkillDetail skill={detail} zh={zh} onPick={choose} /> : <>
          <div className="skill-category-tabs" role="group" aria-label={zh ? '技能分类' : 'Skill categories'}><button className={`skill-category ${!category ? 'is-active' : ''}`} aria-pressed={!category} onClick={() => setCategory('')}>{zh ? '全部' : 'All'}</button>{categories.map(item => <button key={item.key} className={`skill-category ${category === item.label ? 'is-active' : ''}`} aria-pressed={category === item.label} onClick={() => setCategory(item.label)}>{item.label}</button>)}</div>
          <LibraryFeedback {...status} zh={zh} />
          <div ref={listRef} className="skill-library-scroll">
            <div className="skill-library-grid">{visible.map(skill => <article className="skill-library-item" key={skill.id}>
              <button className="skill-item-select" onClick={() => setDetailId(skill.id)} aria-label={`${zh ? '查看技能' : 'View skill'}：${getSkillDisplayName(skill)}`} title={skill.description || getSkillDisplayName(skill)}><SkillIcon skill={skill} /><span className="skill-item-copy"><span className="skill-item-topline"><span className="skill-item-name">{getSkillDisplayName(skill)}</span><span className={`skill-scope skill-scope-${skill.scope}`}>{skillScopeLabel(skill, zh)}</span></span><span className="skill-item-description">{skill.description || getSkillCategoryLabel(skill)}</span></span></button>
              <button className="skill-icon-button skill-item-more" aria-label={`${zh ? '查看技能详情' : 'Skill details'}：${getSkillDisplayName(skill)}`} onClick={() => setDetailId(skill.id)}><MoreHorizontal size={17} className="skill-control-icon" /></button>
            </article>)}</div>
            {!visible.length && !status.loading && !status.error && <div className="skill-library-empty"><Sparkles size={26} className="skill-empty-icon" /><p className="skill-empty-title">{zh ? (source === 'personal' && !keyword && !category ? '还没有自己的技能' : '没有找到匹配的技能') : 'No matching skills'}</p><p className="skill-empty-description">{zh ? '试试其他关键词或分类，也可以上传技能文件。' : 'Try another search or upload a skill file.'}</p></div>}
          </div>
          <footer className="skill-library-footer"><nav className="skill-pagination" aria-label={zh ? '技能分页' : 'Skill pages'}><button className="skill-page" aria-label={zh ? '上一页' : 'Previous page'} disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14} className="skill-control-icon" /></button>{pageNumbers.map(number => <button className={`skill-page ${number === currentPage ? 'is-active' : ''}`} key={number} aria-label={`${zh ? '第' : 'Page'} ${number} ${zh ? '页' : ''}`.trim()} aria-current={number === currentPage ? 'page' : undefined} onClick={() => setPage(number)}>{number}</button>)}<button className="skill-page" aria-label={zh ? '下一页' : 'Next page'} disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={14} className="skill-control-icon" /></button></nav><span className="skill-library-count">{zh ? `共 ${filtered.length} 个` : `${filtered.length} skills`}</span></footer>
        </>}
      </main>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
