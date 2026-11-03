// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MediaThumb, MediaVideoThumb } from './MediaThumb';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
let root: Root | undefined;
let host: HTMLDivElement;
function mount(element: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host); act(() => root!.render(element));
}
function fail(selector = 'img') { act(() => host.querySelector(selector)!.dispatchEvent(new Event('error'))); }
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.replaceChildren(); });

it('retains an unloadable record, permits manual retry, and does not activate its parent tile', () => {
  const remove = vi.fn(), select = vi.fn();
  mount(<div onClick={select}><MediaThumb src="/missing.png" alt="Original" onDead={remove} className="tile" /></div>);
  fail(); fail();
  const placeholder = host.querySelector('[role="button"]') as HTMLElement;
  expect(placeholder.className).toContain('tile');
  expect(placeholder.title).toContain('原记录已保留');
  act(() => placeholder.click());
  expect(host.querySelector('img')!.getAttribute('src')).toBe('/missing.png');
  expect(remove).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
});

it.each(['data:image/png;base64,bad', 'blob:old', '/photo.png?signature=keep%2Bthis'])('retries exact local/transient URL without adding query parameters: %s', src => {
  mount(<MediaThumb src={src} />);
  fail();
  expect(host.querySelector('img')!.getAttribute('src')).toBe(src);
});

it('falls back from proxy to the exact original signed URL', () => {
  const source = 'https://images.example/a.png?signature=a%2Bb&expires=123';
  mount(<MediaThumb src={source} />);
  expect(host.querySelector('img')!.getAttribute('src')).toContain('/api/app/proxy-media?url=');
  fail(); expect(host.querySelector('img')!.getAttribute('src')).toBe(source);
});

it('resets failure when hydration changes src and lazy-decodes images', () => {
  mount(<MediaThumb src="/old.png" />); fail(); fail();
  act(() => root!.render(<MediaThumb src="/new.png" />));
  const img = host.querySelector('img')!;
  expect(img.getAttribute('src')).toBe('/new.png');
  expect(img.getAttribute('loading')).toBe('lazy');
  expect(img.getAttribute('decoding')).toBe('async');
});

it('keeps an empty hydrated placeholder without requesting or deleting media', () => {
  const remove = vi.fn(); mount(<MediaThumb src="" onDead={remove} />);
  expect(host.querySelector('img')).toBeNull();
  expect(host.querySelector('[role="button"]')).toBeNull();
  expect(remove).not.toHaveBeenCalled();
});

it('uses video metadata loading and keeps a retryable history tile on failure', () => {
  mount(<MediaVideoThumb src="/clip.mp4" />);
  expect(host.querySelector('img')).toBeNull();
  expect(host.querySelector('video')!.getAttribute('preload')).toBe('metadata');
  fail('video'); fail('video');
  act(() => host.querySelector('[role="button"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(host.querySelector('video')!.getAttribute('src')).toBe('/clip.mp4');
});
