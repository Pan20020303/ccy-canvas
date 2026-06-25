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
  | 'qwen'        // round Q (Alibaba Tongyi / Wanx)
  | 'sora'        // O ring (OpenAI)
  | 'runway'      // R block
  | 'suno'        // wave bars
  | 'seedance'    // bar chart (ByteDance Doubao Seedance/Seedream)
  | 'gpt'         // OpenAI hexagon (GPT / DALL-E / Whisper)
  | 'flux'        // diamond (BFL FLUX, Lib Navo, Z-image)
  | 'kling'       // K (Kuaishou Kling)
  | 'hailuo'      // H (MiniMax Hailuo / abab)
  | 'gemini'      // G with sparkle (Google Gemini / Imagen / Veo)
  | 'claude'      // C (Anthropic Claude)
  | 'deepseek'    // whale D (DeepSeek)
  | 'doubao'      // circular cluster (ByteDance Doubao)
  | 'newapi'      // gateway / relay hub
  | 'relaybases'  // relay bases image gateway
  | 'volcengine'  // Volcengine / Doubao platform
  | 'ernie'       // E (Baidu Wenxin/ERNIE)
  | 'zhipu'       // Z (Zhipu GLM/CogView)
  | 'hunyuan'     // 混 (Tencent Hunyuan)
  | 'moonshot'    // moon crescent (Kimi)
  | 'grok'        // X slash (xAI Grok)
  | 'stepfun'     // staircase (StepFun)
  | 'elevenlabs'  // 11 (ElevenLabs)
  | 'luma'        // sun (Luma Dream Machine)
  | 'pika'        // play triangle
  | 'vidu'        // V
  | 'recraft'     // R outline
  | 'ideogram'    // I
  | 'stability'   // S
  | 'generic';

export type ModelBrand = {
  kind: ModelBrandKind;
  /** Background / fill color (hex). */
  color: string;
  /** Optional vendor display name (used in tooltip). */
  vendor?: string;
};

function includesAny(value: string, keywords: string[]) {
  return keywords.some((keyword) => value.includes(keyword));
}

