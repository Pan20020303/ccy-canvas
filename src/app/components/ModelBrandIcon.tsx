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
