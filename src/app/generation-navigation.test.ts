import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), stream: vi.fn(), getTask: vi.fn(), batch: vi.fn(),
  getCanvas: vi.fn(), save: vi.fn(), history: vi.fn(), warning: vi.fn() }));
vi.mock('./api/providerConfigs', async () => ({ ...await vi.importActual('./api/providerConfigs'), generate: mocks.generate, generateStream: mocks.stream }));
vi.mock('./api/tasks', () => ({ getTask: mocks.getTask, batchTasksByNodeIds: mocks.batch, listActiveTasks: async () => [] }));
vi.mock('./api/projects', async () => ({ ...await vi.importActual('./api/projects'), getCanvas: mocks.getCanvas, saveCanvas: mocks.save }));
vi.mock('./api/history', () => ({ saveHistoryToServer: mocks.history }));
vi.mock('sonner', () => ({ toast: { warning: mocks.warning } }));

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const node = (id = 'shared-id', type = 'imageNode'): Node => ({id, type, position: {x:10,y:20}, data: {prompt:'draw'}});
let useStore: (typeof import('./store'))['useStore'];
let bindStorageToUser: (typeof import('./store'))['bindStorageToUser'];
let eventSource: {onmessage: ((e: {data:string}) => void) | null};
let canvases: Map<string, {nodes: Node[]; edges: []; groups: []; version: number}>;
const data = (project: string) => useStore.getState().projectStateById[project].nodes[0].data;
const task = (project = 'p1', status = 'success') => ({id:`task-${project}`,node_id:'shared-id',project_id:project,
  service_type:'image',model:'gpt-image-2',status,result_url:`/uploads/${project}.png`,error_msg:'provider failed',created_at:new Date().toISOString()});
const settle = async () => { for (let i=0;i<15;i++) await Promise.resolve(); };

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers();
  const local = new Map<string,string>();
  vi.stubGlobal('localStorage', {getItem:(k:string)=>local.get(k)??null,setItem:(k:string,v:string)=>local.set(k,v),removeItem:(k:string)=>local.delete(k)});
  vi.stubGlobal('EventSource', class {onmessage=null; onopen=null; onerror=null; close() {} constructor() {eventSource=this;} });
  mocks.batch.mockResolvedValue([]); mocks.getTask.mockResolvedValue({...task(),status:'running',result_url:''}); mocks.history.mockResolvedValue({});
  canvases = new Map(['p1','p2'].map(id=>[id,{nodes:[node()],edges:[],groups:[],version:1}]));
  mocks.save.mockImplementation(async (id:string,nodes:Node[],edges:[],groups:[]) => {
    const saved = {nodes,edges,groups,version:(canvases.get(id)?.version??0)+1}; canvases.set(id,saved); return saved;
  });
  mocks.getCanvas.mockImplementation(async (id:string) => canvases.get(id));
  ({useStore,bindStorageToUser}=await import('./store'));
  useStore.setState({activeProjectId:'p1',activeBackendProjectId:'p1',canvasHydrated:true,backendSyncing:false,
    confirmBeforeGenerate:false,nodes:[node()],edges:[],groups:[],activeRun:null,
    backendProjects:['p1','p2'].map(id=>({id,name:id,created_at:'',updated_at:'',my_role:'creator'})),
    projectStateById:Object.fromEntries(canvases),history:[]});
});
afterEach(() => {vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();});

