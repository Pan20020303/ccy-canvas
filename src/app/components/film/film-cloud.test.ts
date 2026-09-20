/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../api/client';
import { attachCloudFilm, filmJournalKey, loadCloudFilm, migrateFilmDraft, syncCloudFilm } from './film-cloud';
import { filmStorageKey, filmStore, startFilmJob, pollFilmJobs } from './film-store';
import { newFilmProject } from './film-project';
import type { FilmRecord, FilmSave } from '../../api/film-projects';
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), create: vi.fn(), generate: vi.fn(), task: vi.fn() }));
vi.mock('../../api/film-projects', () => ({ getFilmProject: mocks.get, saveFilmProject: mocks.save, createFilmProject: mocks.create }));
vi.mock('../../api/providerConfigs', () => ({ generate: mocks.generate }));
vi.mock('../../api/tasks', () => ({ getTask: mocks.task, batchTasksByNodeIds: vi.fn().mockResolvedValue([]) }));
let user: string, record: FilmRecord;
beforeEach(() => {
  vi.clearAllMocks();vi.useFakeTimers();user=crypto.randomUUID();
  record={id:crypto.randomUUID(),document:newFilmProject(),revision:1,mutation_id:'',created_at:'2026-09-18T00:00:00Z',updated_at:'2026-09-18T00:00:00Z'};
  mocks.save.mockImplementation(async (id: string, request: FilmSave) => ({...record,id,document:request.document,revision:request.revision+1,mutation_id:request.mutation_id}));
  mocks.get.mockResolvedValue(record);mocks.create.mockResolvedValue(record);
});
afterEach(() => { vi.clearAllTimers();vi.useRealTimers(); });
const store=()=>filmStore(user,record.id);
describe('database-backed film persistence',()=>{
  it('restores task progress and partial results from the database without importing twice',async()=>{
    attachCloudFilm(user,record);
    mocks.generate.mockResolvedValue({type:'queued',task_id:'persisted-task'});
    await startFilmJob(user,'split',{service_type:'text',model:'writer',prompt:'分镜'},undefined,record.id);
    mocks.task.mockResolvedValue({id:'persisted-task',node_id:store().getState().project.jobs[0].nodeId,status:'running'});
    await pollFilmJobs(user,record.id);await store().getState().flush!();
    const progress=await mocks.save.mock.results.at(-1)!.value;
    attachCloudFilm(user,progress);expect(store().getState().project.jobs[0].phase).toBe('generating');
    const raw='{"shots":[{"description":"已完成镜头"},{"description":"未完成';
    mocks.task.mockResolvedValue({id:'persisted-task',node_id:store().getState().project.jobs[0].nodeId,status:'success',result_url:raw});
    await pollFilmJobs(user,record.id);await store().getState().flush!();
    const saved=await mocks.save.mock.results.at(-1)!.value;
    attachCloudFilm(user,saved);await pollFilmJobs(user,record.id);
    expect(store().getState().project.jobs[0]).toMatchObject({status:'partial',resultCount:1,rawResult:raw});
    expect(store().getState().project.shots).toHaveLength(1);expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it('refreshes a previously opened clean project from the database on re-entry',async()=>{
    attachCloudFilm(user,record);mocks.get.mockResolvedValue({...record,revision:2,document:{...record.document,script:'另一页面保存的内容'}});
    await loadCloudFilm(user,record.id);expect(store().getState().project.script).toBe('另一页面保存的内容');
  });
  it('does not replace pending local edits when the project is reopened',async()=>{
    attachCloudFilm(user,record);store().getState().patch({script:'尚未同步的修改'});
    await loadCloudFilm(user,record.id);expect(store().getState().project.script).toBe('尚未同步的修改');
  });
  it('loads the full database document with no browser draft and saves all fields',async()=>{
    record.document.script='云端剧本';record.document.settings.splitSkillId='草帽与梦';record.document.step=3;
    await loadCloudFilm(user,record.id);expect(store().getState().project).toMatchObject({script:'云端剧本',step:3,settings:{splitSkillId:'草帽与梦'}});
    store().getState().patch({name:'第二集',script:'修改后的剧本'});expect(store().getState().syncStatus).toBe('saving');
    await store().getState().flush!();expect(mocks.save).toHaveBeenCalledWith(record.id,expect.objectContaining({revision:1,document:expect.objectContaining({name:'第二集',script:'修改后的剧本'})}));
    expect(store().getState().syncStatus).toBe('saved');expect(localStorage.getItem(filmJournalKey(user,record.id))).toBeNull();
    const saved=await mocks.save.mock.results[0].value;attachCloudFilm(user,saved);expect(store().getState().project.script).toBe('修改后的剧本');
  });
  it('serializes rapid edits arriving during an in-flight save',async()=>{
    attachCloudFilm(user,record);let resolve!: (r: FilmRecord)=>void;
    mocks.save.mockImplementationOnce(()=>new Promise<FilmRecord>(r=>{resolve=r;}));
    store().getState().patch({script:'第一版'});const saving=store().getState().flush!();
    store().getState().patch({script:'第二版'});const first=mocks.save.mock.calls[0][1];
    resolve({...record,document:first.document,revision:2,mutation_id:first.mutation_id});await saving;
    expect(mocks.save).toHaveBeenCalledTimes(2);expect(mocks.save.mock.calls[1][1]).toMatchObject({revision:2,document:{script:'第二版'}});expect(store().getState().syncStatus).toBe('saved');
  });
  it('keeps failed saves recoverable and replays the exact mutation after a lost response',async()=>{
    attachCloudFilm(user,record);mocks.save.mockRejectedValueOnce(new Error('离线'));
    store().getState().patch({script:'未同步'});await expect(store().getState().flush!()).rejects.toThrow('离线');
    expect(store().getState().syncStatus).toBe('error');const sent=mocks.save.mock.calls[0][1];
    attachCloudFilm(user,record);expect(store().getState().project.script).toBe('未同步');await store().getState().flush!();
    expect(mocks.save.mock.calls[1][1]).toEqual(sent);expect(store().getState().syncStatus).toBe('saved');
  });
  it('recognizes a saved mutation on reload and preserves edits made after it',async()=>{
    const sent={document:{...record.document,script:'已提交'},revision:1,mutation_id:'acknowledged'};
    localStorage.setItem(filmJournalKey(user,record.id),JSON.stringify({revision:1,project:{...sent.document,script:'之后的编辑'},request:sent}));
    attachCloudFilm(user,{...record,revision:2,mutation_id:'acknowledged',document:sent.document});await store().getState().flush!();
    expect(mocks.save.mock.calls[0][1]).toMatchObject({revision:2,document:{script:'之后的编辑'}});
  });
  it('never overwrites a newer cloud revision with an offline recovery copy',async()=>{
    localStorage.setItem(filmJournalKey(user,record.id),JSON.stringify({revision:1,project:{...record.document,script:'本机副本'}}));
    attachCloudFilm(user,{...record,revision:3});expect(store().getState().syncStatus).toBe('conflict');
    await expect(store().getState().flush!()).rejects.toThrow('版本冲突');expect(mocks.save).not.toHaveBeenCalled();expect(store().getState().project.script).toBe('本机副本');
  });
  it('surfaces a server conflict instead of retrying with a newer revision',async()=>{
    attachCloudFilm(user,record);mocks.save.mockRejectedValueOnce(new ApiClientError({status:409,code:'CONFLICT',message:'conflict'}));
    mocks.get.mockResolvedValue({...record,revision:2,document:{...record.document,script:'另一浏览器同时编辑'}});
    store().getState().patch({script:'本机编辑'});await expect(store().getState().flush!()).rejects.toThrow();expect(store().getState().syncStatus).toBe('conflict');
    await expect(store().getState().flush!()).rejects.toThrow('版本冲突');expect(mocks.save).toHaveBeenCalledTimes(1);
  });
  it('keeps a conflict protected across reload instead of overwriting the cloud with an old draft',async()=>{
    localStorage.setItem(filmJournalKey(user,record.id),JSON.stringify({revision:1,project:{...record.document,script:'旧缓存'}}));
    const newer={...record,revision:4,document:{...record.document,script:'云端新稿'}};
    attachCloudFilm(user,newer);attachCloudFilm(user,newer);
    expect(store().getState().syncStatus).toBe('conflict');
    await expect(store().getState().flush!()).rejects.toThrow('版本冲突');expect(mocks.save).not.toHaveBeenCalled();
    expect(store().getState().project.script).toBe('旧缓存');
  });
  it('merges independent edits after a version conflict and saves against the newest revision',async()=>{
    attachCloudFilm(user,record);store().getState().patch({script:'本机剧本'});
    mocks.save.mockRejectedValueOnce(new ApiClientError({status:409,code:'CONFLICT',message:'conflict'}));
    mocks.get.mockResolvedValue({...record,revision:2,document:{...record.document,name:'另一浏览器改名'}});
    await store().getState().flush!();
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[1][1]).toMatchObject({revision:2,document:{name:'另一浏览器改名',script:'本机剧本'}});
    expect(store().getState().syncStatus).toBe('saved');
  });
  it('merges journaled offline edits with remote changes after reopening',async()=>{
    attachCloudFilm(user,record);store().getState().patch({script:'离线编辑'});
    attachCloudFilm(user,{...record,revision:2,document:{...record.document,name:'远端改名'}});
    await store().getState().flush!();
    expect(store().getState().project).toMatchObject({name:'远端改名',script:'离线编辑'});
    expect(mocks.save.mock.calls[0][1].revision).toBe(2);
  });
  it('pulls updates with no active jobs without echo-saving or changing the current step',async()=>{
    record.document.step=3;attachCloudFilm(user,record);
    mocks.get.mockResolvedValue({...record,revision:2,document:{...record.document,name:'远端项目',step:4}});
    await syncCloudFilm(user,record.id);await syncCloudFilm(user,record.id);
    expect(store().getState().project).toMatchObject({name:'远端项目',step:3});
    expect(store().getState().syncStatus).toBe('saved');expect(mocks.save).not.toHaveBeenCalled();
  });
  it('preserves edits made while fetching a remote update',async()=>{
    attachCloudFilm(user,record);let resolve!: (r: FilmRecord)=>void;
    mocks.get.mockImplementationOnce(()=>new Promise<FilmRecord>(r=>{resolve=r;}));
    const refreshing=syncCloudFilm(user,record.id);store().getState().patch({script:'读取时输入'});
    resolve({...record,revision:2,document:{...record.document,name:'远端更新'}});await refreshing;await store().getState().flush!();
    expect(store().getState().project).toMatchObject({script:'读取时输入',name:'远端更新'});
  });
  it('recovers a lost save acknowledgement while preserving subsequent local edits',async()=>{
    attachCloudFilm(user,record);store().getState().patch({script:'第一稿'});
    mocks.save.mockRejectedValueOnce(new Error('响应中断'));await expect(store().getState().flush!()).rejects.toThrow();
    const sent=mocks.save.mock.calls[0][1];store().getState().patch({script:'第二稿'});
    mocks.get.mockResolvedValue({...record,revision:2,mutation_id:sent.mutation_id,document:sent.document});
    await syncCloudFilm(user,record.id);await store().getState().flush!();
    expect(store().getState().project.script).toBe('第二稿');expect(store().getState().syncStatus).toBe('saved');
  });
  it('syncs two independent clients and imports a completed task exactly once during concurrent saves',async()=>{
    let server=record;
    mocks.get.mockImplementation(async()=>server);
    mocks.save.mockImplementation(async(id: string,request: FilmSave)=>{
      if(request.revision!==server.revision) throw new ApiClientError({status:409,code:'CONFLICT',message:'conflict'});
      server={...server,id,document:request.document,revision:server.revision+1,mutation_id:request.mutation_id};return server;
    });
    attachCloudFilm(user,server);mocks.generate.mockResolvedValue({type:'queued',task_id:'shared-task'});
    await startFilmJob(user,'split',{service_type:'text',model:'writer',prompt:'分镜'},undefined,record.id);
    await store().getState().flush!();
    const otherUser=crypto.randomUUID(),other=filmStore(otherUser,record.id);attachCloudFilm(otherUser,server);
    mocks.task.mockResolvedValue({id:'shared-task',node_id:server.document.jobs[0].nodeId,status:'success',result_url:'{"shots":[{"description":"并发完成镜头"}]}'});
    await Promise.all([pollFilmJobs(user,record.id),pollFilmJobs(otherUser,record.id)]);
    other.getState().patch({name:'第二个浏览器编辑的标题'});
    await Promise.all([store().getState().flush!(),other.getState().flush!()]);
    await syncCloudFilm(user,record.id);
    expect(server.document.shots).toHaveLength(1);expect(store().getState().project.shots).toEqual(other.getState().project.shots);
    expect(store().getState().project.name).toBe('第二个浏览器编辑的标题');
    expect(store().getState().project.jobs[0].appliedAt).toBeTruthy();expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(store().getState().syncStatus).toBe('saved');expect(other.getState().syncStatus).toBe('saved');
  });
  it('migrates the legacy draft once without deleting its original backup',async()=>{
    const draft={...newFilmProject(),script:'原草稿'};localStorage.setItem(filmStorageKey(user),JSON.stringify(draft));
    await expect(migrateFilmDraft(user)).resolves.toBe(true);await expect(migrateFilmDraft(user)).resolves.toBe(false);
    expect(mocks.create).toHaveBeenCalledTimes(1);expect(mocks.create).toHaveBeenCalledWith(draft);expect(JSON.parse(localStorage.getItem(filmStorageKey(user))!).script).toBe('原草稿');
  });
  it('does not mark migration complete if the database rejects it',async()=>{
    localStorage.setItem(filmStorageKey(user),JSON.stringify({...newFilmProject(),script:'原草稿'}));mocks.create.mockRejectedValueOnce(new Error('服务不可用'));
    await expect(migrateFilmDraft(user)).rejects.toThrow();await expect(migrateFilmDraft(user)).resolves.toBe(true);expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it('isolates two projects and persists generation IDs before sending a request',async()=>{
    attachCloudFilm(user,record);const other={...record,id:crypto.randomUUID(),document:newFilmProject()};attachCloudFilm(user,other);
    mocks.generate.mockImplementation(async()=>{expect(mocks.save).toHaveBeenCalled();return {type:'queued',task_id:'task'};});
    await startFilmJob(user,'write',{service_type:'text',model:'writer',prompt:'写作'},undefined,record.id);
    expect(filmStore(user,other.id).getState().project.jobs).toHaveLength(0);
    mocks.task.mockResolvedValue({id:'task',node_id:store().getState().project.jobs[0].nodeId,status:'success',result_url:'后台生成结果'});
    await pollFilmJobs(user,record.id);await store().getState().flush!();
    expect(store().getState().project.script).toBe('后台生成结果');expect(filmStore(user,other.id).getState().project.script).toBe('');
  });
  it('does not start paid generation when the request journal cannot reach the database',async()=>{
    attachCloudFilm(user,record);mocks.save.mockRejectedValue(new Error('服务不可用'));
    await expect(startFilmJob(user,'write',{service_type:'text',model:'writer',prompt:'写作'},undefined,record.id)).rejects.toThrow();expect(mocks.generate).not.toHaveBeenCalled();
  });
});
