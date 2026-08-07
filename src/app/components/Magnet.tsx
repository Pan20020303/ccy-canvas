import { useState, useEffect, useRef, type ReactNode } from 'react';

/**
 * Magnet — React Bits (JS + CSS variant), typed for this codebase.
 * The inner element is pulled toward the cursor while the pointer is within
 * `padding` px of the element; higher `magnetStrength` = smaller movement.
 *
 * Perf note: pass `disabled` when the element isn't interactable (e.g. a
 * hidden hover affordance) so the global mousemove listener isn't attached.
 */
type MagnetProps = {
  children: ReactNode;
  padding?: number;
  disabled?: boolean;
  magnetStrength?: number;
  /**
   * Restrict the pull to one side so the element only reaches OUTWARD:
   * 'right' → reacts only to a cursor to its right; 'left' → only to its left.
   * Undefined = omnidirectional (original behavior). Used by the node `+`
   * bubbles so they never get sucked INTO the card when the cursor is over it.
   */
  outward?: 'left' | 'right';
  /**
   * Hard release: immediately disengage and snap home even mid-pull (unlike
   * `disabled`, which sticky-engagement deliberately ignores while active).
   * Used during a React Flow connection drag — a handle chasing the cursor
   * would sit under every mouseup and eat the drop.
   */
  release?: boolean;
  /**
   * Engage/disengage notifications. Lets the parent keep hover-gated UI (e.g.
   * the bubble's own opacity, or the `disabled` gate itself) alive while the
   * cursor is outside the parent but still within the magnet radius.
   */
  onActiveChange?: (active: boolean) => void;
  activeTransition?: string;
  inactiveTransition?: string;
  wrapperClassName?: string;
  innerClassName?: string;
};

const Magnet = ({
  children,
  padding = 100,
  disabled = false,
  magnetStrength = 2,
  outward,
  release = false,
  onActiveChange,
  activeTransition = 'transform 0.3s ease-out',
  inactiveTransition = 'transform 0.5s ease-in-out',
  wrapperClassName = '',
  innerClassName = '',
}: MagnetProps) => {
  const [isActive, setIsActive] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const magnetRef = useRef<HTMLDivElement>(null);

  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  useEffect(() => {
    onActiveChangeRef.current?.(isActive);
  }, [isActive]);

  useEffect(() => {
    // Sticky engagement: `disabled` gates when a pull may START (e.g. only
    // while the node card is hovered/selected), but once the bubble is
    // engaged we keep tracking even after the gate closes — otherwise the
    // pull dies the instant the cursor leaves the card, and the padding
    // radius outside the node is unreachable. Tracking stops (and the
    // listener detaches) when the cursor exits the padding radius.
    // `release` overrides the stickiness: snap home NOW.
    if (release || (disabled && !isActive)) {
      if (isActive) setIsActive(false);
      setPosition((p) => (p.x === 0 && p.y === 0 ? p : { x: 0, y: 0 }));
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      const el = magnetRef.current;
      if (!el) return;

      const { left, top, width, height } = el.getBoundingClientRect();
      const centerX = left + width / 2;
      const centerY = top + height / 2;

      // The element may live inside a scaled container (React Flow viewport
      // zoom). getBoundingClientRect is post-transform while offsetWidth is
      // layout-space — their ratio recovers the effective scale. The applied
      // pull is divided by it (the transform gets re-scaled by the container).
      // The engagement range shrinks with the container when zoomed OUT (so a
      // tiny node doesn't project a huge magnet field) but is capped at the
      // raw padding when zoomed IN (so it doesn't balloon across the screen).
      const scale = el.offsetWidth > 0 ? width / el.offsetWidth : 1;
      const range = padding * Math.min(scale, 1);

      const distX = Math.abs(centerX - e.clientX);
      const distY = Math.abs(centerY - e.clientY);

      // Directional gate: only engage when the cursor is on the OUTWARD side,
      // so the bubble reaches away from the node instead of being pulled inward
      // (into the card) when the cursor hovers over the node.
      const outwardOk =
        outward === 'right' ? e.clientX >= centerX
        : outward === 'left' ? e.clientX <= centerX
        : true;

      if (outwardOk && distX < width / 2 + range && distY < height / 2 + range) {
        setIsActive(true);
        // Divide by scale: the transform is applied in layout space and then
        // scaled by the container, so this yields a screen-space pull equal to
        // cursorDist/strength at any zoom level.
        const offsetX = (e.clientX - centerX) / magnetStrength / scale;
        const offsetY = (e.clientY - centerY) / magnetStrength / scale;
        setPosition({ x: offsetX, y: offsetY });
      } else {
        // Only reset when we were actually pulled — avoids a setState storm on
        // every mousemove when the cursor is nowhere near the element.
        setIsActive((prev) => {
          if (prev) setPosition({ x: 0, y: 0 });
          return false;
        });
      }
    };

    // Window blur = no more mousemove events; a still-engaged bubble would
    // otherwise freeze mid-pull indefinitely.
    const handleWindowBlur = () => {
      setIsActive(false);
      setPosition((p) => (p.x === 0 && p.y === 0 ? p : { x: 0, y: 0 }));
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('blur', handleWindowBlur);
    };
    // isActive is a dependency on purpose: the effect re-evaluates the sticky
    // guard on each engage/disengage edge (cheap — listener churn only).
  }, [padding, disabled, magnetStrength, outward, isActive, release]);

  const transitionStyle = isActive ? activeTransition : inactiveTransition;

  return (
    <div
      ref={magnetRef}
      className={wrapperClassName}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <div
        className={innerClassName}
        style={{
          transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
          transition: transitionStyle,
          willChange: 'transform',
        }}
      >
        {children}
      </div>
    </div>
  );
};

export default Magnet;
