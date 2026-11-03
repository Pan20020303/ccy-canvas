export const userMotionTokens = {
  enter: {
    fast: 0.28,
    base: 0.45,
    slow: 0.8,
  },
  exit: {
    fast: 0.2,
    base: 0.28,
  },
  stagger: {
    tight: 0.06,
    base: 0.08,
  },
  distance: {
    sm: 12,
    md: 18,
    lg: 26,
  },
  ease: {
    standard: "power2.out",
    emphasized: "power3.out",
    instant: "none",
  },
} as const;

export function getUserMotionPreset(reduceMotion: boolean) {
  if (reduceMotion) {
    return {
      autoAlpha: 1,
      x: 0,
      y: 0,
      scale: 1,
      duration: 0.01,
      ease: userMotionTokens.ease.instant,
    };
  }

  return {
    autoAlpha: 0,
    x: 0,
    y: userMotionTokens.distance.md,
    scale: 0.985,
    duration: userMotionTokens.enter.base,
    ease: userMotionTokens.ease.standard,
  };
}
