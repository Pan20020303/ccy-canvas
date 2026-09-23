/* @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminMembersPage } from './AdminMembersPage';
import { AdminStoragePage } from './AdminStoragePage';
import { AdminResourcesPage, formatBytes } from './AdminResourcesPage';
const api = vi.hoisted(() => ({ users: vi.fn(), role: vi.fn(), status: vi.fn(), remove: vi.fn(), credits: vi.fn(), password: vi.fn(), storage: vi.fn(), save: vi.fn(), resources: vi.fn() }));
vi.mock('./AdminShell', () => ({ AdminShell: ({ title, action, children }: { title: string; action: React.ReactNode; children: React.ReactNode }) => <main><h1>{title}</h1>{action}{children}</main> }));
vi.mock('../../api/admin', () => ({ listUsers: api.users, updateUserRole: api.role, updateUserStatus: api.status, deleteUser: api.remove, adjustCredits: api.credits, resetUserPassword: api.password }));
vi.mock('../../api/adminSystem', () => ({ getStorageSettings: api.storage, saveStorageSettings: api.save, getServerResources: api.resources }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cloud = { bucket: 'media-test', region: 'cn-beijing', endpoint: '', public_base_url: '', key_prefix: '', has_access_key_id: true, has_access_key_secret: true };
const settings = { backend: 'oss', oss: cloud, cos: { ...cloud, region: 'ap-beijing' }, revision: 5, source: 'database', configured: true, updated_at: null, local_directory: 'uploads' };
const member = { id: 'member-1', name: '测试成员', email: 'member@example.com', role: 'member', status: 'active', last_login_at: null, daily_quota: 100, current_balance: 200 };
const resources = { sampled_at: '2026-09-21T01:00:00Z', hostname: 'test-server', os: 'linux', arch: 'amd64', cpu_cores: 8, cpu_percent: 12.3, memory: { total: 8192, used: 2048, available: 6144, percent: 25 }, disk: null, disk_path: '/uploads', uptime_seconds: 61, go_version: 'go1.26', heap_bytes: 1024, heap_reserved_bytes: 4096, runtime_bytes: 8192, goroutines: 24, gc_count: 8, warnings: ['磁盘数据暂不可用'] };
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); api.users.mockResolvedValue([member]); api.storage.mockResolvedValue(settings); api.resources.mockResolvedValue(resources); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
async function render(element: React.ReactNode) { await act(async () => root.render(element)); }
function button(name: string) { const b = [...document.querySelectorAll<HTMLButtonElement>('button')].find((e) => e.getAttribute('aria-label') === name || e.textContent?.trim() === name || e.querySelector('strong')?.textContent === name); if (!b) throw new Error(`Missing button ${name}`); return b; }
async function click(name: string) { await act(async () => button(name).click()); }
function input(label: string) { const parent = [...document.querySelectorAll('label')].find((e) => e.textContent?.startsWith(label)); const el = parent?.querySelector('input'); if (!el) throw new Error(`Missing input ${label}`); return el; }
async function value(el: HTMLInputElement, next: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, next); el.dispatchEvent(new Event('input', { bubbles: true })); }); }

describe('安全成员管理', () => {
  it('打开管理与取消角色更改均不写入', async () => { await render(<AdminMembersPage />); await click('管理 测试成员'); await click('更改成员角色'); expect(api.role).not.toHaveBeenCalled(); expect(document.querySelector('[role=dialog]')?.textContent).toContain('可信任人员'); await click('返回，不更改'); await click('关闭对话框'); expect(api.role).not.toHaveBeenCalled(); });
  it('只有确认角色变更才提交一次', async () => { await render(<AdminMembersPage />); await click('管理 测试成员'); await click('更改成员角色'); await click('确认更改'); expect(api.role).toHaveBeenCalledExactlyOnceWith('member-1', 'admin'); expect(document.querySelector('[role=dialog]')).toBeNull(); });
  it('停用账号需要确认并展示失败信息', async () => { api.status.mockRejectedValueOnce(new Error('保存失败')); await render(<AdminMembersPage />); await click('管理 测试成员'); await click('停用账号'); expect(api.status).not.toHaveBeenCalled(); await click('确认更改'); expect(document.querySelector('[role=alert]')?.textContent).toContain('保存失败'); expect(document.querySelector('[role=dialog]')).not.toBeNull(); });
  it('删除需要准确输入邮箱', async () => { await render(<AdminMembersPage />); await click('管理 测试成员'); await click('删除成员…'); expect(button('确认永久删除').disabled).toBe(true); await value(input('输入成员邮箱'), 'wrong'); expect(button('确认永久删除').disabled).toBe(true); await value(input('输入成员邮箱'), member.email); await click('确认永久删除'); expect(api.remove).toHaveBeenCalledExactlyOnceWith(member.id); });
  it('积分默认不调整，必须填写原因且不允许负余额', async () => { await render(<AdminMembersPage />); await click('管理 测试成员'); await click('积分与额度'); expect(input('积分调整量').value).toBe('0'); expect(button('确认更改').disabled).toBe(true); await value(input('积分调整量'), '-201'); await value(input('调整原因'), '测试调整'); expect(button('确认更改').disabled).toBe(true); await value(input('积分调整量'), '-50'); expect(document.body.textContent).toContain('150'); await click('确认更改'); expect(api.credits).toHaveBeenCalledExactlyOnceWith(member.id, { add_balance: -50, set_quota: 100, reason: '测试调整' }); });
  it('重置密码先校验两次输入', async () => { await render(<AdminMembersPage />); await click('管理 测试成员'); await click('重置密码'); await value(input('新密码'), 'testpassword123'); expect(button('确认更改').disabled).toBe(true); await value(input('再次输入'), 'testpassword123'); await click('确认更改'); expect(api.password).toHaveBeenCalledExactlyOnceWith(member.id, 'testpassword123'); });
  it('搜索不匹配成员显示空态', async () => { await render(<AdminMembersPage />); await value(document.querySelector('[aria-label="搜索成员"]') as HTMLInputElement, '不存在'); expect(document.body.textContent).toContain('没有匹配的成员'); expect(document.querySelectorAll('tbody tr')).toHaveLength(0); });
  it('加载失败可重试而不是显示成功空列表', async () => { api.users.mockRejectedValueOnce(new Error('网络断开')); await render(<AdminMembersPage />); expect(document.querySelector('[role=alert]')?.textContent).toContain('网络断开'); await click('重试'); expect(document.querySelectorAll('tbody tr')).toHaveLength(1); });
});
describe('媒体存储设置', () => {
  it('不回显密钥，初始禁用保存', async () => { await render(<AdminStoragePage />); expect(input('AccessKey ID').value).toBe(''); expect(input('AccessKey Secret').placeholder).toContain('留空'); expect(button('检查并保存').disabled).toBe(true); });
  it('选择存储与取消确认不会立即保存', async () => { await render(<AdminStoragePage />); await click('本地磁盘'); expect(api.save).not.toHaveBeenCalled(); await click('检查并保存'); expect(document.querySelector('[role=dialog]')).not.toBeNull(); await click('取消'); expect(api.save).not.toHaveBeenCalled(); });
  it('确认后提交当前版本与空密钥保留指令', async () => { api.save.mockResolvedValueOnce({ ...settings, revision: 6 }); await render(<AdminStoragePage />); await value(input('Bucket'), 'new-bucket'); await click('检查并保存'); await click('确认保存并生效'); expect(api.save).toHaveBeenCalledExactlyOnceWith({ backend: 'oss', revision: 5, cloud: { bucket: 'new-bucket', region: 'cn-beijing', endpoint: '', public_base_url: '', key_prefix: '', access_key_id: '', access_key_secret: '' } }); expect(document.querySelector('[role=status]')?.textContent).toContain('加密保存'); });
  it('版本冲突保留输入与原生效配置', async () => { api.save.mockRejectedValueOnce(new Error('配置已被其他管理员更新')); await render(<AdminStoragePage />); await value(input('Bucket'), 'my-new-bucket'); await click('检查并保存'); await click('确认保存并生效'); expect(document.querySelector('[role=alert]')?.textContent).toContain('其他管理员'); await click('取消'); expect(input('Bucket').value).toBe('my-new-bucket'); expect(document.body.textContent).toContain('v5'); });
  it('保存进行中禁用重复提交及关闭', async () => { let resolve!: (v: unknown) => void; api.save.mockImplementationOnce(() => new Promise((r) => { resolve = r; })); await render(<AdminStoragePage />); await click('本地磁盘'); await click('检查并保存'); await click('确认保存并生效'); expect(button('正在保存…').disabled).toBe(true); expect(button('关闭对话框').disabled).toBe(true); expect(api.save).toHaveBeenCalledTimes(1); await act(async () => resolve({ ...settings, backend: 'local', revision: 6 })); });
});
describe('真实资源状态展示', () => {
  it('显示服务端数值，不可用磁盘不冒充零占用', async () => { await render(<AdminResourcesPage />); expect(document.body.textContent).toContain('12.3%'); const disk = document.querySelector('[aria-label="媒体目录所在磁盘"]'); expect(disk?.hasAttribute('aria-valuenow')).toBe(false); expect(disk?.getAttribute('aria-valuetext')).toBe('不可用'); expect(document.body.textContent).toContain('test-server'); });
  it('刷新失败保留旧数据并明确标记过期', async () => { await render(<AdminResourcesPage />); api.resources.mockRejectedValueOnce(new Error('网络错误')); await click('刷新统计'); expect(document.querySelector('[role=alert]')?.textContent).toContain('不代表当前状态'); expect(document.body.textContent).toContain('（已过期）'); expect(document.body.textContent).toContain('12.3%'); });
  it('字节转换正确', () => { expect(formatBytes(0)).toBe('0 B'); expect(formatBytes(1024)).toBe('1.0 KiB'); expect(formatBytes(1073741824)).toBe('1.0 GiB'); });
});
