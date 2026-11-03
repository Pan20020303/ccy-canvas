import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useStore } from '../../store';
import { useCanvasPreferences } from '../../canvas-preferences';
import { playNotificationSound, shouldNotifyGeneration } from '../../canvas-notifications';
import { toRenderableMediaUrl } from '../../reference-media';
import { cancelCanvasSubmissions } from '../../canvas-submit-delay';

/** Only status transitions observed in the active project count as fresh events. */
export function CanvasGenerationNotifications() {
  const projectId = useStore(state => state.activeBackendProjectId);
  const userId = useCanvasPreferences(state => state.userId);
  useEffect(() => {
    const emitted = new Set<string>();
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.activeBackendProjectId !== projectId || previous.activeBackendProjectId !== projectId || state.nodes === previous.nodes) return;
      const before = new Map(previous.nodes.map(node => [node.id,node]));
      for (const node of state.nodes) {
        const old = before.get(node.id)?.data;
        if (!old || !['running','generating'].includes(String(old.status)) || !(old.taskId || old.runningStartedAt)) continue;
        const data = node.data;
        const failed = data.status === 'error' || Boolean(data.lastGenerationError && data.lastGenerationError !== old.lastGenerationError);
        if (!failed && data.status !== 'done') continue;
        // Real generation code attaches an owner and a run start timestamp.
        const key = `${node.id}:${data.taskId || old.taskId || old.runningStartedAt || ''}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        if (emitted.size > 500) emitted.delete(emitted.values().next().value!);
        const preferences = useCanvasPreferences.getState().values;
        const away = document.visibilityState === 'hidden' || !document.hasFocus();
        if (!shouldNotifyGeneration(preferences, { failed, own: data.generationOwnerId === userId, away })) continue;
        const title = `${String(data.customTitle || data.sourceName || '画布节点')} · ${failed ? '生成失败' : '生成完成'}`;
        const locate = () => { if (useStore.getState().activeBackendProjectId === projectId) useStore.getState().requestCanvasFocus(node.id); };
        if (failed) toast.error(title, { action: { label: '查看节点', onClick: locate } });
        else toast.success(title, { action: { label: '查看节点', onClick: locate } });
        if (preferences.sound) void playNotificationSound(preferences.soundStyle).catch(() => {});
        if (preferences.systemNotifications && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try { const notification = new Notification(title, { tag: key, body: '点击返回画布查看实际结果。' }); notification.onclick = () => { window.focus(); locate(); notification.close(); }; } catch { /* Browser notifications may be unavailable on mobile; the in-app notification remains. */ }
        }
      }
    });
    return () => { unsubscribe(); cancelCanvasSubmissions(); };
  }, [projectId,userId]);
  return null;
}

export function CanvasBackground() {
  const values = useCanvasPreferences(state => state.values);
  const node = useStore(state => state.nodes.find(item => item.id === values.backgroundNodeId));
  const src = typeof node?.data.url === 'string' && ['imageNode','referenceImageNode'].includes(node.type ?? '') ? toRenderableMediaUrl(node.data.url) : '';
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  const enabled = values.backgroundEnabled && src;
  return <>
    {enabled && !failed && <>
      <img src={src} onError={() => setFailed(true)} alt="" className="hidden" />
      <div className="canvas-custom-background" aria-hidden style={{ backgroundImage: `url(${JSON.stringify(src)})`, backgroundSize: values.backgroundMode === 'tile' ? `${values.backgroundTileSize * 4}px auto` : values.backgroundMode, backgroundRepeat: values.backgroundMode === 'tile' ? 'repeat' : 'no-repeat', opacity: values.backgroundOpacity / 100, filter: `blur(${values.backgroundBlur}px)` }} />
    </>}
    {values.ambientGlow && <div className="canvas-ambient-glow" aria-hidden />}
    {enabled && failed && <div className="pointer-events-none absolute left-4 top-16 z-10 rounded bg-black/60 px-3 py-2 text-xs text-rose-200" role="status">背景图片加载失败，请在画布设置中重新选择。</div>}
  </>;
}
