import { useState } from 'react';
import { BrainCircuit, ChevronDown, Sparkles } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { thinkingEfforts, type ThinkingEffort } from './thinking-effort';

const labels = { off: ['关闭', 'Off'], low: ['低', 'Low'], high: ['高', 'High'], max: ['最高', 'Max'] };

/** PromptBar-style effort popover; only exposes levels supported by the model. */
export function ThinkingEffortControl({ model, value, onChange, disabled, zh }: {
  model: string; value: ThinkingEffort; onChange: (value: ThinkingEffort) => void; disabled: boolean; zh: boolean;
}) {
  const [open, setOpen] = useState(false);
  const options = thinkingEfforts(model);
  if (!options.length) return null;
  const index = Math.max(0, options.indexOf(value));
  const label = (effort: ThinkingEffort) => options.length === 2 && effort === 'high'
    ? (zh ? '开启' : 'On') : labels[effort][zh ? 0 : 1];
  return <Popover open={open && !disabled} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" disabled={disabled} className="agent-effort-trigger" data-level={value}
        aria-label={`${zh ? '思考深度' : 'Thinking depth'}：${label(value)}`}>
        {value === 'max' ? <Sparkles size={14} /> : <BrainCircuit size={14} />}
        <span>{zh ? '思考' : 'Think'} · {label(value)}</span><ChevronDown size={12} />
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" sideOffset={10} collisionPadding={12}
      className="agent-effort-popover" onWheel={event => event.stopPropagation()}>
      <div className="agent-effort-heading"><span>{zh ? '模型思考深度' : 'Thinking depth'}</span><strong>{label(value)}</strong></div>
      <p>{options.length > 2
        ? (zh ? '越高越充分，响应可能更慢、用量更多。' : 'Higher effort may take longer and use more tokens.')
        : (zh ? '此模型仅支持开启或关闭，不提供分档深度。' : 'This model supports on/off, not effort levels.')}</p>
      <input type="range" min={0} max={options.length - 1} step={1} value={index}
        aria-label={zh ? '模型思考深度' : 'Thinking depth'} aria-valuetext={label(value)}
        onChange={event => onChange(options[Number(event.target.value)])} />
      <div className="agent-effort-levels">{options.map(option => <button key={option} type="button"
        aria-pressed={value === option} onClick={() => onChange(option)}>{label(option)}</button>)}</div>
      <div className="agent-effort-note">{zh ? '用于下一条消息 · Esc 关闭' : 'Applies to the next message · Esc to close'}</div>
    </PopoverContent>
  </Popover>;
}
