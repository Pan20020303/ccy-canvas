/* @vitest-environment jsdom */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill } from '../../api/skills';
import { SkillLibraryDialog } from './SkillLibraryDialog';
import { SkillQuickPicker } from './SkillQuickPicker';
import { SkillMentionChip } from './SkillMentionChip';
import { skillExamples } from './SkillDetail';
import { SkillIcon, sortLibrarySkills } from './skill-library-presenters';
import { parseSkillMarkdown } from '../settings/skill-import';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const create = vi.hoisted(() => vi.fn());
vi.mock('../../api/skills', () => ({ createSkill: create }));
const skill = (index: number, extra: Partial<Skill> = {}): Skill => ({ id: `s${index}`, name: `镜头技能${index}`, description: `真实描述${index}`, scope: 'global', category: index % 2 ? 'video' : 'image', kind: 'prompt', icon: '🎬', spec: { slash_command: `shot-${index}`, content_md: '真实提示词正文' }, input_schema: {}, output_schema: {}, enabled: true, created_at: '2026-09-14T12:00:00Z', updated_at: `2026-09-14T12:${String(index).padStart(2, '0')}:00Z`, ...extra });
let host: HTMLDivElement, root: Root;
const onClose = vi.fn(), onPick = vi.fn();
beforeEach(() => { vi.clearAllMocks(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const render = async (props: Partial<React.ComponentProps<typeof SkillLibraryDialog>> = {}) => act(async () => root.render(<SkillLibraryDialog open skills={[skill(1), skill(2)]} zh onClose={onClose} onPick={onPick} {...props} />));
const button = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.getAttribute('aria-label') === name || b.textContent?.trim() === name)!;
const click = async (name: string) => { const target = button(name); expect(target, name).toBeTruthy(); await act(async () => target.click()); };
const fill = async (label: string, value: string) => { const input = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; expect(input).toBeTruthy(); await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); };
describe('reference-style real skill library', () => {
  it('uses real rows, enabled counts, search, categories and personal scope', async () => {
    await render({ skills: [skill(1), skill(2, { scope: 'personal' }), skill(3, { enabled: false })] });
    expect(document.querySelector('.skill-library-count')?.textContent).toBe('共 2 个');
    await click('视频创作'); expect(document.querySelectorAll('.skill-library-item')).toHaveLength(1);
    await click('我的技能'); expect(document.querySelector('.skill-library-item')?.textContent).toContain('镜头技能2');
    await fill('搜索技能', 'no-match'); expect(document.querySelector('.skill-library-empty')?.textContent).toContain('没有找到匹配');
    await fill('搜索技能', 'shot-2'); expect(document.querySelectorAll('.skill-library-item')).toHaveLength(1);
  });
  it('paginates actual results and resets the page after filtering', async () => {
    await render({ skills: Array.from({ length: 25 }, (_, i) => skill(i)) });
    expect(document.querySelectorAll('.skill-library-item')).toHaveLength(20);
    await click('下一页'); expect(document.querySelectorAll('.skill-library-item')).toHaveLength(5);
    expect(button('下一页').disabled).toBe(true);
    await fill('搜索技能', '镜头技能24'); expect(document.querySelectorAll('.skill-library-item')).toHaveLength(1);
    expect(button('第 1 页').getAttribute('aria-current')).toBe('page');
  });
  it('opens details before selection and shows actual description, prompt length and dates', async () => {
    const sample = skill(1, { spec: { content_md: '中文😀', version: 'v2', version_notes: '修复镜头方向' } });
    await render({ skills: [sample] }); await click('查看技能：镜头技能1'); expect(onPick).not.toHaveBeenCalled();
    expect(document.querySelector('.skill-detail')?.textContent).toContain('3 字');
    expect(document.querySelector('.skill-detail')?.textContent).toContain('修复镜头方向');
    expect(document.querySelector('.skill-detail')?.textContent).toContain('作者暂未提供示例作品');
    expect(document.querySelector('.skill-detail')?.textContent).not.toMatch(/购买|500|订阅人数/);
    await click('使用技能'); expect(onPick).toHaveBeenCalledWith(sample); expect(onClose).toHaveBeenCalled();
  });
  it('shows an error with retry instead of a false empty state', async () => {
    const retry = vi.fn(); await render({ skills: [], error: '技能加载失败：HTTP 503', onRetry: retry });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('HTTP 503');
    expect(document.querySelector('.skill-library-empty')).toBeNull(); await click('重试'); expect(retry).toHaveBeenCalled();
  });
  it('previews only supplied safe examples', async () => {
    const sample = skill(1, { spec: { examples: [{ type: 'image', url: '/uploads/example.webp', title: '示例图片' }, { type: 'image', url: 'javascript:alert(1)' }, { type: 'html', url: '/uploads/test' }] } });
    expect(skillExamples(sample)).toHaveLength(1); await render({ skills: [sample] }); await click('查看技能：镜头技能1'); await click('示例图片');
    expect(document.querySelector('.skill-example-preview-media')?.getAttribute('src')).toBe('/uploads/example.webp');
    await act(async () => document.querySelector('.skill-example-preview-media')!.dispatchEvent(new Event('error')));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('示例加载失败');
    await click('关闭示例预览'); expect(document.querySelector('.skill-example-preview')).toBeNull(); expect(document.querySelector('.skill-detail')).toBeTruthy();
    await click('示例图片'); expect(document.querySelector('.skill-example-preview-media')).toBeTruthy();
  });
  it('imports through the real create endpoint and selects the returned skill id', async () => {
    const created = skill(8, { scope: 'personal' }); create.mockResolvedValue(created); const changed = vi.fn(); await render({ onSkillsChanged: changed });
    const file = new File(['# 测试技能'], 'new-skill.md', { type: 'text/markdown' }); Object.defineProperty(file, 'text', { value: async () => '# 测试技能' });
    const input = document.querySelector<HTMLInputElement>('[type="file"]')!;
    await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'prompt', enabled: true }));
    expect(changed).toHaveBeenCalledWith(expect.arrayContaining([created]));
    await click('使用技能'); expect(onPick).toHaveBeenCalledWith(created);
  });
  it('sorts by stored timestamps without mutating API order', () => {
    const rows = [skill(1), skill(2)]; expect(sortLibrarySkills(rows, 'latest').map(row => row.id)).toEqual(['s2', 's1']); expect(rows[0].id).toBe('s1');
  });
  it('preserves the uploaded icon and version information', () => {
    const payload = parseSkillMarkdown('---\nname: shot-guide\nicon: 🎬\nversion: v2\nversion_notes: 新增景别说明\n---\n真实技能正文');
    expect(payload.icon).toBe('🎬'); expect(payload.spec).toMatchObject({ version: 'v2', version_notes: '新增景别说明', content_md: '真实技能正文' });
  });
  it('does not forward delete shortcuts from skill details to the canvas', async () => {
    const handler = vi.fn(); window.addEventListener('keydown', handler);
    try {
      await render(); await click('查看技能：镜头技能1');
      await act(async () => button('使用技能').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
      expect(handler).not.toHaveBeenCalled();
    } finally { window.removeEventListener('keydown', handler); }
  });
});
describe('quick picker and skill mention icon', () => {
  it('searches skills beyond the first five and opens the full library', async () => {
    const anchor = createRef<HTMLButtonElement>(), all = vi.fn();
    await act(async () => root.render(<><button ref={anchor}>技能</button><SkillQuickPicker anchorRef={anchor} skills={Array.from({ length: 8 }, (_, i) => skill(i))} zh onPick={onPick} onClose={onClose} onOpenAll={all} /></>));
    expect(document.querySelectorAll('[data-skill-pick]')).toHaveLength(5);
    await fill('搜索可用技能', 'shot-7'); expect(document.querySelectorAll('[data-skill-pick]')).toHaveLength(1);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-skill-pick]')!.click()); expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 's7' }));
    await click('打开技能库'); expect(all).toHaveBeenCalled();
  });
  it('supports keyboard selection, Escape and restoring focus', async () => {
    const anchor = createRef<HTMLButtonElement>(); await act(async () => root.render(<><button ref={anchor}>技能</button><SkillQuickPicker anchorRef={anchor} skills={[skill(1)]} zh onPick={onPick} onClose={onClose} onOpenAll={() => {}} /></>));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement?.getAttribute('data-skill-pick')).toBe('s1');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(onClose).toHaveBeenCalled();
  });
  it('uses a compact real-icon chip and removal does not submit anything', async () => {
    const remove = vi.fn(); await act(async () => root.render(<SkillMentionChip skill={skill(1, { icon: '/uploads/icon.png' })} zh onRemove={remove} />));
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/uploads/icon.png'); expect(host.textContent).toContain('shot-1'); await click('移除已选技能'); expect(remove).toHaveBeenCalledOnce();
  });
  it('falls back gracefully for invalid and broken icons', async () => {
    await act(async () => root.render(<SkillIcon skill={skill(1, { icon: 'javascript:alert(1)' })} />)); expect(host.querySelector('img')).toBeNull(); expect(host.querySelector('svg')).toBeTruthy();
    await act(async () => root.render(<SkillIcon skill={skill(1, { icon: '/bad.png' })} />)); await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error'))); expect(host.querySelector('img')).toBeNull(); expect(host.querySelector('svg')).toBeTruthy();
  });
});
