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
  activeTransition = 'transform 0.3s ease-out',
  inactiveTransition = 'transform 0.5s ease-in-out',
  wrapperClassName = '',
  innerClassName = '',
}: MagnetProps) => {
  const [isActive, setIsActive] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const magnetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (disabled) {
      setIsActive(false);
      setPosition({ x: 0, y: 0 });
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!magnetRef.current) return;

      const { left, top, width, height } = magnetRef.current.getBoundingClientRect();
      const centerX = left + width / 2;
      const centerY = top + height / 2;

      const distX = Math.abs(centerX - e.clientX);
      const distY = Math.abs(centerY - e.clientY);

      // Directional gate: only engage when the cursor is on the OUTWARD side,
      // so the bubble reaches away from the node instead of being pulled inward
      // (into the card) when the cursor hovers over the node.
      const outwardOk =
        outward === 'right' ? e.clientX >= centerX
        : outward === 'left' ? e.clientX <= centerX
        : true;

      if (outwardOk && distX < width / 2 + padding && distY < height / 2 + padding) {
        setIsActive(true);
        const offsetX = (e.clientX - centerX) / magnetStrength;
        const offsetY = (e.clientY - centerY) / magnetStrength;
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

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [padding, disabled, magnetStrength, outward]);

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
