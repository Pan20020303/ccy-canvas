/**
 * Brand icon descriptors for AI models shown in the prompt-panel model dropdown.
 *
 * Each entry returns a small inline SVG (a stylized monogram) that visually
 * matches the model's vendor. We render shapes rather than fetching upstream
 * brand assets to:
 *   - keep this offline-safe
 *   - sidestep brand-asset licensing
 *   - stay performant (no external requests)
 *
 * To add a new vendor:
 *   1. Match on a substring of the model name (case-insensitive) in `getModelBrand`.
 *   2. Provide a `kind` + `color` that look distinct from the others.
 */

export type ModelBrandKind =
  | 'midjourney'  // angled M / triangle
  | 'qwen'        // round Q
  | 'sora'        // O ring (OpenAI)
  | 'runway'      // R block
  | 'suno'        // wave bars
  | 'seedance'    // bar chart
  | 'gpt'         // OpenAI ring with slash
  | 'flux'        // diamond
  | 'kling'       // K
  | 'hailuo'      // H
  | 'generic';

export type ModelBrand = {
  kind: ModelBrandKind;
  /** Background / fill color (hex). */
  color: string;
  /** Optional vendor display name (used in tooltip). */
  vendor?: string;
};

/** Map a model name to its brand descriptor. Falls back to `generic`. */
export function getModelBrand(model: string | undefined | null): ModelBrand {
  const m = (model || '').toLowerCase();
  if (!m) return { kind: 'generic', color: '#6b7280' };

  if (m.includes('midjourney') || m.includes('niji')) return { kind: 'midjourney', color: '#94a3b8', vendor: 'Midjourney' };
  if (m.includes('qwen'))         return { kind: 'qwen',       color: '#a78bfa', vendor: 'Qwen' };
  if (m.includes('sora'))         return { kind: 'sora',       color: '#0ea5e9', vendor: 'OpenAI Sora' };
  if (m.includes('gpt') || m.includes('dall'))
                                  return { kind: 'gpt',        color: '#22d3ee', vendor: 'OpenAI' };
  if (m.includes('runway') || m.includes('gen'))
                                  return { kind: 'runway',     color: '#fbbf24', vendor: 'Runway' };
  if (m.includes('suno'))         return { kind: 'suno',       color: '#34d399', vendor: 'Suno' };
  if (m.includes('seed') || m.includes('seedance') || m.includes('seedream'))
                                  return { kind: 'seedance',   color: '#f472b6', vendor: 'ByteDance' };
  if (m.includes('flux'))         return { kind: 'flux',       color: '#f97316', vendor: 'Black Forest Labs' };
  if (m.includes('kling'))        return { kind: 'kling',      color: '#60a5fa', vendor: 'Kling' };
  if (m.includes('hailuo') || m.includes('minimax'))
                                  return { kind: 'hailuo',     color: '#fb7185', vendor: 'MiniMax Hailuo' };
  if (m.includes('z-image') || m.includes('zimage') || m.includes('libnavo') || m.includes('lib-navo') || m.includes('lib navo'))
                                  return { kind: 'flux',       color: '#22d3ee', vendor: 'Lib' };

  return { kind: 'generic', color: '#6b7280' };
}
