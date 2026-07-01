import { useEffect, useState } from 'react';
import { X, Keyboard, Wrench, Bot } from 'lucide-react';
import { useStore, DEFAULT_SHORTCUTS, formatShortcutCombo } from '../store';
import { SkillsSettingsTab } from './settings/SkillsSettingsTab';
import { AgentsSettingsTab } from './settings/AgentsSettingsTab';

const SECTIONS = [
  { id: 'skills',    icon: Wrench,   zh: '我的技能',   en: 'My Skills'     },
  { id: 'agents',    icon: Bot,      zh: '我的智能体', en: 'My Agents'     },
  { id: 'shortcuts', icon: Keyboard, zh: '键盘快捷键', en: 'Shortcuts'     },
];

const ACTION_LABELS: Record<string, { zh: string; en: string }> = {
  zoom_in: { zh: '放大', en: 'Zoom in' },
  zoom_out: { zh: '缩小', en: 'Zoom out' },
  fit_view: { zh: '聚焦节点 / 适应画布', en: 'Fit view' },
  toggle_minimap: { zh: '小地图', en: 'Toggle minimap' },
  pan_drag: { zh: '拖动画布（按住）', en: 'Pan canvas (hold)' },
  multi_select: { zh: '多选对齐功能', en: 'Multi-select align' },
  guide_snap: { zh: '辅助线吸附', en: 'Guide snapping' },
  grid_toggle: { zh: '网格吸附开关', en: 'Grid snap toggle' },
  show_grid: { zh: '显示网格点', en: 'Show grid dots' },
  duplicate_node: { zh: '复制节点', en: 'Duplicate node' },
  duplicate_image: { zh: '复制图像', en: 'Duplicate image' },
  cut_node: { zh: '剪切节点', en: 'Cut node' },
  drag_clone: { zh: '拖拽创建连线副本', en: 'Drag-clone with link' },
  paste_node: { zh: '粘贴节点', en: 'Paste node' },
  undo: { zh: '撤销', en: 'Undo' },
  redo: { zh: '重做', en: 'Redo' },
  delete_node: { zh: '删除节点', en: 'Delete node' },
  select_all: { zh: '全选', en: 'Select all' },
};

const ShortcutKey = ({
  action,
  combo,
  onRecord,
  isRecording,
}: {
  action: string;
  combo: string;
  onRecord: (a: string) => void;
  isRecording: boolean;
}) => {
  const parts = combo.split('+');
  return (
    <button
      onClick={() => onRecord(action)}
      className={`flex items-center gap-1 ${isRecording ? 'animate-pulse' : ''}`}
    >
      {isRecording ? (
        <span className="px-3 py-1 rounded-md bg-cyan-500/20 border border-cyan-400/40 text-[10px] text-cyan-200 tracking-wider">
          REC…
        </span>
      ) : (
        parts.map((p, i) => (
          <span
            key={i}
            className="min-w-[24px] px-1.5 py-0.5 rounded bg-white/[0.06] border border-white/10 text-[11px] text-neutral-200 text-center"
          >
            {p}
          </span>
        ))
      )}
    </button>
  );
};

export const SettingsModal = () => {
  const { language, isSettingsOpen, setSettingsOpen, shortcuts, setShortcut, resetShortcuts } = useStore();
  const [section, setSection] = useState('skills');
  const [recording, setRecording] = useState<string | null>(null);
  const zh = language === 'zh';

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setRecording(null); return; }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      const combo = formatShortcutCombo(e);
      setShortcut(recording, combo);
      setRecording(null);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recording, setShortcut]);

  if (!isSettingsOpen) return null;

  const entries = Object.keys(DEFAULT_SHORTCUTS);
  const mid = Math.ceil(entries.length / 2);
  const leftCol = entries.slice(0, mid);
  const rightCol = entries.slice(mid);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setSettingsOpen(false)} />
      <div className="relative z-10 flex w-[860px] max-w-[95vw] h-[560px] bg-[#0c0e11] border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
        <aside className="w-44 border-r border-white/5 bg-white/[0.02] py-4">
          <div className="px-4 mb-3 text-sm text-neutral-200">{zh ? '设置' : 'Settings'}</div>
          {SECTIONS.map(s => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`w-full flex items-center gap-2 px-4 py-2 text-xs transition ${
                  section === s.id ? 'bg-white/[0.06] text-neutral-100 border-r-2 border-cyan-400' : 'text-neutral-400 hover:bg-white/[0.03]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {zh ? s.zh : s.en}
              </button>
            );
          })}
        </aside>

        <div className="flex-1 flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
            <div className="text-sm text-neutral-200">
              {zh ? SECTIONS.find(s => s.id === section)?.zh : SECTIONS.find(s => s.id === section)?.en}
            </div>
            <button onClick={() => setSettingsOpen(false)} className="text-neutral-500 hover:text-white transition">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {section === 'skills' ? (
              <SkillsSettingsTab />
            ) : section === 'agents' ? (
              <AgentsSettingsTab />
            ) : section === 'shortcuts' ? (
              <>
                <div className="text-sm text-neutral-200 mb-1">{zh ? '预设方案' : 'Preset'}</div>
                <div className="text-xs text-neutral-500 mb-3">
                  {zh ? '点击右侧按键开始录制，按下任意组合键即可保存，Esc 取消。' : 'Click a key cell to record. Press any combo to save, Esc to cancel.'}
                </div>
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-white/[0.04] border border-white/10 text-xs text-neutral-300 mb-6">
                  {zh ? '用户自定义' : 'User custom'}
                </div>

                <div className="grid grid-cols-2 gap-x-10 gap-y-3">
                  {[leftCol, rightCol].map((col, idx) => (
                    <div key={idx} className="space-y-3">
                      {col.map(action => {
                        const label = ACTION_LABELS[action];
                        return (
                          <div key={action} className="flex items-center justify-between">
                            <span className="text-xs text-neutral-300">{zh ? label?.zh : label?.en}</span>
                            <ShortcutKey
                              action={action}
                              combo={shortcuts[action] || DEFAULT_SHORTCUTS[action]}
                              onRecord={setRecording}
                              isRecording={recording === action}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between pt-6 mt-6 border-t border-white/5">
                  <span className="text-[11px] text-neutral-500">
                    {zh ? 'Esc 退出录制 / 关闭面板' : 'Esc — exit recording / close panel'}
                  </span>
                  <button
                    onClick={resetShortcuts}
                    className="px-3 py-1.5 rounded-md bg-white/[0.06] border border-white/10 text-xs text-neutral-200 hover:bg-white/10 transition"
                  >
                    {zh ? '恢复默认设置' : 'Restore defaults'}
                  </button>
                </div>
              </>
            ) : (
              <div className="text-xs text-neutral-500">
                {zh ? '该分区还在开发中。' : 'This section is coming soon.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
