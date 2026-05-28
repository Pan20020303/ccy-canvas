import { useEffect, useState } from 'react';
import { Timer, AlertTriangle } from 'lucide-react';
import { useStore } from '../store';

const TIMEOUT_MS = 8 * 60 * 1000;

export const RunTimer = () => {
  const activeRun = useStore(s => s.activeRun);
  const cancelNode = useStore(s => s.cancelNode);
  const lang = useStore(s => s.language);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!activeRun) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [activeRun]);

  if (!activeRun) return null;
  const elapsed = now - activeRun.startedAt;
  const timedOut = elapsed >= TIMEOUT_MS;
  const total = Math.floor(elapsed / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');

  return (
    <div className="fixed top-16 right-4 z-[60] flex items-center gap-2 px-3 py-2 rounded-full border border-white/10 bg-[#15181d]/90 backdrop-blur-xl shadow-xl">
      {timedOut ? (
        <>
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-xs text-amber-300">
            {lang === 'zh' ? '已超过 8 分钟，请检查' : 'Exceeded 8 min — please check'}
          </span>
          <button
            onClick={() => cancelNode(activeRun.nodeId)}
            className="ml-2 px-2 py-0.5 rounded text-[10px] bg-rose-500/20 text-rose-300 border border-rose-400/30 hover:bg-rose-500/30 transition"
          >
            {lang === 'zh' ? '取消' : 'Cancel'}
          </button>
        </>
      ) : (
        <>
          <Timer className="w-3.5 h-3.5 text-cyan-300" />
          <span className="text-xs text-neutral-200 tabular-nums">{mm}:{ss}</span>
          <span className="text-[10px] text-neutral-500 tracking-wider">
            {lang === 'zh' ? '生成中…' : 'Running…'}
          </span>
        </>
      )}
    </div>
  );
};
