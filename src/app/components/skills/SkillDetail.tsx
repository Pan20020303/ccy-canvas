import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Play, X } from 'lucide-react';
import type { Skill } from '../../api/skills';
import { getSkillDisplayName, getSkillCategoryLabel } from '../../skill-display';
import { getSkillCommandName, getSkillTemplateBody } from '../settings/skill-agent-presenters';
import { safeSkillMediaUrl, SkillIcon, skillScopeLabel } from './skill-library-presenters';

type Example = { url: string; type: 'image' | 'video'; title: string; poster: string };
export function skillExamples(skill: Skill): Example[] {
  if (!Array.isArray(skill.spec.examples)) return [];
  return skill.spec.examples.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const data = item as Record<string, unknown>, url = safeSkillMediaUrl(data.url);
    if (!url || (data.type !== 'image' && data.type !== 'video')) return [];
    return [{ url, type: data.type, title: typeof data.title === 'string' ? data.title : '', poster: safeSkillMediaUrl(data.poster) }];
  });
}
function textField(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }
function dateLabel(value: string, zh: boolean) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString(zh ? 'zh-CN' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }
export function SkillDetail({ skill, zh, onPick }: { skill: Skill; zh: boolean; onPick: (skill: Skill) => void }) {
  const [preview, setPreview] = useState<Example | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const body = getSkillTemplateBody(skill);
  const examples = skillExamples(skill);
  const name = getSkillDisplayName(skill);
  const version = textField(skill.spec.version);
  const notes = textField(skill.spec.version_notes);
  const history = Array.isArray(skill.spec.version_history) ? skill.spec.version_history.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object') : [];
  const facts = [
    [zh ? '类别' : 'Category', getSkillCategoryLabel(skill)],
    [zh ? '来源' : 'Source', skillScopeLabel(skill, zh)],
    [zh ? '类型' : 'Type', skill.kind === 'prompt' ? (zh ? '提示词技能' : 'Prompt skill') : skill.kind === 'http' ? 'HTTP' : (zh ? '代码技能' : 'Code skill')],
    [zh ? '版本' : 'Version', version || (zh ? '未标注' : 'Not provided')],
    [zh ? '提示词' : 'Prompt', zh ? `${Array.from(body).length.toLocaleString()} 字` : `${Array.from(body).length.toLocaleString()} characters`],
    [zh ? '创建时间' : 'Created', dateLabel(skill.created_at, zh)],
    [zh ? '更新时间' : 'Updated', dateLabel(skill.updated_at, zh)],
  ];
  return <div className="skill-detail-scroll"><div className="skill-detail">
    <div className="skill-detail-summary"><SkillIcon skill={skill} /><div className="skill-detail-titles"><h4 className="skill-detail-name">{name}</h4><p className="skill-detail-meta">{getSkillCategoryLabel(skill)} · {getSkillCommandName(skill)}</p></div><button className="skill-use-button" disabled={!skill.enabled} onClick={() => onPick(skill)}>{zh ? '使用技能' : 'Use skill'}</button></div>
    <div className="skill-detail-banner"><div className="skill-detail-banner-label"><SkillIcon skill={skill} small /><strong className="skill-detail-banner-name">{name}</strong><span className="skill-detail-banner-hint">{zh ? '选择后添加到当前对话' : 'Add to the current conversation'}</span></div></div>
    <p className="skill-detail-description">{skill.description || (zh ? '作者暂未填写介绍。' : 'The author has not provided a description.')}</p>
    <section className="skill-detail-section"><h5 className="skill-detail-section-title">{zh ? '示例作品' : 'Examples'} <span className="skill-detail-muted">{examples.length ? `${examples.length} · ${zh ? '点击查看大图' : 'Click to preview'}` : ''}</span></h5>
      {examples.length ? <div className="skill-example-grid">{examples.map((example, i) => <button className="skill-example" key={`${example.url}:${i}`} onClick={() => { setPreviewError(false); setPreview(example); }} aria-label={example.title || `${zh ? '预览示例' : 'Preview example'} ${i + 1}`}>
        {example.type === 'image' ? <img className="skill-example-image" src={example.url} alt={example.title} loading="lazy" /> : example.poster ? <img className="skill-example-image" src={example.poster} alt="" loading="lazy" /> : <video className="skill-example-image" src={example.url} preload="metadata" muted />}
        {example.type === 'video' && <span className="skill-example-play"><Play className="skill-control-icon" size={17} /></span>}<span className="skill-example-title">{example.title || (example.type === 'video' ? (zh ? '视频' : 'Video') : (zh ? '图片' : 'Image'))}</span>
      </button>)}</div> : <p className="skill-detail-muted">{zh ? '作者暂未提供示例作品。' : 'No examples provided yet.'}</p>}
    </section>
    <section className="skill-detail-section"><h5 className="skill-detail-section-title">{zh ? '信息' : 'Information'}</h5><dl className="skill-detail-facts">{facts.map(([label, value]) => <div className="skill-fact" key={label}><dt className="skill-fact-label">{label}</dt><dd className="skill-fact-value">{value}</dd></div>)}</dl></section>
    <section className="skill-detail-section"><h5 className="skill-detail-section-title">{zh ? '当前版本说明' : 'Release notes'}</h5><p className="skill-detail-description">{notes || (zh ? '作者暂未填写版本说明。' : 'No release notes provided.')}</p></section>
    <section className="skill-detail-section"><h5 className="skill-detail-section-title">{zh ? '版本历史' : 'Version history'}</h5>{history.length ? <ol className="skill-version-history">{history.map((item, index) => <li className="skill-version-entry" key={index}><strong className="skill-version-name">{textField(item.version) || '—'}</strong><span className="skill-detail-muted">{textField(item.date) ? dateLabel(textField(item.date), zh) : ''}</span><p className="skill-detail-description">{textField(item.notes)}</p></li>)}</ol> : <p className="skill-detail-muted">{zh ? '尚无已记录的历史版本。' : 'No recorded version history.'}</p>}</section>
    {body && <details className="skill-detail-section"><summary className="skill-detail-section-title">{zh ? '查看技能提示词' : 'View skill prompt'}</summary><pre className="skill-detail-content">{body}</pre></details>}
    <Dialog.Root open={Boolean(preview)} onOpenChange={next => { if (!next) setPreview(null); }}>
      <Dialog.Portal><Dialog.Overlay className="skill-example-preview-backdrop" />
        <Dialog.Content className="skill-example-preview" aria-describedby={undefined} onKeyDown={event => event.stopPropagation()}>
          <Dialog.Title className="skill-example-preview-title">{preview?.title || (zh ? '示例预览' : 'Example preview')}</Dialog.Title>
          <Dialog.Close className="skill-icon-button skill-example-preview-close" aria-label={zh ? '关闭示例预览' : 'Close example preview'}><X className="skill-control-icon" size={20} /></Dialog.Close>
          {previewError ? <p role="alert">{zh ? '示例加载失败，资源可能已失效或暂时无法访问。' : 'This example could not be loaded. The resource may have expired or be temporarily unavailable.'}</p>
            : preview?.type === 'video' ? <video className="skill-example-preview-media" src={preview.url} controls autoPlay playsInline onError={() => setPreviewError(true)} />
              : preview ? <img className="skill-example-preview-media" src={preview.url} alt={preview.title || name} onError={() => setPreviewError(true)} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div></div>;
}