/** Map model/vendor/provider names to a brand descriptor. Falls back to `generic`. */
export function getModelBrand(
  model: string | undefined | null,
  vendor?: string | undefined | null,
  providerName?: string | undefined | null,
): ModelBrand {
  const m = (model || '').toLowerCase();
  const v = (vendor || '').toLowerCase();
  const p = (providerName || '').toLowerCase();
  const all = `${m} ${v} ${p}`;
  if (!all.trim()) return { kind: 'generic', color: '#6b7280' };

  // Provider / relay names come first so a relay-backed gpt-image model does
  // not visually masquerade as a first-party OpenAI channel.
  if (includesAny(all, ['relaybases', 'relay bases'])) return { kind: 'relaybases', color: '#38bdf8', vendor: 'RelayBases' };
  if (includesAny(all, ['newapi', 'new api'])) return { kind: 'newapi', color: '#22c55e', vendor: 'NewAPI' };
  if (includesAny(all, ['volcengine', 'volces', '火山', 'doubao', '豆包', 'seedance', 'seedream'])) {
    return { kind: 'volcengine', color: '#ff4d2d', vendor: '火山引擎 · 豆包' };
  }

  // Order matters: check more-specific keywords before general ones.
  if (m.includes('midjourney') || m.includes('niji')) return { kind: 'midjourney', color: '#94a3b8', vendor: 'Midjourney' };

  // ByteDance Doubao family
  if (m.includes('seedance') || m.includes('seedream') || m.includes('seed-'))
                                  return { kind: 'seedance',   color: '#f472b6', vendor: 'ByteDance · 即梦' };
  if (m.includes('doubao'))       return { kind: 'doubao',     color: '#fb7185', vendor: 'ByteDance · 豆包' };

  // Alibaba family
  if (m.includes('happyhorse'))   return { kind: 'qwen',       color: '#e879f9', vendor: 'Alibaba · HappyHorse' };
  if (m.includes('qwen') || m.includes('tongyi') || m.includes('cosyvoice') || m.includes('sambert'))
                                   return { kind: 'qwen',       color: '#a78bfa', vendor: 'Alibaba · 通义' };
  if (m.includes('wanx'))         return { kind: 'qwen',       color: '#c084fc', vendor: 'Alibaba · 万相' };

  // OpenAI family
  if (m.includes('sora'))         return { kind: 'sora',       color: '#0ea5e9', vendor: 'OpenAI Sora' };
  if (includesAny(all, ['openai']) || m.includes('gpt') || m.includes('dall') || m.includes('whisper') || m.includes('tts-1') || m.includes('o1-'))
                                  return { kind: 'gpt',        color: '#22d3ee', vendor: 'OpenAI' };

  // Google
  if (m.includes('gemini') || m.includes('imagen') || m.includes('veo'))
                                  return { kind: 'gemini',     color: '#4285f4', vendor: 'Google' };

  // Anthropic
  if (m.includes('claude'))       return { kind: 'claude',     color: '#d97706', vendor: 'Anthropic Claude' };

  // DeepSeek
  if (m.includes('deepseek'))     return { kind: 'deepseek',   color: '#3b82f6', vendor: 'DeepSeek' };

  // Baidu Wenxin / ERNIE
  if (m.includes('ernie') || m.includes('wenxin'))
                                  return { kind: 'ernie',      color: '#dc2626', vendor: '百度 · 文心' };

  // Zhipu GLM / CogView
  if (m.includes('glm') || m.includes('cogview'))
                                  return { kind: 'zhipu',      color: '#06b6d4', vendor: '智谱' };

  // Tencent Hunyuan
  if (m.includes('hunyuan'))      return { kind: 'hunyuan',    color: '#0891b2', vendor: '腾讯 · 混元' };

  // Moonshot Kimi
  if (m.includes('moonshot') || m.includes('kimi'))
                                  return { kind: 'moonshot',   color: '#facc15', vendor: 'Moonshot Kimi' };

  // xAI Grok
  if (m.includes('grok'))         return { kind: 'grok',       color: '#e5e7eb', vendor: 'xAI Grok' };

  // StepFun
  if (m.includes('step-') || m.includes('stepfun'))
                                  return { kind: 'stepfun',    color: '#10b981', vendor: '阶跃 · Step' };

  // ElevenLabs
  if (m.includes('eleven_') || m.includes('elevenlabs'))
                                  return { kind: 'elevenlabs', color: '#a3e635', vendor: 'ElevenLabs' };

  // Suno
  if (m.includes('suno') || m.includes('chirp') || m.includes('bark'))
                                  return { kind: 'suno',       color: '#34d399', vendor: 'Suno' };

  // Luma / Pika / Vidu / Runway
  if (m.includes('luma') || m.includes('ray-') || m.includes('dream-machine'))
                                  return { kind: 'luma',       color: '#fde047', vendor: 'Luma' };
  if (m.includes('pika'))         return { kind: 'pika',       color: '#ec4899', vendor: 'Pika' };
  if (m.includes('vidu'))         return { kind: 'vidu',       color: '#8b5cf6', vendor: 'Vidu' };
  if (m.includes('runway') || m.includes('gen3') || m.includes('gen-3'))
                                  return { kind: 'runway',     color: '#fbbf24', vendor: 'Runway' };

  // BFL FLUX / Lib Navo / Z-image / Stability / Recraft / Ideogram
  if (m.includes('flux'))         return { kind: 'flux',       color: '#f97316', vendor: 'Black Forest Labs' };
  if (m.includes('z-image') || m.includes('zimage') || m.includes('libnavo') || m.includes('lib-navo') || m.includes('lib navo'))
                                  return { kind: 'flux',       color: '#22d3ee', vendor: 'Lib' };
  if (m.includes('sd3') || m.includes('stable-image') || m.includes('stability'))
                                  return { kind: 'stability',  color: '#fb923c', vendor: 'Stability AI' };
  if (m.includes('recraft'))      return { kind: 'recraft',    color: '#e879f9', vendor: 'Recraft' };
  if (m.includes('ideogram') || /^v_\d/i.test(m))
                                  return { kind: 'ideogram',   color: '#7dd3fc', vendor: 'Ideogram' };

  // Kuaishou Kling
  if (m.includes('kling'))        return { kind: 'kling',      color: '#60a5fa', vendor: '可灵 Kling' };

  // MiniMax / Hailuo / abab
  if (m.includes('hailuo') || m.includes('minimax') || m.includes('abab') || m.includes('speech-01'))
                                  return { kind: 'hailuo',     color: '#fb7185', vendor: 'MiniMax 海螺' };

  return { kind: 'generic', color: '#6b7280' };
}
