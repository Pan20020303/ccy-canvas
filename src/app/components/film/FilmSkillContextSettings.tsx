import { useRef, useState } from 'react';
import { CREATIVE_DOCUMENTS, CREATIVE_SKILLS, CREATIVE_STAGE_NAMES, CREATIVE_VERSION, readCreativeDocument, selectCreativeDocuments, type CreativeSkillSettings, type CreativeStage } from './film-skill-context';
import './film-skill-context.css';

export function FilmSkillContextSettings({ value, onChange, script = '' }: { value?: CreativeSkillSettings; onChange: (value: CreativeSkillSettings) => void; script?: string }) {
  const [stage, setStage] = useState<CreativeStage>('extract');
  const [assetType, setAssetType] = useState('character');
  const [preview, setPreview] = useState<{ title: string; body: string; path: string }>();
  const [loading, setLoading] = useState(''), [error, setError] = useState('');
  const sequence = useRef(0);
  const ids = value?.skillIds ?? CREATIVE_SKILLS.map(skill => skill.id);
  const enabled = value?.enabled !== false;
  const docs = selectCreativeDocuments({ stage, assetType, text: script, settings: value });
  const view = async (id: string) => {
    const request = ++sequence.current;
    setLoading(id); setError(''); setPreview(undefined);
    try {
      const body = await readCreativeDocument(id), doc = CREATIVE_DOCUMENTS.find(d => d.id === id)!;
      if (request === sequence.current) setPreview({ title: doc.title, body, path: doc.path });
    } catch { if (request === sequence.current) setError('资料读取失败，请重试。'); }
    finally { if (request === sequence.current) setLoading(''); }
  };
  return <section className="film-creative-context" aria-label="创作工作台技能上下文">
    <div className="film-creative-heading"><h3>创作工作台 <small>v{CREATIVE_VERSION}</small></h3><label><input type="checkbox" checked={enabled} onChange={e => onChange({ ...value, enabled: e.target.checked })} />按需读取技能上下文</label></div>
    <p className="film-muted film-small">只在提交对应文字任务时加载相关章节。开关控制附加上下文；独立的“剧本医生优化”始终读取医生核心章节，确认采用后才生成分镜。不直接触发生图或视频生成。</p>
    <div className="film-creative-skills">{CREATIVE_SKILLS.map(skill => <label key={skill.id} className="film-creative-skill"><input type="checkbox" disabled={!enabled} checked={ids.includes(skill.id)} onChange={e => onChange({ ...value, skillIds: e.target.checked ? [...ids, skill.id] : ids.filter(id => id !== skill.id) })} /><span><strong>{skill.name}</strong><small className="film-muted">{skill.description}</small><small className="film-muted">{skill.stages.map(s => CREATIVE_STAGE_NAMES[s as CreativeStage]).join(' · ')}</small></span></label>)}</div>
    <label className="film-form-field">打斗上下文<select className="film-select" aria-label="打斗上下文" disabled={!enabled || !ids.includes('sd05-fight-director')} value={value?.fightMode || 'auto'} onChange={e => onChange({ ...value, fightMode: e.target.value as CreativeSkillSettings['fightMode'] })}><option value="auto">按剧本关键词判断</option><option value="on">主动加入（仅指导已有打斗段）</option><option value="off">不加入</option></select></label>
    <details><summary>查看各步骤将读取的资料</summary><div className="film-creative-preview-controls"><select aria-label="预览技能步骤" className="film-select" value={stage} onChange={e => setStage(e.target.value as CreativeStage)}>{Object.entries(CREATIVE_STAGE_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>{stage === 'describe' && <select aria-label="预览资产类型" className="film-select" value={assetType} onChange={e => setAssetType(e.target.value)}><option value="character">人物</option><option value="scene">场景</option><option value="prop">道具</option></select>}</div>
      <p className="film-muted film-small">{docs.length ? `本步骤读取 ${docs.length} 个章节；点击查看原文节选。` : '本步骤不附加工作台上下文。'}任务提交后，可在任务详情查看实际使用的资料。</p>
      <div className="film-creative-documents">{docs.map(doc => <button className="film-button" key={doc.id} onClick={() => void view(doc.id)} disabled={loading === doc.id}>{loading === doc.id ? '读取中…' : doc.title}</button>)}</div>
      {error && <p role="alert" className="film-error">{error}</p>}{preview && <article className="film-creative-document"><strong>{preview.title}</strong><small>{preview.path}</small><pre>{preview.body}</pre></article>}
    </details>
  </section>;
}
