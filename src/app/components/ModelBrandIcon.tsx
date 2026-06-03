import { getModelBrand, type ModelBrandKind } from '../model-brands';

/**
 * Small monogram SVG that visually identifies a model's vendor.
 * Used in the prompt-panel model dropdown, similar to a brand favicon.
 */
export function ModelBrandIcon({ model, size = 18 }: { model: string; size?: number }) {
  const brand = getModelBrand(model);
  const half = size / 2;

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-md"
      style={{ width: size, height: size, background: 'rgba(255,255,255,0.04)' }}
      title={brand.vendor}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        {renderShape(brand.kind, brand.color)}
      </svg>
    </span>
  );
  // half intentionally referenced to silence unused-var lint if added later
  void half;
}

function renderShape(kind: ModelBrandKind, color: string) {
  switch (kind) {
    case 'midjourney':
      // Two slanted bars forming an M / sail shape.
      return (
        <>
          <path d="M4 18 L9 6 L11 6 L7 18 Z" fill={color} />
          <path d="M11 18 L16 6 L18 6 L14 18 Z" fill={color} opacity="0.6" />
        </>
      );
    case 'qwen':
      // Stylized Q — circle with a tail.
      return (
        <>
          <circle cx="12" cy="12" r="7" stroke={color} strokeWidth="2" />
          <path d="M14 14 L18 18" stroke={color} strokeWidth="2" strokeLinecap="round" />
        </>
      );
    case 'sora':
      // O ring with subtle inner gap (OpenAI Sora vibe).
      return (
        <>
          <circle cx="12" cy="12" r="7" stroke={color} strokeWidth="2" />
          <circle cx="12" cy="12" r="2.5" fill={color} />
        </>
      );
    case 'gpt':
      // Hexagon-ish OpenAI ring.
      return (
        <path
          d="M12 4 L18 7.5 L18 14.5 L12 18 L6 14.5 L6 7.5 Z"
          stroke={color}
          strokeWidth="1.6"
          fill="none"
        />
      );
    case 'runway':
      // R-block.
      return (
        <>
          <rect x="6" y="6" width="12" height="12" rx="2" fill="none" stroke={color} strokeWidth="1.8" />
          <path d="M9 9 L9 15 M9 9 L13 9 Q15 9 15 11 Q15 13 13 13 L9 13 M12 13 L15 15" stroke={color} strokeWidth="1.6" fill="none" />
        </>
      );
    case 'suno':
      // Wave bars (audio).
      return (
        <>
          <rect x="6" y="11" width="2" height="6" rx="1" fill={color} />
          <rect x="10" y="8" width="2" height="9" rx="1" fill={color} />
          <rect x="14" y="6" width="2" height="11" rx="1" fill={color} />
          <rect x="18" y="9" width="2" height="8" rx="1" fill={color} />
        </>
      );
    case 'seedance':
      // Bar chart (ByteDance-ish).
      return (
        <>
          <rect x="5"  y="13" width="3" height="6" rx="1" fill={color} />
          <rect x="10" y="9"  width="3" height="10" rx="1" fill={color} />
          <rect x="15" y="6"  width="3" height="13" rx="1" fill={color} />
        </>
      );
    case 'flux':
      // Diamond (Black Forest Labs FLUX).
      return (
        <path d="M12 4 L20 12 L12 20 L4 12 Z" fill={color} opacity="0.85" />
      );
    case 'kling':
      // K letter mark.
      return (
        <>
          <path d="M7 6 L7 18" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M7 12 L15 6"  stroke={color} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M7 12 L15 18" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
        </>
      );
    case 'hailuo':
      // H letter mark.
      return (
        <>
          <path d="M7 6 L7 18 M17 6 L17 18 M7 12 L17 12" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
        </>
      );
    case 'gemini':
      // 4-pointed star (Google AI Gemini glyph).
      return (
        <path
          d="M12 3 C12 8 14 10 19 12 C14 14 12 16 12 21 C12 16 10 14 5 12 C10 10 12 8 12 3 Z"
          fill={color}
        />
      );
    case 'claude':
      // Anthropic-ish radial burst / sun.
      return (
        <>
          <circle cx="12" cy="12" r="3" fill={color} />
          <path
            d="M12 4 L13 9 L12 4 Z M12 20 L13 15 L12 20 Z M4 12 L9 13 L4 12 Z M20 12 L15 13 L20 12 Z M6.3 6.3 L9.5 9.5 M17.7 17.7 L14.5 14.5 M6.3 17.7 L9.5 14.5 M17.7 6.3 L14.5 9.5"
            stroke={color} strokeWidth="1.6" strokeLinecap="round"
          />
        </>
      );
    case 'deepseek':
      // Stylized whale silhouette (DeepSeek vibe).
      return (
        <>
          <path d="M5 14 Q5 9 10 9 L16 9 Q19 9 19 12 Q19 15 16 15 L10 15 Q5 15 5 14 Z" fill={color} />
          <circle cx="15" cy="12" r="0.9" fill="#0a0a0a" />
        </>
      );
    case 'doubao':
      // 3-bean cluster (Doubao = "豆包" = bean bun).
      return (
        <>
          <ellipse cx="9"  cy="11" rx="3.5" ry="2.5" fill={color} opacity="0.85" />
          <ellipse cx="15" cy="11" rx="3.5" ry="2.5" fill={color} opacity="0.6" />
          <ellipse cx="12" cy="16" rx="3.5" ry="2.5" fill={color} />
        </>
      );
    case 'ernie':
      // E letter mark (Wenxin / ERNIE).
      return (
        <path
          d="M7 6 L17 6 M7 6 L7 18 M7 12 L15 12 M7 18 L17 18"
          stroke={color} strokeWidth="2.2" strokeLinecap="round"
        />
      );
    case 'zhipu':
      // Z letter mark (Zhipu GLM/CogView).
      return (
        <path
          d="M7 6 L17 6 L7 18 L17 18"
          stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"
        />
      );
    case 'hunyuan':
      // "H + circle" abstract for Tencent Hunyuan.
      return (
        <>
          <circle cx="12" cy="12" r="7" fill="none" stroke={color} strokeWidth="1.6" />
          <path d="M9 9 L9 15 M15 9 L15 15 M9 12 L15 12" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
        </>
      );
    case 'moonshot':
      // Crescent moon (Kimi).
      return (
        <path
          d="M16 5 A8 8 0 1 0 16 19 A6 6 0 1 1 16 5 Z"
          fill={color}
        />
      );
    case 'grok':
      // X / slash (xAI).
      return (
        <>
          <path d="M6 6 L18 18" stroke={color} strokeWidth="2.4" strokeLinecap="round" />
          <path d="M18 6 L6 18" stroke={color} strokeWidth="2.4" strokeLinecap="round" />
        </>
      );
    case 'stepfun':
      // Staircase (StepFun).
      return (
        <path
          d="M6 18 L10 18 L10 14 L14 14 L14 10 L18 10 L18 6"
          stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"
        />
      );
    case 'elevenlabs':
      // "11" — two bars.
      return (
        <>
          <rect x="7"  y="6" width="2.8" height="12" rx="1.2" fill={color} />
          <rect x="14" y="6" width="2.8" height="12" rx="1.2" fill={color} />
        </>
      );
    case 'luma':
      // Sun rays + core (Dream Machine).
      return (
        <>
          <circle cx="12" cy="12" r="3.2" fill={color} />
          <path
            d="M12 3 L12 6 M12 18 L12 21 M3 12 L6 12 M18 12 L21 12 M5.6 5.6 L7.7 7.7 M16.3 16.3 L18.4 18.4 M5.6 18.4 L7.7 16.3 M16.3 7.7 L18.4 5.6"
            stroke={color} strokeWidth="1.8" strokeLinecap="round"
          />
        </>
      );
    case 'pika':
      // Play triangle.
      return (
        <path d="M7 5 L19 12 L7 19 Z" fill={color} />
      );
    case 'vidu':
      // V mark.
      return (
        <path
          d="M5 6 L12 18 L19 6"
          stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none"
        />
      );
    case 'recraft':
      // R inside circle.
      return (
        <>
          <circle cx="12" cy="12" r="7" fill="none" stroke={color} strokeWidth="1.6" />
          <path d="M9 8 L9 16 M9 8 L13 8 Q15 8 15 10 Q15 12 13 12 L9 12 M12 12 L15 16" stroke={color} strokeWidth="1.6" fill="none" />
        </>
      );
    case 'ideogram':
      // I letter mark.
      return (
        <path
          d="M9 6 L15 6 M12 6 L12 18 M9 18 L15 18"
          stroke={color} strokeWidth="2.2" strokeLinecap="round"
        />
      );
    case 'stability':
      // S curve.
      return (
        <path
          d="M16 8 Q12 6 9 9 Q6 12 9 14 Q12 16 15 14 Q18 12 15 9"
          stroke={color} strokeWidth="2" strokeLinecap="round" fill="none"
        />
      );
    case 'generic':
    default:
      // Sparkle / 4-point star fallback.
      return (
        <path
          d="M12 5 L13.5 10.5 L19 12 L13.5 13.5 L12 19 L10.5 13.5 L5 12 L10.5 10.5 Z"
          fill={color}
        />
      );
  }
}
