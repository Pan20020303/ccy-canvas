/* @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { VideoNode } from './CustomNodes';
import { useStore } from '../../store';
import { DEFAULT_CANVAS_PREFERENCES, useCanvasPreferences } from '../../canvas-preferences';
import { readPromptInput } from './PromptMentionInput';
import { wrapMentionTag } from './prompt-mentions';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const original = useStore.getState(), preferences = useCanvasPreferences.getState(), generate = vi.fn();
const names = ['C19_许熙_2026_29岁_主角身份锚点.png', '角色B.png'];
const mentions = names.map((name, i) => ({ tag: wrapMentionTag(`${name}·${i + 1}`), id: `ref${i + 1}`, thumb: `/image${i + 1}.png`, kind: 'image' }));
const input = () => document.querySelector<HTMLElement>('[aria-label="生成提示词"]')!;
const chips = () => [...document.querySelectorAll<HTMLElement>('.canvas-mention-chip')];
const thumbnails = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="插入引用："]')];
const ids = () => chips().map(c => c.dataset.mentionId);
const key = async (key: string, options = {}) => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })); });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
const type = async (text: string, after?: Node) => {
  await act(async () => {
    const editor = input(); editor.focus(); const selection = window.getSelection()!, range = document.createRange();
    if (after) range.setStartAfter(after); else { range.selectNodeContents(editor); range.collapse(false); }
    range.collapse(true); const node = document.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range); editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  });
};
const choose = async (index: number) => {
  const options = document.querySelectorAll<HTMLButtonElement>('[aria-label="选择引用素材"] button');
  expect(options).toHaveLength(2); await act(async () => options[index].click()); await settle();
};
const render = async (text = '') => {
  useStore.setState({ language: 'zh', backendModels: [{ id: 'video', vendor: 'Volcengine', name: '官方视频', service_type: 'video', default_model: 'doubao-seedance-2-0-260128', model_list: ['doubao-seedance-2-0-260128'], priority: 1 }],
    runNode: generate, nodes: [{ id: 'video', type: 'videoNode', position: { x: 0, y: 0 }, data: { promptDraft: text, promptMentions: mentions } }, ...mentions.map((m, i) => ({ id: m.id, type: 'referenceImageNode', position: { x: i * 100, y: 0 }, data: { url: m.thumb, sourceName: names[i] } }))],
    edges: mentions.map(m => ({ id: `${m.id}-video`, source: m.id, target: 'video' })),
  });
  await act(async () => root.render(<ReactFlowProvider><VideoNode id="video" data={{}} selected /></ReactFlowProvider>));
};
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  useCanvasPreferences.setState({ values: { ...DEFAULT_CANVAS_PREFERENCES, mentionNaming: 'name' } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useStore.setState(original); useCanvasPreferences.setState(preferences); vi.unstubAllGlobals(); });
describe('real canvas prompt editor interactions', () => {
  it('displays the remembered model, portrait ratio and duration after the new node editor initializes', async () => {
    await render();
    const model = 'doubao-seedance-2-5-260628';
    await act(async () => {
      useCanvasPreferences.getState().setPreference('reuseLastGenerationParams', true);
      useStore.setState(state => ({ backendModels: state.backendModels.map(provider => ({ ...provider, model_list: [...provider.model_list, model] })) }));
      useStore.getState().updateNodeGenerationParams('video', { model, resolution: '1080p', aspectRatio: '9:16', durationSeconds: 12 });
      useStore.getState().addNode({ id: 'remembered-video', type: 'videoNode', position: { x: 400, y: 0 }, data: {} });
    });
    await act(async () => root.render(<ReactFlowProvider><VideoNode key="remembered" id="remembered-video" data={{}} selected /></ReactFlowProvider>));
    const params = document.querySelector<HTMLButtonElement>('button[aria-label="生成参数"]')!;
    expect(params.textContent).toContain('9:16'); expect(params.textContent).toContain('12s'); expect(params.textContent).toContain('1080p');
    expect(document.querySelector('.node-control-pill')?.textContent).toContain(model);
    expect(useStore.getState().nodes.find(node => node.id === 'remembered-video')!.data.generationParams).toMatchObject({ model, aspectRatio: '9:16', durationSeconds: 12 });
  });
  it('inserts reference thumbnails at the saved caret, supports repeated clicks and undo/redo', async () => {
    await render('前文后文');
    input().focus();
    const range = document.createRange(); range.setStart(input().firstChild!, 2); range.collapse(true);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    await act(async () => input().dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    await act(async () => thumbnails()[0].click()); await settle();
    await act(async () => thumbnails()[1].click()); await settle();
    expect(ids()).toEqual(['ref1', 'ref2']);
    expect(readPromptInput(input())).toBe(`前文${mentions[0].tag} ${mentions[1].tag} 后文`);
    await key('z', { ctrlKey: true }); await settle(); expect(ids()).toEqual(['ref1']);
    await key('y', { ctrlKey: true }); await settle(); expect(ids()).toEqual(['ref1', 'ref2']);
    expect(generate).not.toHaveBeenCalled();
  });
  it('appends a reference to an unfocused draft and replaces a typed @ trigger from the strip', async () => {
    await render('已有提示词');
    await act(async () => thumbnails()[0].click()); await settle();
    expect(readPromptInput(input())).toBe(`已有提示词${mentions[0].tag} `);
    await type('@');
    await act(async () => thumbnails()[1].click()); await settle();
    expect(ids()).toEqual(['ref1', 'ref2']);
    expect(readPromptInput(input())).not.toContain('@');
    expect(document.querySelector('[aria-label="选择引用素材"]')).toBeNull();
  });
  it('replaces a selection with the clicked reference and does not insert a chip when disconnecting', async () => {
    await render('替换这段'); input().focus();
    const range = document.createRange(); range.selectNodeContents(input());
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    await act(async () => input().dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    await act(async () => thumbnails()[0].click()); await settle();
    expect(readPromptInput(input())).toBe(`${mentions[0].tag} `);
    await act(async () => document.querySelector<HTMLButtonElement>('[title="移除引用"]')!.click()); await settle();
    expect(ids()).toEqual([]);
    expect(useStore.getState().edges).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
  });
  it('supports clicking audio and video references as well as images', async () => {
    await render();
    await act(async () => useStore.setState(state => ({ nodes: state.nodes.map(node => node.id === 'ref1'
      ? { ...node, type: 'referenceAudioNode', data: { url: '/sound.mp3', sourceName: '声音' } }
      : node.id === 'ref2' ? { ...node, type: 'referenceVideoNode', data: { url: '/clip.mp4', thumbnail: '/poster.png', sourceName: '动作' } } : node) })));
    await act(async () => thumbnails()[0].click()); await settle();
    await act(async () => thumbnails()[1].click()); await settle();
    expect(ids()).toEqual(['ref1', 'ref2']);
    const data = readPromptInput(input());
    expect(data).toContain('声音'); expect(data).toContain('动作');
  });
  it('renders two adjacent references as separate atomic chips with complete names in tooltips', async () => {
    await render(mentions[0].tag + mentions[1].tag);
    expect(ids()).toEqual(['ref1', 'ref2']); expect(chips()[0].title).toContain(names[0]);
    expect(chips().every(c => c.contentEditable === 'false')).toBe(true);
    expect(readPromptInput(input())).toBe(mentions[0].tag + mentions[1].tag);
  });
  it('shows only the image in a borderless hover preview for both chips and thumbnails', async () => {
    await render(mentions[0].tag);
    await act(async () => chips()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
    const preview = () => document.querySelector<HTMLElement>('[data-testid="reference-hover-preview"]')!;
    expect(preview()).not.toBeNull();
    expect(preview().className).toBe('fixed z-[140] w-max border-0 bg-transparent p-0 shadow-none');
    expect(preview().children).toHaveLength(1);
    expect(preview().textContent).toBe('');
    expect(preview().querySelector('img')?.alt).toContain(names[0]);
    expect(preview().querySelector('img')?.classList.contains('w-auto')).toBe(true);
    const thumbnail = document.querySelector<HTMLImageElement>('.group\\/ref img')!;
    await act(async () => thumbnail.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(document.querySelectorAll('[data-testid="reference-hover-preview"]')).toHaveLength(1);
    expect(preview().children).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
  });
  it('keeps video playback and audio controls without adding a preview card', async () => {
    await render(mentions[0].tag);
    for (const type of ['referenceVideoNode', 'referenceAudioNode']) {
      await act(async () => useStore.setState(state => ({ nodes: state.nodes.map(node => node.id === 'ref1' ? { ...node, type, data: { url: type === 'referenceVideoNode' ? '/clip.mp4' : '/clip.mp3', sourceName: '素材' } } : node) })));
      await act(async () => chips()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
      const preview = document.querySelector<HTMLElement>('[data-testid="reference-hover-preview"]')!;
      expect(preview.children).toHaveLength(1);
      expect(preview.textContent).toBe('');
      if (type === 'referenceVideoNode') {
        const video = preview.querySelector('video')!;
        expect(video.autoplay && video.muted && video.loop).toBe(true);
        expect(video.classList.contains('w-auto')).toBe(true);
        expect(video.classList.contains('bg-black')).toBe(false);
      } else expect(preview.querySelector('audio')?.controls).toBe(true);
    }
  });
  it('switches only the clicked occurrence, including when the target is already referenced', async () => {
    await render(mentions[0].tag + mentions[0].tag + mentions[1].tag);
    await act(async () => chips()[1].click());
    const options = document.querySelectorAll<HTMLButtonElement>('[data-testid="mention-switch-option"]');
    await act(async () => options[1].click()); await settle();
    expect(ids()).toEqual(['ref1', 'ref2', 'ref2']);
    await key('z', { ctrlKey: true }); await settle(); expect(ids()).toEqual(['ref1', 'ref1', 'ref2']);
    await key('y', { ctrlKey: true }); await settle(); expect(ids()).toEqual(['ref1', 'ref2', 'ref2']);
  });
  it('inserts consecutive mentions with no separator without replacing the preceding chip', async () => {
    await render(); await type('@'); await choose(0);
    await type('@', chips()[0]); await choose(1);
    expect(ids()).toEqual(['ref1', 'ref2']); expect(generate).not.toHaveBeenCalled();
    await type('@', chips()[1]); await choose(0);
    expect(ids()).toEqual(['ref1', 'ref2', 'ref1']);
    await key('Enter'); expect(generate).toHaveBeenCalledWith('video', expect.objectContaining({ prompt: expect.stringContaining('@ref1@ref2@ref1') }));
  });
  it('uses Enter to choose a reference rather than submitting a paid generation', async () => {
    await render(); await type('@'); await key('ArrowDown'); await key('Enter'); await settle();
    expect(ids()).toEqual(['ref2']); expect(generate).not.toHaveBeenCalled();
  });
  it('deletes only one adjacent chip and restores its reference on undo', async () => {
    await render(mentions[0].tag + mentions[1].tag);
    input().focus(); const range = document.createRange(); range.setStartAfter(chips()[0]); range.collapse(true); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    await key('Backspace'); await settle(); expect(ids()).toEqual(['ref2']);
    await key('z', { ctrlKey: true }); await settle(); expect(ids()).toEqual(['ref1', 'ref2']);
  });
  it('keeps one active editor when expanded and preserves both chips after closing', async () => {
    await render(mentions[0].tag + mentions[1].tag);
    await act(async () => document.querySelector<HTMLButtonElement>('[title="放大"]')!.click());
    expect(document.querySelectorAll('[aria-label="生成提示词"]')).toHaveLength(1); expect(ids()).toEqual(['ref1', 'ref2']);
    await act(async () => thumbnails()[0].click()); await settle();
    expect(ids()).toEqual(['ref1', 'ref2', 'ref1']);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelectorAll('[aria-label="生成提示词"]')).toHaveLength(1); expect(ids()).toEqual(['ref1', 'ref2', 'ref1']);
  });
  it('preserves a newline after references without submitting on Shift+Enter or IME Enter', async () => {
    await render(mentions[0].tag + mentions[1].tag); await type('说明');
    await key('Enter', { shiftKey: true }); expect(readPromptInput(input())).toContain('说明\n');
    await key('Enter', { isComposing: true }); expect(generate).not.toHaveBeenCalled();
    expect(ids()).toEqual(['ref1', 'ref2']);
  });
  it('copies readable full labels and preserves both bindings on same-editor paste', async () => {
    await render(mentions[0].tag + mentions[1].tag); input().focus();
    const range = document.createRange(); range.selectNodeContents(input()); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    const values = new Map<string,string>(), clipboard = { setData: (kind: string, value: string) => values.set(kind,value), getData: (kind: string) => values.get(kind) || '' };
    const copy = new Event('copy', { bubbles: true, cancelable: true }); Object.defineProperty(copy,'clipboardData',{value:clipboard});
    await act(async () => input().dispatchEvent(copy));
    expect(values.get('text/plain')).toContain(names[0]); expect(values.get('text/plain')).not.toContain('\u2060');
    range.selectNodeContents(input()); range.collapse(false); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    const paste = new Event('paste', { bubbles:true,cancelable:true }); Object.defineProperty(paste,'clipboardData',{value:clipboard});
    await act(async () => input().dispatchEvent(paste)); expect(ids()).toEqual(['ref1','ref2','ref1','ref2']);
  });
  it('persists repeated bindings and restores them when the prompt panel remounts', async () => {
    await render(); await type('@'); await choose(0); await type('@'); await choose(0);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    const saved = useStore.getState().nodes.find(n => n.id === 'video')!.data;
    await act(async () => root.render(<ReactFlowProvider><VideoNode id="video" data={{}} selected={false} /></ReactFlowProvider>));
    await act(async () => root.render(<ReactFlowProvider><VideoNode id="video" data={saved} selected /></ReactFlowProvider>));
    expect(ids()).toEqual(['ref1','ref1']);
  });
});
