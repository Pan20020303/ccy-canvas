// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { ThinkingEffortControl } from './ThinkingEffortControl';
import { effectiveThinkingEffort, type ThinkingEffort } from './thinking-effort';

function Harness({model = 'deepseek-flash', disabled = false}: {model?:string;disabled?:boolean}) {
  const [value,setValue] = useState<ThinkingEffort | null>(null);
  return <ThinkingEffortControl model={model} value={effectiveThinkingEffort(model,value)} onChange={setValue} disabled={disabled} zh />;
}

describe('thinking depth popover', () => {
  let host:HTMLDivElement,root:Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
    vi.stubGlobal('ResizeObserver',class { observe() {} unobserve() {} disconnect() {} });
    host=document.createElement('div');document.body.append(host);root=createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
  });
  it('opens actual depth choices, changes the selection and closes on Escape',async () => {
    await act(async () => root.render(<Harness />));
    const trigger=host.querySelector('button')!;
    expect(trigger.textContent).toContain('高');
    await act(async () => trigger.click());
    expect(document.querySelector('input[type="range"]')?.getAttribute('max')).toBe('3');
    const maxButton=Array.from(document.querySelectorAll('.agent-effort-levels button')).find(el=>el.textContent==='最高') as HTMLButtonElement;
    await act(async () => maxButton.click());
    expect(trigger.textContent).toContain('最高');
    expect(trigger.getAttribute('data-level')).toBe('max');
    const offButton=Array.from(document.querySelectorAll('.agent-effort-levels button')).find(el=>el.textContent==='关闭') as HTMLButtonElement;
    await act(async () => offButton.click());
    expect(trigger.textContent).toContain('关闭');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    expect(document.querySelector('input[type="range"]')).toBeNull();
  });
  it('locks controls while running and omits unsupported models',async () => {
    await act(async () => root.render(<Harness disabled />));
    expect(host.querySelector('button')?.disabled).toBe(true);
    await act(async () => host.querySelector('button')!.click());
    expect(document.querySelector('input[type="range"]')).toBeNull();
    await act(async () => root.render(<Harness model="gpt-4.1" />));
    expect(host.querySelector('button')).toBeNull();
  });
});
