import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowLeft, ArrowUpRight, Check, Clapperboard, Cloud, LoaderCircle, Plus, Quote, RefreshCw, Search } from 'lucide-react';
import { listFilmProjects, type FilmSummary } from '../../api/film-projects';
import { toRenderableMediaUrl } from '../../reference-media';
import { FILM_STEPS, newFilmProject } from './film-project';
import { filmError } from './film-store';
import { flushFilmProjects, migrateFilmDraft, newCloudFilm } from './film-cloud';

export function FilmLibrary({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<FilmSummary[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [order, setOrder] = useState('desc');
  const [tick, setTick] = useState(0), [creating, setCreating] = useState(false), [notice, setNotice] = useState('');
  const creatingLock = useRef(false), draft = useRef(newFilmProject());
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(''); setNotice('');
    void (async () => {
      // A failed save must not hide already-saved projects or pretend it succeeded.
      try { await flushFilmProjects(userId); } catch { if (!cancelled) setNotice('有项目尚未同步，请打开该项目重试保存。本机修改仍保留。'); }
      try { if (await migrateFilmDraft(userId) && !cancelled) setNotice('已将原本机草稿迁移到数据库，原备份仍保留。'); }
      catch (e) { if (!cancelled) setNotice(`旧草稿尚未迁移：${filmError(e)} 原内容仍保留在本机，可点击刷新重试。`); }
      const list = await listFilmProjects(); if (!cancelled) setProjects(list);
    })().catch(e => { if (!cancelled) setError(filmError(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId, tick]);
  const create = async () => {
    if (creatingLock.current) return;
    creatingLock.current = true; setCreating(true); setError('');
    try { const id = await newCloudFilm(userId, draft.current); navigate(`/studio/film/${id}`); }
    catch (e) { setError(`创建失败：${filmError(e)}`); }
    finally { creatingLock.current = false; setCreating(false); }
  };
  const visible = projects.filter(p => (filter === 'all' || (filter === 'completed' ? p.completed : !p.completed)) && `${p.name} ${p.excerpt}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => (order === 'desc' ? -1 : 1) * (Date.parse(a.updated_at) - Date.parse(b.updated_at)));
  return <main className="film-library">
    <header className="film-library-heading"><button className="film-icon" aria-label="返回首页" onClick={() => navigate('/home')}><ArrowLeft size={19} /></button><div><h1>一键成片</h1><p>从一个故事，到一部作品</p></div><span className="film-spacer" /><span className="film-library-cloud"><Cloud size={16} />项目存储于云端数据库</span></header>
    <div className="film-library-toolbar"><strong>{loading ? '正在加载项目…' : `共 ${projects.length} 项`}</strong><span className="film-spacer" />
      <button className="film-button" aria-label="刷新项目列表" disabled={loading} onClick={() => setTick(v => v + 1)}><RefreshCw size={14} />刷新</button>
      <select className="film-select" aria-label="项目类型" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部类型</option><option value="draft">制作中</option><option value="completed">已成片</option></select>
      <select className="film-select" aria-label="项目排序" value={order} onChange={e => setOrder(e.target.value)}><option value="desc">更新时间倒序</option><option value="asc">更新时间正序</option></select>
      <label className="film-library-search"><Search size={16} /><input aria-label="搜索作品" placeholder="搜索作品" value={query} onChange={e => setQuery(e.target.value)} /></label>
    </div>
    {notice && <div className="film-library-notice" role="status">{notice}</div>}
    {error && <div className="film-library-notice film-error" role="alert">{error}<button className="film-button" onClick={() => setTick(v => v + 1)}>重试加载</button></div>}
    <section className="film-library-grid" aria-label="成片项目">
      <button className="film-project-card film-create-card" disabled={creating || loading} onClick={() => void create()}><span className="film-create-symbol">{creating ? <LoaderCircle className="film-spin" size={25} /> : <Plus size={26} />}</span><strong>{creating ? '正在创建…' : '创建单集'}</strong><small>添加剧本，开启新的创作</small></button>
      {visible.map((p, index) => <button className="film-project-card" key={p.id} onClick={() => navigate(`/studio/film/${p.id}`)} aria-label={`打开项目：${p.name}`}>
        <div className={`film-card-cover film-card-color-${index % 4}`}>
          {p.cover_url ? <img src={toRenderableMediaUrl(p.cover_url)} alt="" loading="lazy" /> : p.excerpt ? <div className="film-card-excerpt"><Quote size={23} /><p>{p.excerpt}</p></div> : <Clapperboard size={44} strokeWidth={1.25} />}
          <span className="film-card-step">{p.completed ? <><Check size={12} />已成片</> : FILM_STEPS[p.step]}</span>
        </div>
        <strong className="film-card-name" title={p.name}>{p.name}</strong><div className="film-card-footer"><span>最后更新：{new Date(p.updated_at).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span><ArrowUpRight size={16} /></div>
      </button>)}
    </section>
    <p className="film-library-end">{loading ? '正在从数据库读取项目…' : error ? '项目加载未完成，请重试' : !projects.length ? '还没有项目，点击「创建单集」开始。' : !visible.length ? '没有找到匹配的作品' : '已加载全部内容'}</p>
  </main>;
}
