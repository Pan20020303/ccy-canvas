/* @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilmLibrary } from './FilmLibrary';
const m=vi.hoisted(()=>({list:vi.fn(),migrate:vi.fn(),flush:vi.fn(),create:vi.fn(),navigate:vi.fn()}));
vi.mock('../../api/film-projects',()=>({listFilmProjects:m.list}));
vi.mock('./film-cloud',()=>({migrateFilmDraft:m.migrate,flushFilmProjects:m.flush,newCloudFilm:m.create}));
vi.mock('react-router',async()=>({...await vi.importActual('react-router'),useNavigate:()=>m.navigate}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT=true;
describe('film project library',()=>{
  let host:HTMLDivElement,root:Root;
  const render=()=>act(async()=>{root.render(<MemoryRouter><FilmLibrary userId="user" /></MemoryRouter>);});
  const click=async(text:string)=>{const button=[...host.querySelectorAll('button')].find(b=>b.textContent?.includes(text)||b.getAttribute('aria-label')===text);expect(button).toBeTruthy();await act(async()=>button!.click());};
  beforeEach(()=>{
    vi.clearAllMocks();host=document.createElement('div');document.body.append(host);root=createRoot(host);
    m.migrate.mockResolvedValue(false);m.flush.mockResolvedValue(undefined);m.create.mockResolvedValue('new-project');
    m.list.mockResolvedValue([
      {id:'one',name:'第一集',excerpt:'云上的车站',cover_url:'',step:2,completed:false,updated_at:'2026-09-18T00:00:00Z'},
      {id:'two',name:'第二集',excerpt:'告别车站',cover_url:'',step:5,completed:true,updated_at:'2026-09-19T00:00:00Z'},
    ]);
  });
  afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
  it('opens with database projects instead of an empty editor and navigates to the selected one',async()=>{
    await render();expect(host.textContent).toContain('共 2 项');expect(host.querySelector('.film-script')).toBeNull();
    expect([...host.querySelectorAll('.film-card-name')].map(e=>e.textContent)).toEqual(['第二集','第一集']);
    await click('打开项目：第一集');expect(m.navigate).toHaveBeenCalledWith('/studio/film/one');
    expect(m.create).not.toHaveBeenCalled();
  });
  it('creates a separate project only when requested',async()=>{
    await render();await click('创建单集');expect(m.create).toHaveBeenCalledWith('user',expect.objectContaining({name:'未命名项目',script:''}));expect(m.navigate).toHaveBeenCalledWith('/studio/film/new-project');
  });
  it('keeps the same draft identity when retrying a failed creation',async()=>{
    m.create.mockRejectedValueOnce(new Error('离线'));await render();await click('创建单集');expect(host.textContent).toContain('创建失败');
    await click('创建单集');expect(m.create.mock.calls[0][1].id).toBe(m.create.mock.calls[1][1].id);
  });
  it('supports search and status filtering without deleting stored projects',async()=>{
    await render();const search=host.querySelector('input')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'第一集');search.dispatchEvent(new Event('input',{bubbles:true}));});
    expect(host.querySelectorAll('.film-card-name')).toHaveLength(1);expect(host.textContent).toContain('共 2 项');
    await act(async()=>{const select=host.querySelector('select')!;select.value='completed';select.dispatchEvent(new Event('change',{bubbles:true}));});
    expect(host.textContent).toContain('没有找到匹配的作品');
  });
  it('reports a load failure rather than showing a false empty library',async()=>{
    m.list.mockRejectedValueOnce(new Error('数据库不可用'));await render();expect(host.textContent).toContain('数据库不可用');expect(host.textContent).not.toContain('还没有项目');
    await click('重试加载');expect(host.textContent).toContain('第一集');
  });
  it('keeps the library available when migration fails and visibly protects the legacy draft',async()=>{
    m.migrate.mockRejectedValueOnce(new Error('迁移失败'));await render();expect(host.textContent).toContain('旧草稿尚未迁移');expect(host.textContent).toContain('原内容仍保留在本机');expect(host.textContent).toContain('第一集');
  });
});
