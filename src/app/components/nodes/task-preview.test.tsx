// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { nodeTypes } from './CustomNodes';
import { NodeVersionsBadge } from './NodeVersions';

describe('registered canvas media nodes', () => {
  it.each(['imageNode', 'videoNode'] as const)('%s exposes ready previews during storage sync', (kind) => {
    const Component = nodeTypes[kind];
    const html = renderToStaticMarkup(<ReactFlowProvider><Component {...{
      id: 'preview-test', selected: false,
      data: { url: '/uploads/staging/generated/preview.png', status: 'running', taskPhase: 'persisting', assetSyncing: true },
    }} /></ReactFlowProvider>);
    expect(html).toContain('存储同步中，可预览');
    expect(html).not.toContain('生成完成 · 返回中');
    expect(html).not.toContain('Finalizing');
  });

  it('does not display a duplicate legacy staging version badge', () => {
    const path = '2026-09/11111111-2222-4333-8444-555555555555.png';
    const html = renderToStaticMarkup(<NodeVersionsBadge nodeId="preview-test" mediaKind="image"
      activeUrl={`https://bucket.oss-cn-beijing.aliyuncs.com/generated/${path}`}
      versions={[{ id: 'old-preview', url: `/uploads/staging/generated/${path}`, timestamp: 1 }]} />);
    expect(html).toBe('');
  });
});
