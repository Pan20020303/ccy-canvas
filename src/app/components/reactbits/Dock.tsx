import { createContext, useContext, useRef, useState, type ReactNode } from "react";

// A macOS-style dock that magnifies items by their horizontal proximity to the
// cursor — the React Bits "Dock" effect, implemented with plain state + CSS
// transforms (no framer-motion; this project animates with GSAP/CSS).
// transform-origin is the bottom center so an item's horizontal center stays
// put while it grows upward, which keeps the proximity math stable.

const DockMouseXContext = createContext<number | null>(null);

const MAX_DISTANCE = 110; // px of horizontal influence around the cursor
const MAX_SCALE = 1.4; // peak magnification directly under the cursor

const prefersReducedMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Dock({ children, className }: { children: ReactNode; className?: string }) {
  const [mouseX, setMouseX] = useState<number | null>(null);
  return (
    <DockMouseXContext.Provider value={prefersReducedMotion ? null : mouseX}>
      <div
        className={className}
        onMouseMove={(e) => setMouseX(e.clientX)}
        onMouseLeave={() => setMouseX(null)}
      >
        {children}
      </div>
    </DockMouseXContext.Provider>
  );
}

export function DockItem({ children }: { children: ReactNode }) {
  const mouseX = useContext(DockMouseXContext);
  const ref = useRef<HTMLSpanElement>(null);

  let scale = 1;
  if (mouseX != null && ref.current) {
    const rect = ref.current.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    const distance = Math.abs(mouseX - center);
    const t = Math.max(0, 1 - distance / MAX_DISTANCE);
    scale = 1 + t * (MAX_SCALE - 1);
  }

  return (
    <span
      ref={ref}
      className="inline-flex"
      style={{
        transform: `scale(${scale})`,
        transformOrigin: "bottom center",
        transition: "transform 130ms cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      {children}
    </span>
  );
}