describe('generation survives canvas navigation', () => {
  it.each(['imageNode','videoNode'])('routes an in-flight %s HTTP result and history to its origin, even with duplicate node ids', async type => {
    useStore.setState({ nodes: [node('shared-id',type)] });
    const result=deferred<{type:'url';content:string}>(); mocks.generate.mockReturnValueOnce(result.promise);
    const running=useStore.getState().runNode('shared-id',{prompt:'draw',model:'gpt-image-2'});
    await settle(); expect(mocks.generate).toHaveBeenCalled();
    await useStore.getState().switchBackendProject('p2');
    result.resolve({type:'url',content:'/uploads/result.png'}); await running;
    expect(useStore.getState().activeBackendProjectId).toBe('p2');
    expect(useStore.getState().nodes[0].data.url).toBeUndefined();
    expect(data('p1').url).toBe('/uploads/result.png');
    expect(useStore.getState().history[0].projectId).toBe('p1');
    await vi.advanceTimersByTimeAsync(2100);
    expect(canvases.get('p1')!.nodes[0].data.url).toBe('/uploads/result.png');
    await useStore.getState().switchBackendProject('p1');
    expect(useStore.getState().nodes[0].data.url).toBe('/uploads/result.png');
  });
  it('does not cancel or clear another canvas run with the same node id', async () => {
    const a=deferred<{type:'url';content:string}>(), b=deferred<{type:'url';content:string}>();
    mocks.generate.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first=useStore.getState().runNode('shared-id',{prompt:'A',model:'gpt-image-2'}); await settle();
    const signal=mocks.generate.mock.calls[0][1] as AbortSignal;
    await useStore.getState().switchBackendProject('p2');
    const second=useStore.getState().runNode('shared-id',{prompt:'B',model:'gpt-image-2'}); await settle();
    expect(signal.aborted).toBe(false);
    a.resolve({type:'url',content:'/uploads/a.png'}); await first;
    expect(useStore.getState().activeRun?.nodeId).toBe('shared-id');
    expect(useStore.getState().nodes[0].data.status).toBe('running');
    b.resolve({type:'url',content:'/uploads/b.png'}); await second;
    expect(data('p1').url).toBe('/uploads/a.png'); expect(data('p2').url).toBe('/uploads/b.png');
  });
  it.each(['success','error'])('reconciles a queued %s after switching, through the recovery poller', async status => {
    mocks.generate.mockResolvedValue({type:'queued',task_id:'task-p1'});
    await useStore.getState().runNode('shared-id',{prompt:'draw',model:'gpt-image-2'}); await settle();
    await useStore.getState().switchBackendProject('p2'); mocks.getTask.mockResolvedValue(task('p1',status));
    await vi.advanceTimersByTimeAsync(10500);
    expect(data('p1').status).toBe(status==='success'?'done':'error');
    if(status==='error') expect(data('p1').error).toContain('provider failed');
    expect(useStore.getState().nodes[0].data.status).toBeUndefined();
    expect(canvases.get('p1')!.nodes[0].data.status).toBe(status==='success'?'done':'error');
  });
  it('routes legacy SSE using the exact task id instead of the visible duplicate node', async () => {
    mocks.generate.mockResolvedValue({type:'queued',task_id:'task-p1'});
    await useStore.getState().runNode('shared-id',{prompt:'draw',model:'gpt-image-2'}); await settle();
    await useStore.getState().switchBackendProject('p2');
    eventSource.onmessage?.({data:JSON.stringify({...task(),project_id:undefined,task_id:'task-p1'})});
    expect(data('p1').url).toBe('/uploads/p1.png'); expect(useStore.getState().nodes[0].data.url).toBeUndefined();
  });
  it('keeps results that arrive while the original canvas is loading', async () => {
    mocks.generate.mockResolvedValue({type:'queued',task_id:'task-p1'});
    await useStore.getState().runNode('shared-id',{prompt:'draw',model:'gpt-image-2'}); await settle();
    await useStore.getState().switchBackendProject('p2');
    const response=deferred<unknown>(); const old=canvases.get('p1'); mocks.getCanvas.mockReturnValueOnce(response.promise);
    const switching=useStore.getState().switchBackendProject('p1'); await settle();
    eventSource.onmessage?.({data:JSON.stringify({...task(),task_id:'task-p1'})});
    response.resolve(old); await switching;
    expect(useStore.getState().nodes[0].data.status).toBe('done');
    expect(useStore.getState().nodes[0].data.url).toBe('/uploads/p1.png');
  });
  it('continues and saves a text stream without a mounted Canvas component', async () => {
    const textNode=node('shared-id','textNode'); useStore.setState({nodes:[textNode]});
    let controller!:ReadableStreamDefaultController<Uint8Array>;
    mocks.stream.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({start(c){controller=c;}})));
    const running=useStore.getState().runNode('shared-id',{prompt:'write',model:'deepseek-chat'}); await settle();
    await useStore.getState().switchBackendProject('p2');
    controller.enqueue(new TextEncoder().encode('data: {"type":"token","content":"后台文本"}\n\ndata: {"type":"done","content":"后台文本完成"}\n\n')); controller.close();
    await running; await vi.advanceTimersByTimeAsync(2100);
    expect(data('p1').content).toBe('后台文本完成'); expect(data('p1').status).toBe('done');
    expect(canvases.get('p1')!.nodes[0].data.content).toBe('后台文本完成');
    expect(useStore.getState().nodes[0].data.content).toBeUndefined();
  });
  it('keeps a just-finished result when target loading fails and navigation rolls back', async () => {
    mocks.generate.mockResolvedValue({type:'queued',task_id:'task-p1'});
    await useStore.getState().runNode('shared-id',{prompt:'draw',model:'gpt-image-2'}); await settle();
    const {switchHeaderProject}=await import('./components/canvas-header/canvas-navigation');
    const response=deferred<unknown>(); mocks.getCanvas.mockReturnValueOnce(response.promise);
    const switching=switchHeaderProject('p2',true); const failed=expect(switching).rejects.toThrow('已保留'); await settle();
    eventSource.onmessage?.({data:JSON.stringify({...task(),task_id:'task-p1'})});
    response.resolve(undefined); await failed;
    expect(useStore.getState().activeBackendProjectId).toBe('p1');
    expect(useStore.getState().nodes[0].data.url).toBe('/uploads/p1.png');
    expect(useStore.getState().activeRun).toBeNull();
  });
  it('ignores late results after switching accounts', async () => {
    const result=deferred<{type:'url';content:string}>(); mocks.generate.mockReturnValueOnce(result.promise);
    const running=useStore.getState().runNode('shared-id',{prompt:'draw',model:'gpt-image-2'}); await settle();
    bindStorageToUser('different-user');
    useStore.setState({nodes:[node()],projectStateById:{p1:{nodes:[node()],edges:[],groups:[]}},history:[]});
    result.resolve({type:'url',content:'/uploads/private.png'}); await running;
    expect(useStore.getState().nodes[0].data.url).toBeUndefined(); expect(useStore.getState().history).toHaveLength(0);
  });
  it('retains local results and reports a real background save error', async () => {
    mocks.generate.mockResolvedValue({type:'queued',task_id:'task-p1'});
    await useStore.getState().runNode('shared-id',{prompt:'draw',model:'gpt-image-2'}); await settle();
    await useStore.getState().switchBackendProject('p2'); mocks.save.mockRejectedValue(new Error('offline'));
    eventSource.onmessage?.({data:JSON.stringify({...task(),task_id:'task-p1'})});
    await vi.advanceTimersByTimeAsync(2100);
    expect(data('p1').url).toBe('/uploads/p1.png'); expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('后台保存失败'),expect.anything());
  });
});
