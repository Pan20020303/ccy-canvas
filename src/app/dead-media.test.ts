import { describe, expect, it, vi } from 'vitest';
import { isCertainlyDeadSrc, reportDeadMedia } from './dead-media';

describe('preview failure never deletes user records', () => {
  it.each([true, false])('ignores legacy delete callbacks regardless of certainty=%s', certain => {
    const remove = vi.fn();
    for (let i = 0; i < 30; i++) reportDeadMedia(certain, remove);
    expect(remove).not.toHaveBeenCalled();
  });
  it.each(['', '/uploads/missing.png', 'https://example.com/expired.png', 'blob:expired', 'data:image/png;base64,bad'])('cannot infer record deletion from %s', src => {
    expect(isCertainlyDeadSrc(src)).toBe(false);
  });
});
