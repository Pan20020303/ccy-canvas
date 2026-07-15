import { type RefObject, useEffect } from "react";
import { gsap } from "gsap";

type MotionOptions = {
  rootRef: RefObject<HTMLElement | null>;
  heroSelector?: string;
  cardSelector?: string;
  panelSelector?: string;
};

export function useAdminWorkbenchMotion({
  rootRef,
  heroSelector = "[data-admin-hero]",
  cardSelector = "[data-admin-card]",
  panelSelector = "[data-admin-panel]",
}: MotionOptions) {
  useEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    const mm = gsap.matchMedia();
    const ctx = gsap.context(() => {
      mm.add(
        {
          reduceMotion: "(prefers-reduced-motion: reduce)",
          noPreference: "(prefers-reduced-motion: no-preference)",
        },
        ({ conditions }) => {
          const hero = gsap.utils.toArray<HTMLElement>(heroSelector);
          const cards = gsap.utils.toArray<HTMLElement>(cardSelector);
          const panels = gsap.utils.toArray<HTMLElement>(panelSelector);

          if (conditions?.reduceMotion) {
            gsap.set([...hero, ...cards, ...panels], {
              clearProps: "all",
              autoAlpha: 1,
              x: 0,
              y: 0,
            });
            return;
          }

          gsap.from(hero, {
            autoAlpha: 0,
            y: 18,
            duration: 0.52,
            ease: "power2.out",
            stagger: 0.06,
          });

          gsap.from(cards, {
            autoAlpha: 0,
            y: 26,
            duration: 0.62,
            ease: "power3.out",
            stagger: 0.08,
            delay: 0.08,
          });

          gsap.from(panels, {
            autoAlpha: 0,
            y: 30,
            duration: 0.72,
            ease: "power3.out",
            stagger: 0.1,
            delay: 0.14,
          });
        },
      );
    }, root);

    return () => {
      ctx.revert();
      mm.revert();
    };
  }, [cardSelector, heroSelector, panelSelector, rootRef]);
}
