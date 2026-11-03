import { useState } from 'react';
import type { ThinkingEffort } from './thinking-effort';

type Preferences = { manualConfirmation: boolean; efforts: Record<string, ThinkingEffort> };
const defaults: Preferences = { manualConfirmation: true, efforts: {} };

function read(key: string | null): Preferences {
  if (!key) return defaults;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    const efforts: Record<string, ThinkingEffort> = {};
    for (const [model, value] of Object.entries(saved?.efforts ?? {})) {
      if (['off', 'low', 'high', 'max'].includes(value as string)) efforts[model] = value as ThinkingEffort;
    }
    // Only an explicit false opts into spending without another confirmation.
    return { manualConfirmation: saved?.manualConfirmation !== false, efforts };
  } catch { return defaults; }
}

/** Browser preferences are isolated by account AND canvas; no effect writes on switching. */
export function useAgentPreferences(userId: string | undefined, projectId: string) {
  const key = userId && projectId ? `ccy:agent-settings:v1:${userId}:${projectId}` : null;
  const [state, setState] = useState(() => ({ key, value: read(key) }));
  const preferences = state.key === key ? state.value : read(key);
  const update = (value: Preferences) => {
    if (key) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Still works for this session. */ } }
    setState({ key, value });
  };
  return {
    preferences,
    setManualConfirmation: (value: boolean) => update({ ...preferences, manualConfirmation: value }),
    setModelEffort: (model: string, value: ThinkingEffort) => update({ ...preferences, efforts: { ...preferences.efforts, [model]: value } }),
  };
}
