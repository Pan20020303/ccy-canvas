import { useEffect, useRef, useState } from 'react';
import { FileUp, RefreshCw, Sparkles } from 'lucide-react';
import { createSkill, listSkills, type Skill } from '../../api/skills';
import { parseSkillMarkdown } from '../settings/skill-import';
import { FilmDialog } from './FilmControls';
import { filmPromptSkills, filmSkillBody, type FilmModel, type FilmProject } from './film-project';
import { filmError } from './film-store';

export type FilmProductionConfig = Pick<FilmProject['settings'], 'textModel' | 'extractModel' | 'extractSkillId' | 'splitModel' | 'splitSkillId'>;

export function FilmProductionSettings({ settings, models, modelsLoading, modelError, userId, onRefreshModels, onSave, onClose }: {
  settings: FilmProject['settings']; models: FilmModel[]; modelsLoading: boolean; modelError: string; userId: string;
  onRefreshModels: () => void; onSave: (settings: FilmProductionConfig) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState<FilmProductionConfig>(() => ({ textModel: settings.textModel, extractModel: settings.extractModel, extractSkillId: settings.extractSkillId, splitModel: settings.splitModel, splitSkillId: settings.splitSkillId }));
  const [skills, setSkills] = useState<Skill[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [importing, setImporting] = useState(false), [markdown, setMarkdown] = useState(''), [importError, setImportError] = useState(''), [savingSkill, setSavingSkill] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null), importLock = useRef(false);
  const importName = markdown.trim() ? parseSkillMarkdown(markdown, '分镜技能').name : '';
  const importSkill = async () => {
    if (importLock.current || !markdown.trim()) return;
    importLock.current = true; setSavingSkill(true); setImportError('');
    try {
      if (new Blob([markdown]).size > 2 * 1024 * 1024) throw new Error('技能文件不能超过 2MB。');
      const payload = parseSkillMarkdown(markdown, '分镜技能');
      if (!filmSkillBody(payload)) throw new Error('技能正文不能为空。');
      const current = await listSkills(true);
      const matches = current.filter(s => s.name === payload.name);
      let selected = matches.find(s => s.enabled && s.kind === 'prompt' && filmSkillBody(s) === filmSkillBody(payload));
      if (!selected && matches.length) throw new Error('已有同名技能但内容不同或已停用，请在技能库编辑原技能，或修改文件中的 name 后再导入。');
      if (!selected) selected = await createSkill({ ...payload, category: payload.category === 'workflow' ? 'director_skills' : payload.category, spec: { ...payload.spec, slash_command: payload.spec.slash_command === 'imported-skill' ? payload.name : payload.spec.slash_command } });
      setSkills(filmPromptSkills([...current.filter(s => s.id !== selected.id), selected]));
      setDraft(d => ({ ...d, splitSkillId: selected.id })); setImporting(false); setMarkdown(''); setError('');
    } catch (e) { setImportError(filmError(e)); }
    finally { importLock.current = false; setSavingSkill(false); }
  };
  useEffect(() => {
    let ignore = false;
    setLoading(true); setError('');
    if (!userId) { setLoading(false); return; }
    listSkills(true).then(result => { if (!ignore) setSkills(filmPromptSkills(result)); })
      .catch(e => { if (!ignore) { setSkills([]); setError(filmError(e)); } })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [userId, reload]);
  const textModels = models.filter(m => m.type === 'text');
  const missingModel = (key: string) => Boolean(key && !textModels.some(m => m.key === key));
  const missingSkill = (id: string) => Boolean(id && !skills.some(s => s.id === id));
  const invalid = [draft.textModel, draft.extractModel, draft.splitModel].some(missingModel) || [draft.extractSkillId, draft.splitSkillId].some(missingSkill);
  const modelSelect = (key: 'textModel' | 'extractModel' | 'splitModel', label: string) => <select className="film-select" aria-label={label} value={draft[key]} disabled={modelsLoading} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}>
    <option value="">{key === 'textModel' ? (textModels[0] ? `自动 · ${textModels[0].name} · ${textModels[0].provider.name}` : '暂无可用文字模型') : '跟随默认文字模型'}</option>
    {missingModel(draft[key]) && <option value={draft[key]} disabled>已保存的模型不可用，请重新选择</option>}
    {textModels.map(m => <option value={m.key} key={m.key}>{m.name} · {m.provider.name}</option>)}
  </select>;
  return <FilmDialog title="制作设置" className="film-production-dialog" onClose={onClose}>
    <div className="film-production-intro"><p className="film-muted">为当前项目分别配置资产提取与分镜生成，使用后台已启用的文字模型和你的提示词技能。</p><button className="film-button" disabled={loading || modelsLoading} onClick={() => { setReload(v => v + 1); onRefreshModels(); }}><RefreshCw size={14} />刷新选项</button></div>
    {modelError && <p className="film-error" role="alert">模型加载失败：{modelError}</p>}
    {error && <p className="film-error" role="alert">技能加载失败：{error}。可刷新重试，或选择内置规则。</p>}
    {!userId && <p className="film-muted" role="status">登录后可读取技能和模型。</p>}
    <label className="film-production-default"><span>默认文字模型</span>{modelSelect('textModel', '默认文字模型')}<small className="film-muted">用于 AI 帮写，以及未单独指定模型的制作步骤。</small></label>
    <div className="film-production-stages">{([{ kind: 'extract', title: '场景角色道具提取', description: '从剧本中识别场景、角色、道具，并生成资产描述。' }, { kind: 'split', title: '分镜脚本', description: '把剧本拆解为镜头，规划景别、运镜、动作与连续性。' }] as const).map(({ kind, title, description }) => {
      const skillKey = `${kind}SkillId` as const, selected = skills.find(s => s.id === draft[skillKey]);
      return <section className="film-production-card" key={kind}><h3><Sparkles size={16} />{title}</h3><p className="film-muted">{description}</p>
        <label><span>生成模型</span>{modelSelect(`${kind}Model`, `${title}模型`)}</label>
        <label><span>使用技能</span><select className="film-select" aria-label={`${title}技能`} disabled={loading} value={draft[skillKey]} onChange={e => setDraft(d => ({ ...d, [skillKey]: e.target.value }))}>
          <option value="">内置{kind === 'extract' ? '资产提取' : '分镜'}规则</option>
          {missingSkill(draft[skillKey]) && <option value={draft[skillKey]} disabled>{loading ? '正在读取已选技能…' : '已保存的技能不可用，请重新选择'}</option>}
          {skills.map(s => <option key={s.id} value={s.id}>{s.name} · {s.scope === 'personal' ? '我的技能' : s.scope === 'team' ? '团队技能' : '公共技能'}</option>)}
        </select></label>
        <p className="film-production-skill-description film-muted">{selected?.description || (selected ? '使用该技能的提示词完成当前步骤。' : '使用项目内置的制作规则，无需额外选择技能。')}</p>
      </section>;
    })}</div>
    <button className="film-button film-import-skill" disabled={!userId || loading} onClick={() => { setImportError(''); setImporting(true); }}><FileUp size={15} />导入分镜技能</button>
    <p className="film-production-note film-muted" role="status">{loading ? '正在读取技能…' : `可用提示词技能 ${skills.length} 个。`}技能用于指导生成，工作台按统一格式整理镜头，视频提示词保持自然语言。保存只影响新任务和失败重试，不会修改正在运行的任务。</p>
    {invalid && !loading && !modelsLoading && <p className="film-error" role="alert">部分已选技能或模型不可用，请重新选择后保存。</p>}
    <footer className="film-dialog-footer"><button className="film-button" onClick={onClose}>取消</button><button className="film-primary" disabled={loading || modelsLoading || Boolean(modelError) || invalid || !textModels.length} onClick={() => onSave(draft)}>保存设置</button></footer>
    {importing && <FilmDialog title="导入分镜技能" onClose={() => { if (!savingSkill) setImporting(false); }}>
      <p className="film-dialog-copy">上传 Markdown 文件或粘贴全文。原文将保存到“我的技能”，并选为分镜技能；返回后点击“保存设置”应用到当前项目。</p>
      <button className="film-button" disabled={savingSkill} onClick={() => fileRef.current?.click()}><FileUp size={14} />选择 Markdown 文件</button>
      <input hidden ref={fileRef} type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" aria-label="分镜技能文件" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; if (file.size > 2 * 1024 * 1024) { setImportError('技能文件不能超过 2MB。'); return; } void file.text().then(text => { setMarkdown(text); setImportError(''); }).catch(err => setImportError(filmError(err))); }} />
      <textarea className="film-dialog-textarea film-skill-markdown" aria-label="分镜技能 Markdown 内容" placeholder="粘贴包含 name、description 的 Markdown 技能文件全文…" value={markdown} disabled={savingSkill} onChange={e => setMarkdown(e.target.value)} />
      {importName && <p className="film-muted film-small">技能名称：{importName} · {markdown.length.toLocaleString()} 字符</p>}
      {importError && <p className="film-error" role="alert">{importError}</p>}
      <footer className="film-dialog-footer"><button className="film-button" disabled={savingSkill} onClick={() => setImporting(false)}>取消导入</button><button className="film-primary" disabled={!markdown.trim() || savingSkill} onClick={() => void importSkill()}>{savingSkill ? '正在导入…' : '导入并选用'}</button></footer>
    </FilmDialog>}
  </FilmDialog>;
}
