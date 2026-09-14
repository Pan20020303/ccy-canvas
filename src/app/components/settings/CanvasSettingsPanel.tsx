import { useRef, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpRight, Check, ChevronLeft, Settings2, X } from 'lucide-react';
import { useStore } from '../../store';
import { CANVAS_THEMES, EDGE_COLORS, NUMERIC_PREFERENCE_LIMITS, SIMPLE_PALETTES, SOUND_STYLES, canvasThemeVariables, useCanvasPreferences, type CanvasPreferences } from '../../canvas-preferences';
import { toRenderableMediaUrl } from '../../reference-media';
import { playNotificationSound, requestCanvasNotificationPermission } from '../../canvas-notifications';
import { simplePaletteColors } from '../../canvas-preferences';
import './canvas-settings.css';

const sections = [
  ['interaction','交互操作'],['notifications','生成通知'],['edges','连线设置'],['grid','网格与显示'],['layout','节点与布局'],['background','自定义背景'],['theme','画布主题'],['edge-colors','连线色彩'],['simple','简化配色'],
] as const;
export function CanvasSettingsPanel({ onAdvanced }: { onAdvanced: () => void }) {
  const close = useStore(state => state.setSettingsOpen);
  const nodes = useStore(state => state.nodes);
  const values = useCanvasPreferences(state => state.values);
  const set = useCanvasPreferences(state => state.setPreference);
  const persistenceError = useCanvasPreferences(state => state.persistenceError);
  const [active, setActive] = useState<string>('interaction');
  const [expanded, setExpanded] = useState(false);
  const [pickBackground, setPickBackground] = useState(false);
  const [permissionNotice, setPermissionNotice] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const images = nodes.filter(node => ['imageNode','referenceImageNode'].includes(node.type ?? '') && typeof node.data.url === 'string' && node.data.url && node.data.status !== 'uploading');
  const background = images.find(node => node.id === values.backgroundNodeId);
  const offBackground = !values.backgroundEnabled || !background;
  const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const go = (id: string) => { setActive(id); const element = sectionRefs.current[id]; if (element && scroller.current) scroller.current.scrollTo({ top: element.offsetTop - 8, behavior: 'smooth' }); };
  const toggle = (key: keyof CanvasPreferences, label: string, description?: string) => <label className="canvas-setting-row" title={description} key={key}>
    <span>{label}</span><button className="canvas-setting-switch" type="button" role="switch" aria-label={label} aria-checked={Boolean(values[key])} onClick={async () => {
      if (key === 'systemNotifications' && !values.systemNotifications) {
        const granted = await requestCanvasNotificationPermission();
        setPermissionNotice(granted ? '' : '浏览器未授权系统通知，请在站点权限中允许通知；站内提醒仍可使用。');
        set('systemNotifications', granted); return;
      }
      set(key, !values[key]);
    }}><span /></button>
  </label>;
  const range = (key: keyof CanvasPreferences, label: string, unit = 'px', disabled = false) => {
    const [min,max,step] = NUMERIC_PREFERENCE_LIMITS[key]!;
    const value = Number(values[key]);
    const display = key === 'submitDelay' && value === 0 ? '关闭' : `${Number(value.toFixed(2))}${unit}`;
    return <label className={`canvas-setting-row canvas-setting-range ${disabled ? 'is-disabled' : ''}`} key={key}>
      <span>{label}</span><input aria-label={label} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={event => set(key, Number(event.target.value))} /><output>{display}</output>
    </label>;
  };
  const segment = (key: keyof CanvasPreferences, label: string, choices: Array<[string,string]>, disabled = false) => <div className={`canvas-setting-row ${disabled ? 'is-disabled' : ''}`} key={key}>
    <span>{label}</span><div className="canvas-setting-segment" role="group" aria-label={label}>{choices.map(([id,name]) => <button key={id} type="button" disabled={disabled} aria-pressed={values[key] === id} onClick={() => set(key, id)}>{name}</button>)}</div>
  </div>;
  const card = (id: string, title: string, children: React.ReactNode) => <section className="canvas-settings-card" ref={element => { sectionRefs.current[id] = element; }} id={`canvas-settings-${id}`}>
    <h3>{title}</h3>{children}
  </section>;

  return <Dialog.Root open modal={false} onOpenChange={open => { if (!open) close(false); }}><Dialog.Portal>
    <Dialog.Content className={`canvas-settings-panel ${expanded ? 'is-expanded' : ''}`} style={canvasThemeVariables(values) as CSSProperties} aria-describedby="canvas-settings-scope"
      onInteractOutside={event => event.preventDefault()} onKeyDown={event => event.stopPropagation()} onEscapeKeyDown={event => { event.stopPropagation(); if (pickBackground) { event.preventDefault(); setPickBackground(false); } }}>
      <header className="canvas-settings-header"><Dialog.Title>自定义画布</Dialog.Title><div className="canvas-settings-actions">
        <button className="canvas-settings-reset" onClick={() => { useCanvasPreferences.getState().restoreDefaults(); setPermissionNotice(''); }}>恢复默认</button>
        <button className="canvas-settings-icon" aria-label={expanded ? '收起设置面板' : '展开设置面板'} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}><ArrowUpRight /></button>
        <Dialog.Close className="canvas-settings-icon" aria-label="关闭画布设置"><X /></Dialog.Close>
      </div></header>
      <div className="canvas-settings-body"><nav className="canvas-settings-nav" aria-label="画布设置分类">{sections.map(([id,label]) => <button key={id} aria-current={active === id ? 'true' : undefined} onClick={() => go(id)}>{label}</button>)}</nav>
        <div ref={scroller} className="canvas-settings-scroll" onScroll={() => {
          const top = scroller.current?.scrollTop ?? 0; let next: string = 'interaction';
          for (const [id] of sections) { if ((sectionRefs.current[id]?.offsetTop ?? Infinity) <= top + 45) next = id; }
          if (scroller.current && top > 0 && top + scroller.current.clientHeight >= scroller.current.scrollHeight - 2) next = 'simple';
          setActive(next);
        }}>
          {card('interaction','交互操作', <div className="canvas-settings-grid">
            {range('panSensitivity','画布平移灵敏度','x')}{range('focusAnimationLimit','定位动画节点上限','')}
            {range('submitDelay','图 / 视 延迟提交','秒')}{range('connectionRadius','触摸点吸附范围')}
            {segment('blankAction','空白区域操作',[['context','右键菜单'],['double','双击菜单']])}{segment('wheelAction','滚轮默认操作',[['pan','平移'],['zoom','缩放']])}
            {segment('mentionNaming','@ 引用命名',[['name','名称'],['number','数字']])}{toggle('snapToGrid','拖拽吸附网格')}
            {toggle('alignmentGuides','对齐辅助线')}{toggle('dragFocus','拖动节点获取焦点')}
            {toggle('blurAfterSubmit','节点提交后取消焦点')}{toggle('compactZoom','极简模式缩放','缩放小于 35% 时以色块概览节点，选择节点可恢复详情。')}
            {toggle('linkedPreview','联动预览画布素材')}{toggle('hoverVideo','视频悬停自动播放')}
          </div>)}
          {card('notifications','生成通知', <><div className="canvas-settings-grid">
            {toggle('notifyCompleted','生成完成后通知')}{segment('notifyWhen','通知时机',[['away','仅切走时'],['always','始终']])}
            {toggle('systemNotifications','系统通知（浏览器）')}{toggle('notifyFailed','生成失败也通知')}
            {toggle('sound','提示音')}{toggle('onlyOwn','只通知我发起的任务')}
          </div><div className="canvas-setting-row canvas-setting-wide"><span>提示音风格</span><div className="canvas-setting-segment canvas-sound-styles" role="group" aria-label="提示音风格">{SOUND_STYLES.map(([id,name]) => <button key={id} aria-pressed={values.soundStyle === id} title={`试听${name}`} onClick={() => { set('soundStyle', id); void playNotificationSound(id).catch(() => setPermissionNotice('浏览器暂时无法播放提示音。')); }}>{name}</button>)}</div></div>
            {(permissionNotice || values.systemNotifications && permission !== 'granted') && <p className="canvas-settings-note" role="status">{permissionNotice || '系统通知权限已关闭，请在浏览器站点权限中重新允许。'}</p>}
            <p className="canvas-settings-note">只响应本次打开画布后观察到的真实完成 / 失败事件，不将历史结果当新通知。</p>
          </>)}
          {card('edges','连线设置', <div className="canvas-settings-grid">
            {range('edgeWidth','连线显示粗细')}{range('edgeHitWidth','连线焦点范围')}
            {toggle('edgeHover','连线悬停高亮')}{toggle('edgeAnimation','开启连线动画')}{toggle('onlyFocusedEdges','仅显示焦点连线')}
          </div>)}
          {card('grid','网格与显示', <div className="canvas-settings-grid">
            {range('gridGap','网格线间距')}{range('gridDotSize','网格点大小')}
            {toggle('showGrid','显示网格底纹')}{toggle('ambientGlow','背景氛围光晕')}{toggle('showMiniMap','显示导航小地图')}
          </div>)}
          {card('layout','节点与布局', <><div className="canvas-settings-grid">
            {range('horizontalGap','整理节点水平间距')}{range('verticalGap','整理节点垂直间距')}{range('groupPadding','打组包含边距')}{range('groupLabelScale','组标签大小','x')}
            {range('topToolbarScale','上方工具栏缩放','x')}{range('bottomToolbarScale','下方工具栏缩放','x')}{toggle('groupOccludesEdges','组节点盖住连线')}
          </div><p className="canvas-settings-note">间距用于下一次整理布局 / 新建分组，不会自动移动现有节点。</p></>)}
          {card('background','自定义背景', <><div className="canvas-settings-grid">
            {toggle('backgroundEnabled','启用背景图')}<div className="canvas-setting-row"><span>背景图片</span><button className="canvas-settings-small-button" onClick={() => setPickBackground(!pickBackground)}>从画布选择</button></div>
            {range('backgroundOpacity','不透明度','%',offBackground)}{range('backgroundBlur','模糊度','px',offBackground)}
            {segment('backgroundMode','显示方式',[['cover','铺满'],['contain','适应'],['tile','平铺']],offBackground)}{range('backgroundTileSize','平铺大小','%',offBackground || values.backgroundMode !== 'tile')}
          </div>
            <p className="canvas-settings-note">{background ? `当前背景：${String(background.data.customTitle || background.data.sourceName || background.id)}` : '请从当前画布选择一张已有图片。背景设置不会上传或生成素材。'}</p>
            {pickBackground && <div className="canvas-background-picker" role="group" aria-label="选择画布背景图片">{images.length === 0 ? <p>当前画布还没有可用图片</p> : images.map(node => <button key={node.id} aria-pressed={values.backgroundNodeId === node.id} onClick={() => { set('backgroundNodeId',node.id); set('backgroundEnabled',true); setPickBackground(false); }}><img src={toRenderableMediaUrl(String(node.data.url),{thumbWidth:180})} alt="" /><span>{String(node.data.customTitle || node.data.sourceName || node.id)}</span>{values.backgroundNodeId === node.id && <Check />}</button>)}</div>}
          </>)}
          {card('theme','画布色彩主题', <div className="canvas-theme-swatches" role="group" aria-label="画布色彩主题">{CANVAS_THEMES.map(([id,name,color]) => <button key={id} aria-label={name} aria-pressed={values.themeId === id} onClick={() => set('themeId',id)}><span style={{ background: color }}>{values.themeId === id && <Check />}</span><small>{name}</small></button>)}</div>)}
          {card('edge-colors','连线色彩方案', <><div className="canvas-theme-swatches canvas-edge-swatches" role="group" aria-label="连线色彩方案">{EDGE_COLORS.map(([id,name,color]) => <button key={id} aria-label={`连线${name}`} aria-pressed={values.edgeColorId === id} onClick={() => set('edgeColorId',id)}><span style={{ color: id === 'custom' ? values.customEdgeColor : color }}><i /><i /></span><small>{name}</small></button>)}</div>
            {values.edgeColorId === 'custom' && <label className="canvas-setting-row"><span>自定义连线颜色</span><input type="color" aria-label="自定义连线颜色" value={values.customEdgeColor} onChange={event => set('customEdgeColor',event.target.value)} /></label>}
          </>)}
          {card('simple','简化模式配色', <><div className="canvas-simple-swatches" role="group" aria-label="简化模式配色">{SIMPLE_PALETTES.map(([id,name]) => <button key={id} aria-pressed={values.simplePaletteId === id} onClick={() => set('simplePaletteId',id)}><span>{simplePaletteColors(values, id).map((color,index) => <i key={index} style={{background:color}} />)}</span><small>{name}</small></button>)}</div><p className="canvas-settings-note">开启“极简模式缩放”后生效，按文本、图片、视频、音频类型呈现。</p></>)}
        </div>
      </div>
      <footer className="canvas-settings-footer"><span id="canvas-settings-scope" role="status">{persistenceError ? '已生效，但浏览器保存失败' : '即时生效 · 自动保存到此账号 / 此浏览器'}</span>{persistenceError && <button onClick={() => useCanvasPreferences.getState().retrySave()}>重试保存</button>}<button onClick={onAdvanced}><Settings2 />高级设置</button></footer>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

export function BackToCanvasSettings({ onClick }: { onClick: () => void }) { return <button className="canvas-settings-back" onClick={onClick}><ChevronLeft size={14} />画布设置</button>; }
