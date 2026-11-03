import { useState, type ReactNode } from 'react';
import { Hand, Mic, Settings2, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { thinkingEfforts, type ThinkingEffort } from './thinking-effort';
import './agent-settings-popover.css';

export function AgentSettingsPopover({ zh, model, effort, onEffortChange, manualConfirmation, onManualChange,
  running, listening, speechSupported, onToggleMic, runtimeLabel, usage, visionModel }: {
  zh: boolean; model: string; effort: ThinkingEffort; onEffortChange: (value: ThinkingEffort) => void;
  manualConfirmation: boolean; onManualChange: (value: boolean) => void; running: boolean;
  listening: boolean; speechSupported: boolean; onToggleMic: () => void; runtimeLabel: string; usage?: ReactNode;
  visionModel?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const options = thinkingEfforts(model);
  const label = (value: ThinkingEffort) => options.length === 2 && value === 'high'
    ? (zh ? '开启' : 'On')
    : ({ off: ['关闭', 'Off'], low: ['低', 'Low'], high: ['高', 'High'], max: ['最高', 'Max'] })[value][zh ? 0 : 1];
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" className="agent-settings-trigger" aria-label={zh ? '智能体设置' : 'Assistant settings'}
        title={zh ? '智能体设置' : 'Assistant settings'}>
        <Settings2 size={14} /><span>{zh ? '智能体设置' : 'Settings'}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent className="agent-settings-popover" side="bottom" align="end" sideOffset={10} collisionPadding={12}
      aria-label={zh ? '智能体设置' : 'Assistant settings'} onWheel={event => event.stopPropagation()}>
      <div className="agent-settings-heading"><strong>{zh ? '智能体设置' : 'Assistant settings'}</strong>
        <button type="button" onClick={() => setOpen(false)} aria-label={zh ? '关闭设置' : 'Close settings'}><X size={16} /></button>
      </div>
      <p className="agent-settings-hint">{running
        ? (zh ? '任务运行中，完成后可修改参数。' : 'Settings are locked until the current run finishes.')
        : (zh ? '自动保存到当前账号的本画布，下一条消息生效。' : 'Saved for this account and canvas. Applies to the next message.')}</p>
      <section>
        <div className="agent-settings-row"><span><Hand size={14} />{zh ? '生成前手动确认' : 'Confirm before generation'}</span>
          <button type="button" role="switch" aria-label={zh ? '手动确认' : 'Manual confirmation'}
            aria-checked={manualConfirmation} disabled={running} onClick={() => onManualChange(!manualConfirmation)}
            className="agent-settings-switch"><i /></button>
        </div>
        <p>{manualConfirmation
          ? (zh ? '生成图片、视频前，先展示参数卡片，确认后才提交。' : 'Review the parameter card before submitting image or video generation.')
          : (zh ? '已开启自动执行：按你的请求直接提交生成，会消耗积分。' : 'Automatic execution is enabled. Requested generation will spend credits.')}</p>
      </section>
      <section>
        <div className="agent-settings-row"><span>{zh ? '模型思考深度' : 'Thinking depth'}</span>
          <strong>{options.length ? label(effort) : (zh ? '不支持' : 'Not supported')}</strong></div>
        {options.length ? <>
          <p>{options.length > 2
            ? (zh ? '深度越高，思考越充分，耗时和用量也可能增加。' : 'Higher effort may take longer and use more tokens.')
            : (zh ? '当前模型仅支持开启或关闭。' : 'This model only supports on/off.')}</p>
          <input type="range" min={0} max={options.length - 1} step={1} value={Math.max(0, options.indexOf(effort))}
            aria-label={zh ? '模型思考深度' : 'Thinking depth'} aria-valuetext={label(effort)} disabled={running}
            onChange={event => onEffortChange(options[Number(event.target.value)])} />
          <div className="agent-settings-levels">{options.map(option => <button key={option} type="button" disabled={running}
            aria-pressed={option === effort} onClick={() => onEffortChange(option)}>{label(option)}</button>)}</div>
        </> : <p>{zh ? '当前模型未提供思考深度参数，切换支持的模型后可设置。' : 'Choose a supported model to adjust thinking depth.'}</p>}
      </section>
      {visionModel !== undefined && <section>
        <div className="agent-settings-row"><span>{zh ? '素材理解' : 'Media understanding'}</span>
          <strong>{visionModel ? (zh ? '按需分析' : 'On demand') : (zh ? '当前模型不支持' : 'Not supported')}</strong></div>
        <p>{visionModel
          ? (zh ? '使用当前模型看图、抽帧分析视频；涉及素材时才调用，不自动读取整张画布。视频抽帧不包含音频分析。' : 'The selected model inspects images or sampled video frames only when needed. It does not automatically read the canvas or analyze audio.')
          : (zh ? '当前模型未声明视觉能力，可以读取节点信息，但不能据此描述画面。需要看图或视频分析时，请手动切换支持的模型；不会自动换模型。' : 'This model can read node metadata but cannot inspect its visual content. Choose a vision-capable model to analyze media; models are never switched automatically.')}</p>
      </section>}
      {speechSupported && <section className="agent-settings-row">
        <span><Mic size={14} />{zh ? '语音输入' : 'Voice input'}</span>
        <button type="button" className="agent-settings-voice" disabled={running && !listening} onClick={onToggleMic}>
          {listening ? (zh ? '停止听写' : 'Stop dictation') : (zh ? '开始听写' : 'Start dictation')}</button>
      </section>}
      {(runtimeLabel || usage) && <section>
        {runtimeLabel && <p>{zh ? (running ? '正在执行' : '本次运行') : 'Last run'} · {runtimeLabel}</p>}
        {usage}
      </section>}
    </PopoverContent>
  </Popover>;
}
