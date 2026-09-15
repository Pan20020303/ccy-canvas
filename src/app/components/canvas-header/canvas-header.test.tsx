/* @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Navbar } from '../Navbar';
import { useStore } from '../../store';
import { useAgentCanvasActivityStore } from '../agent/agent-canvas-activity';
import { createHeaderProject, prepareCanvasNavigation, switchHeaderProject } from './canvas-navigation';
import type { BackendProject } from '../../api/projects';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), logout: vi.fn(), credits: vi.fn(), projects: vi.fn(), folders: vi.fn(), news: vi.fn(), ledger: vi.fn(), save: vi.fn(), create: vi.fn(), switch: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { id:'u1',name:'创作者',email:'creator@example.test',role:'admin' }, creditSummary: {current_balance:98,daily_quota:100,consumed_today:2}, logout:mocks.logout,refreshCredits:mocks.credits }) }));
vi.mock('react-router', async () => ({ ...await vi.importActual('react-router'), useNavigate: () => mocks.navigate }));
vi.mock('../../api/projects', async () => ({ ...await vi.importActual('../../api/projects'), listProjects:mocks.projects, listFolders:mocks.folders }));
vi.mock('../../api/announcements', () => ({listAnnouncements:mocks.news}));
vi.mock('../../api/credits', async () => ({...await vi.importActual('../../api/credits'),listMyCreditLedger:mocks.ledger}));
vi.mock('../CollaborationControls', () => ({ CollaborationControls: ({compact}:{compact:boolean}) => <button className="collab-test" data-compact={compact}>协作</button> }));
vi.mock('../MediaThumb', () => ({ MediaThumb: ({src,alt,className}:{src:string;alt:string;className:string}) => <img src={src} alt={alt} className={className} /> }));
vi.mock('sonner', () => ({toast:{error:mocks.error,success:mocks.success,info:mocks.info}}));

const projects: BackendProject[] = [
  {id:'p1',name:'当前画布',updated_at:'2026-09-14',created_at:'2026-09-14',my_role:'creator'},
  {id:'p2',name:'协作短片',updated_at:'2026-09-13',created_at:'2026-09-13',is_collaborative:true,my_role:'collaborator'},
  {id:'p3',name:'镜头设计',updated_at:'2026-09-12',created_at:'2026-09-12',folder_id:'f1'},
  {id:'p4',name:'未知文件夹画布',updated_at:'2026-09-11',created_at:'2026-09-11',folder_id:'unknown'},
];
const initialState = useStore.getState();
let root: Root; let host: HTMLDivElement;
const button = (name: string, scope: ParentNode = document) => Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(b => b.getAttribute('aria-label') === name || b.textContent?.trim() === name)!;
const click = async (name: string, scope: ParentNode = document) => { const target = button(name,scope); expect(target, name).toBeTruthy(); await act(async () => target.click()); };
const menu = () => document.querySelector<HTMLElement>('[aria-label="画布切换菜单"]')!;
const fill = async (value: string) => { const input = document.querySelector<HTMLInputElement>('[aria-label="搜索画布"]')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})); }); };
const render = async () => { await act(async () => root.render(<Navbar />)); };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mocks.projects.mockResolvedValue(projects); mocks.folders.mockResolvedValue([{id:'f1',name:'作品集',created_at:'2026-09-14'}]); mocks.news.mockResolvedValue([]); mocks.ledger.mockResolvedValue([]);
  mocks.save.mockImplementation(async () => { useStore.setState({canvasSaveStatus:'saved'}); });
  mocks.create.mockResolvedValue({id:'created'}); mocks.switch.mockResolvedValue(undefined);
  useStore.setState({...initialState,language:'zh',theme:'dark',backendProjects:projects,activeBackendProjectId:'p1',activeProjectId:'p1',canvasHydrated:true,canvasSaveStatus:'saved',backendSyncing:false,activeRun:null,nodes:[],edges:[],groups:[],tasks:[],agentPanelOpen:false,saveCanvasToBackend:mocks.save,createBackendProject:mocks.create,switchBackendProject:mocks.switch});
  useAgentCanvasActivityStore.setState({runId:null,finished:true,phase:'hidden'});
  host=document.createElement('div'); document.body.append(host); root=createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useStore.setState(initialState); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('reference-style canvas header', () => {
  it('keeps the reference control order and real balance', async () => {
    await render();
    const labels=Array.from(host.querySelectorAll('.canvas-top-actions > button, .canvas-top-actions [aria-label]')).map(b=>b.getAttribute('aria-label') || b.textContent);
    expect(host.querySelector('.canvas-current-name')?.textContent).toBe('当前画布');
    expect(host.querySelector('.canvas-credit-amount')?.textContent).toBe('98');
    expect(labels).toContain('更多操作'); expect(labels).toContain('开通会员'); expect(labels).toContain('我的账户');
    expect(host.querySelector('.collab-test')?.getAttribute('data-compact')).toBe('true');
  });
  it('opens the real list, searches inside folders and filters collaboration', async () => {
    await render(); await click('切换画布');
    expect(menu().textContent).toContain('作品集'); expect(menu().textContent).toContain('未知文件夹画布');
    expect(menu().textContent).not.toContain('镜头设计');
    await click('作品集',menu()); expect(menu().textContent).toContain('镜头设计');
    await click('协作',menu()); expect(menu().textContent).toContain('协作短片'); expect(menu().textContent).not.toContain('当前画布');
    await click('全部',menu()); await fill('镜头');
    expect(menu().textContent).toContain('镜头设计'); expect(menu().textContent).not.toContain('协作短片');
    await fill('不存在'); expect(menu().textContent).toContain('没有找到匹配');
  });
  it('switches without navigating away, or saving the already active canvas', async () => {
    await render(); await click('切换画布'); await click('当前画布',menu());
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.switch).not.toHaveBeenCalled();
    await click('切换画布'); await click('协作短片协作',menu());
    expect(mocks.save).toHaveBeenCalled(); expect(mocks.switch).toHaveBeenCalledWith('p2'); expect(mocks.navigate).not.toHaveBeenCalled(); expect(menu()).toBeNull();
  });
  it('creates only after a successful save and retains the menu on errors', async () => {
    await render(); await click('切换画布');
    mocks.save.mockImplementationOnce(async () => {useStore.setState({canvasSaveStatus:'error'});});
    await click('新建画布'); expect(mocks.create).not.toHaveBeenCalled(); expect(menu()).toBeTruthy();
    mocks.create.mockResolvedValueOnce(null); await click('新建画布'); expect(mocks.error).toHaveBeenLastCalledWith(expect.stringContaining('新建画布失败')); expect(menu()).toBeTruthy();
    await click('新建画布'); expect(mocks.create).toHaveBeenLastCalledWith('未命名画布'); expect(menu()).toBeNull();
  });
  it('shows refresh errors rather than an invented empty library', async () => {
    mocks.projects.mockRejectedValueOnce(new Error('offline')); await render(); await click('切换画布');
    expect(menu().querySelector('[role="alert"]')).toBeTruthy(); expect(menu().textContent).toContain('当前画布');
    await click('重新加载画布列表'); expect(menu().querySelector('[role="alert"]')).toBeNull();
  });
  it('opens account access and does not pretend membership is available', async () => {
    await render(); await click('开通会员'); expect(document.querySelector('.account-center')?.textContent).toContain('会员订阅服务尚未开放');
    await click('关闭账户中心'); await click('我的账户'); expect(document.querySelector('.account-center')?.textContent).toContain('个人信息');
  });
  it('keeps settings, save, announcements and tasks under more', async () => {
    await render(); await click('更多操作'); const more=document.querySelector('[aria-label="更多操作与消息"]')!;
    expect(more.textContent).toContain('画布设置'); expect(more.textContent).toContain('公告'); expect(more.textContent).toContain('生成任务');
    await click('保存画布',more); expect(mocks.save).toHaveBeenCalled(); expect(mocks.success).toHaveBeenCalledWith('画布已保存');
  });
  it('dismisses menus with Escape and follows the actual Agent panel width', async () => {
    await render(); await click('更多操作');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    expect(document.querySelector('[aria-label="更多操作与消息"]')).toBeNull();
    await act(async () => useStore.setState({agentPanelOpen:true,agentPanelWidth:640}));
    expect(host.querySelector<HTMLElement>('.canvas-navbar')?.style.right).toBe('640px');
  });
});

describe('canvas navigation protections', () => {
  it('keeps live-agent edit protection but lets media continue while creating another canvas', async () => {
    useAgentCanvasActivityStore.setState({runId:'running',finished:false});
    await expect(prepareCanvasNavigation()).rejects.toThrow('Agent');
    expect(mocks.save).not.toHaveBeenCalled();
    useAgentCanvasActivityStore.setState({runId:null,finished:true});
    useStore.setState({activeRun:{nodeId:'run',startedAt:Date.now()}});
    await createHeaderProject(true,'new'); expect(mocks.create).toHaveBeenCalledWith('new');
  });
  it('lets a running generation leave for home or admin through the real account action', async () => {
    useStore.setState({activeRun:{nodeId:'run',startedAt:Date.now()}});
    await render(); await click('我的账户'); await click('管理后台');
    expect(mocks.navigate).toHaveBeenCalledWith('/admin');
    expect(mocks.error).not.toHaveBeenCalled();
    expect(useStore.getState().activeRun?.nodeId).toBe('run');
  });
  it('allows streamed output during save but still detects user edits', async () => {
    const node = {id:'run',type:'textNode',position:{x:0,y:0},data:{status:'running',content:'first',prompt:'write'}};
    useStore.setState({nodes:[node]});
    mocks.save.mockImplementationOnce(async () => {useStore.setState({nodes:[{...node,data:{...node.data,content:'next'}}],canvasSaveStatus:'saved'});});
    await prepareCanvasNavigation();
    mocks.save.mockImplementationOnce(async () => {useStore.setState({nodes:[{...node,position:{x:100,y:0}}],canvasSaveStatus:'saved'});});
    await expect(prepareCanvasNavigation()).rejects.toThrow('又有修改');
  });
  it('does not equate leaving a page with logging out mid-generation', async () => {
    useStore.setState({activeRun:{nodeId:'run',startedAt:Date.now()}});
    await expect(prepareCanvasNavigation({logout:true})).rejects.toThrow('退出账号');
  });
  it('keeps the original canvas after a failed target load', async () => {
    const originalNodes=useStore.getState().nodes;
    mocks.switch.mockImplementationOnce(async () => {useStore.setState({activeBackendProjectId:'p2',activeProjectId:'p2',nodes:[],canvasHydrated:false});});
    await expect(switchHeaderProject('p2',true)).rejects.toThrow('已保留');
    expect(useStore.getState().activeBackendProjectId).toBe('p1'); expect(useStore.getState().nodes).toBe(originalNodes);
  });
  it('does not issue a save for a read-only collaborator', async () => {
    useStore.setState({backendProjects:[{...projects[0],my_role:'visitor'}]});
    await prepareCanvasNavigation(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('rejects edits arriving while the save was in flight', async () => {
    mocks.save.mockImplementationOnce(async () => {useStore.setState({nodes:[],canvasSaveStatus:'saved'});});
    await expect(prepareCanvasNavigation()).rejects.toThrow('又有修改');
  });
});
