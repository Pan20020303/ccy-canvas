import { expect, it } from 'vitest';
import { isOriginalImageResponse } from './media-measurement';

it('never promotes a local or remote resized preview to original dimensions', () => {
  expect(isOriginalImageResponse('/uploads/a.png', 'http://localhost/uploads/a.png?w=768&v=abc')).toBe(false);
  const source = 'https://cdn.example/a.png';
  expect(isOriginalImageResponse(source, `/api/app/proxy-media?url=${encodeURIComponent(source)}&w=720`)).toBe(false);
  expect(isOriginalImageResponse('/uploads/a.png?w=256', '/uploads/a.png?w=256')).toBe(false);
  expect(isOriginalImageResponse('/uploads/a.png', '/uploads/b.png')).toBe(false);
});

it('accepts matching original responses, including full-size proxies and retry cache busters', () => {
  expect(isOriginalImageResponse('/uploads/a.png', 'http://localhost/uploads/a.png')).toBe(true);
  const source = 'https://cdn.example/a.png';
  expect(isOriginalImageResponse(source, `/api/app/proxy-media?url=${encodeURIComponent(source)}`)).toBe(true);
  expect(isOriginalImageResponse('/uploads/a.png', '/uploads/a.png?_r=2')).toBe(true);
  expect(isOriginalImageResponse('', '')).toBe(false);
});
