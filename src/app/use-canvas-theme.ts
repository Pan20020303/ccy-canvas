import type { CSSProperties } from 'react';
import { canvasThemeVariables, useCanvasPreferences } from './canvas-preferences';
import { useStore } from './store';

/** Portals live outside the workspace and must receive the same theme tokens. */
export function useCanvasThemeStyle(): CSSProperties {
  const values = useCanvasPreferences(state => state.values);
  const theme = useStore(state => state.theme);
  return canvasThemeVariables(values, theme) as CSSProperties;
}
