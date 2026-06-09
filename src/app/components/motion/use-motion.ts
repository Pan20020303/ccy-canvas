import { useEffect, useRef } from "react";
import gsap from "gsap";

/**
 * Plays a one-shot enter animation when the element mounts. Use for chat
 * bubbles, cards in a stream, list items — anything that should feel like
 * it "lands" instead of popping into existence.
 *
 * @param from   GSAP-from vars (initial state)
 * @param config Optional duration/ease overrides
 */
export function useMountFadeIn<T extends HTMLElement>(
  from: gsap.TweenVars = { opacity: 0, y: 6 },
  config: { duration?: number; ease?: string; delay?: number } = {},
) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ctx = gsap.context(() => {
      gsap.from(ref.current!, {
        ...from,
        duration: config.duration ?? 0.28,
        ease: config.ease ?? "power2.out",
        delay: config.delay ?? 0,
      });
    });
    return () => ctx.revert();
  }, [config.delay, config.duration, config.ease, from]);
  return ref;
}

/**
 * Pulses an element with a subtle scale + brightness flash whenever the
 * `trigger` value changes (e.g. when a node's status flips to "done").
 * Skips the initial mount so we only react to real changes.
 */
export function usePulseOn<T extends HTMLElement>(trigger: unknown) {
  const ref = useRef<T>(null);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (!ref.current) return;
    const tl = gsap.timeline();
    tl.fromTo(
      ref.current,
      { scale: 1, filter: "brightness(1)" },
      {
        scale: 1.025,
        filter: "brightness(1.18)",
        duration: 0.18,
        ease: "power2.out",
      },
    ).to(ref.current, {
      scale: 1,
      filter: "brightness(1)",
      duration: 0.34,
      ease: "power2.inOut",
    });
    return () => { tl.kill(); };
  }, [trigger]);
  return ref;
}

/**
 * Stagger-in animation for list children. Call once after the list
 * renders/changes to play a wave of fade+slide on every direct child.
 */
export function useStaggerIn<T extends HTMLElement>(
  itemSelector: string,
  deps: ReadonlyArray<unknown> = [],
  options: { from?: gsap.TweenVars; stagger?: number; duration?: number } = {},
) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!ref.current) return;
    const items = ref.current.querySelectorAll(itemSelector);
    if (items.length === 0) return;
    const ctx = gsap.context(() => {
      gsap.from(items, {
        opacity: 0,
        y: 4,
        duration: options.duration ?? 0.2,
        ease: "power2.out",
        stagger: options.stagger ?? 0.04,
        ...options.from,
      });
    }, ref);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
