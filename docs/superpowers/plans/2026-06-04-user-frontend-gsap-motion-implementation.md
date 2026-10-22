# User Frontend GSAP Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared GSAP motion system to the user-facing frontend and apply it to auth screens plus the non-canvas `/app` shell without affecting core canvas gestures.

**Architecture:** Introduce a small motion utility layer that centralizes durations, easing, and reduced-motion handling, then attach scoped GSAP hooks to `AuthLayout`, `Navbar`, `Toolbar`, and `Modals`. Keep animation ownership close to each component, use data attributes as stable targets, and leave React Flow / canvas internals untouched.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Tailwind CSS 4, GSAP, lucide-react

---

### Task 1: Create Shared User Motion Utilities

**Files:**
- Create: `src/app/components/motion/user-motion.ts`
- Create: `src/app/components/motion/user-motion.test.ts`
- Test: `src/app/components/motion/user-motion.test.ts`

- [ ] **Step 1: Write the failing test for motion tokens and reduced-motion presets**

Create `src/app/components/motion/user-motion.test.ts` with:

```ts
import { describe, expect, it } from "vitest";

import { getUserMotionPreset, userMotionTokens } from "./user-motion";

describe("user motion tokens", () => {
  it("exposes the shared timing and easing values used by frontend motion", () => {
    expect(userMotionTokens.enter.fast).toBe(0.28);
    expect(userMotionTokens.enter.base).toBe(0.45);
    expect(userMotionTokens.enter.slow).toBe(0.8);
    expect(userMotionTokens.stagger.tight).toBe(0.06);
    expect(userMotionTokens.ease.emphasized).toBe("power3.out");
  });

  it("returns travel-based motion values when reduced motion is off", () => {
    expect(getUserMotionPreset(false)).toEqual({
      autoAlpha: 0,
      x: 0,
      y: 18,
      scale: 0.985,
      duration: 0.45,
      ease: "power2.out",
    });
  });

  it("collapses travel-heavy animation when reduced motion is on", () => {
    expect(getUserMotionPreset(true)).toEqual({
      autoAlpha: 1,
      x: 0,
      y: 0,
      scale: 1,
      duration: 0.01,
      ease: "none",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/components/motion/user-motion.test.ts`

Expected: FAIL with a module resolution error for `./user-motion`.

- [ ] **Step 3: Add the shared motion utility module**

Create `src/app/components/motion/user-motion.ts` with:

```ts
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
```

- [ ] **Step 4: Re-run the test to verify it passes**

Run: `npx vitest run src/app/components/motion/user-motion.test.ts`

Expected: PASS with `3 passed`.

- [ ] **Step 5: Commit the motion utility layer**

```bash
git add src/app/components/motion/user-motion.ts src/app/components/motion/user-motion.test.ts
git commit -m "feat: add shared user motion utilities"
```

### Task 2: Add GSAP Entry Motion to the Shared Auth Layout

**Files:**
- Modify: `src/app/components/auth-layout.tsx`
- Test: `npm run build`

- [ ] **Step 1: Add stable refs and animation targets to `AuthLayout`**

Update `src/app/components/auth-layout.tsx` imports and markup so the layout owns its own animation scope:

```tsx
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { gsap } from "gsap";

import { getUserMotionPreset, userMotionTokens } from "./motion/user-motion";
import logoUrl from "../../imports/logo-login.png";
import loginVisualUrl from "../../imports/login-visual-left.png";
```

Add refs:

```tsx
const rootRef = useRef<HTMLDivElement>(null);
const visualRef = useRef<HTMLDivElement>(null);
const formRef = useRef<HTMLDivElement>(null);
```

Attach data attributes in the JSX:

```tsx
<div ref={rootRef} className="min-h-screen bg-[#07080c] text-white xl:grid xl:grid-cols-2">
  <div ref={visualRef} data-auth-visual className="relative hidden overflow-hidden xl:block">
```

```tsx
<div ref={formRef} className="relative z-10 w-full max-w-[438px]" data-auth-shell>
  <div className="mb-10 flex flex-col items-center text-center">
    <img data-auth-item="logo" src={logoUrl} alt={title} className="h-[88px] w-[88px] object-contain" />
    <h1 data-auth-item="title" className="mt-8 text-[68px] font-semibold leading-none tracking-[0.06em] text-white">
```

Wrap children with a stable content node:

```tsx
<div data-auth-item="form">{children}</div>
```

- [ ] **Step 2: Add the auth layout GSAP effect**

Inside `AuthLayout`, add:

```tsx
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
        const reduceMotion = Boolean(conditions?.reduceMotion);
        const items = gsap.utils.toArray<HTMLElement>("[data-auth-item]");
        const visual = visualRef.current;
        const shell = formRef.current;

        if (reduceMotion) {
          gsap.set([visual, shell, ...items], { clearProps: "all", autoAlpha: 1, x: 0, y: 0, scale: 1 });
          return;
        }

        const basePreset = getUserMotionPreset(false);

        gsap.set(shell, { autoAlpha: 1 });

        if (visual) {
          gsap.from(visual, {
            autoAlpha: 0,
            scale: 1.035,
            duration: userMotionTokens.enter.slow,
            ease: userMotionTokens.ease.emphasized,
          });
        }

        gsap.from(items, {
          ...basePreset,
          duration: userMotionTokens.enter.base,
          stagger: userMotionTokens.stagger.base,
          ease: userMotionTokens.ease.emphasized,
        });
      },
    );
  }, root);

  return () => {
    ctx.revert();
    mm.revert();
  };
}, []);
```

- [ ] **Step 3: Run the build**

Run: `npm run build`

Expected: PASS with the auth layout compiling cleanly.

- [ ] **Step 4: Commit the shared auth motion**

```bash
git add src/app/components/auth-layout.tsx
git commit -m "feat: animate auth layout entry"
```

### Task 3: Add Tactile Auth Form Feedback

**Files:**
- Modify: `src/app/components/LoginPage.tsx`
- Modify: `src/app/components/RegisterPage.tsx`
- Test: `npm run build`

- [ ] **Step 1: Mark the primary auth controls as stable animation targets**

In `src/app/components/LoginPage.tsx`, add attributes to the main CTA and social buttons:

```tsx
<button
  type="submit"
  data-auth-cta
  disabled={submitting}
  className="group relative mt-7 flex h-[74px] w-full items-center justify-center overflow-hidden rounded-[16px] bg-[linear-gradient(90deg,#ff5b16_0%,#ff6a1f_55%,#ff4d08_100%)] text-[18px] font-semibold tracking-[0.08em] text-white shadow-[0_18px_48px_rgba(255,92,31,0.28)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70"
>
```

```tsx
<div className="mt-7 grid grid-cols-3 gap-3 sm:gap-4" data-auth-socials>
```

In `SocialButton`, add:

```tsx
<button
  type="button"
  data-auth-social
  className="flex h-[86px] items-center justify-center gap-3 rounded-[14px] border border-white/14 bg-[linear-gradient(180deg,rgba(17,20,28,0.92),rgba(11,14,20,0.92))] px-4 text-[17px] text-white/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition hover:border-white/24 hover:bg-white/[0.04]"
>
```

In `src/app/components/RegisterPage.tsx`, add `data-auth-cta` to the submit button and `data-auth-note` to the invite-code info card:

```tsx
<div data-auth-note className="mt-6 rounded-[16px] border border-white/10 bg-white/[0.03] p-4 text-[14px] text-white/48">
```

- [ ] **Step 2: Add scoped hover and press GSAP handlers to the auth pages**

In both auth pages, add a shared local effect pattern like:

```tsx
const rootRef = useRef<HTMLFormElement>(null);

useEffect(() => {
  const root = rootRef.current;

  if (!root) {
    return;
  }

  const mm = gsap.matchMedia();
  const cleanup: Array<() => void> = [];
  const ctx = gsap.context(() => {
    mm.add(
      {
        reduceMotion: "(prefers-reduced-motion: reduce)",
        noPreference: "(prefers-reduced-motion: no-preference)",
      },
      ({ conditions }) => {
        if (conditions?.reduceMotion) {
          return;
        }

        const bindLift = (selector: string, y: number) => {
          root.querySelectorAll<HTMLElement>(selector).forEach((node) => {
            const enter = () => gsap.to(node, { y: -y, duration: 0.22, ease: "power2.out" });
            const leave = () => gsap.to(node, { y: 0, duration: 0.18, ease: "power2.out" });
            const down = () => gsap.to(node, { y: -1, scale: 0.992, duration: 0.12, ease: "power2.out" });
            const up = () => gsap.to(node, { y: -y, scale: 1, duration: 0.16, ease: "power2.out" });

            node.addEventListener("pointerenter", enter);
            node.addEventListener("pointerleave", leave);
            node.addEventListener("pointerdown", down);
            node.addEventListener("pointerup", up);

            cleanup.push(() => {
              node.removeEventListener("pointerenter", enter);
              node.removeEventListener("pointerleave", leave);
              node.removeEventListener("pointerdown", down);
              node.removeEventListener("pointerup", up);
            });
          });
        };

        bindLift("[data-auth-cta]", 3);
        bindLift("[data-auth-social]", 2);
      },
    );
  }, root);

  return () => {
    cleanup.forEach((fn) => fn());
    ctx.revert();
    mm.revert();
  };
}, []);
```

Attach the ref to the forms:

```tsx
<form ref={rootRef} onSubmit={submit}>
```

and:

```tsx
<form ref={rootRef} onSubmit={onSubmit}>
```

- [ ] **Step 3: Run the build**

Run: `npm run build`

Expected: PASS with auth pages compiling after the new refs and GSAP effects.

- [ ] **Step 4: Commit the auth interaction feedback**

```bash
git add src/app/components/LoginPage.tsx src/app/components/RegisterPage.tsx
git commit -m "feat: add auth interaction motion feedback"
```

### Task 4: Add Workspace Shell Motion to Navbar, Toolbar, and Menus

**Files:**
- Modify: `src/app/components/Navbar.tsx`
- Modify: `src/app/components/Toolbar.tsx`
- Test: `npm run build`

- [ ] **Step 1: Add a reusable shell entry effect to `Navbar`**

Update `src/app/components/Navbar.tsx` imports:

```tsx
import { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
```

Add refs:

```tsx
const rootRef = useRef<HTMLDivElement>(null);
const menuRef = useRef<HTMLDivElement>(null);
```

Attach them:

```tsx
<div ref={rootRef} className="absolute left-0 right-0 top-0 z-50 flex h-14 items-center justify-between border-b border-white/10 bg-black/40 px-6 backdrop-blur-md">
```

```tsx
<div ref={menuRef} className="absolute right-0 top-full z-50 mt-2 w-56 rounded-xl border border-white/10 bg-[#15181d]/95 py-1.5 shadow-2xl backdrop-blur-xl">
```

Then add:

```tsx
useEffect(() => {
  const root = rootRef.current;

  if (!root) {
    return;
  }

  const mm = gsap.matchMedia();
  const ctx = gsap.context(() => {
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.from(root, {
        autoAlpha: 0,
        y: -12,
        duration: 0.34,
        ease: "power2.out",
      });
    });
  }, root);

  return () => {
    ctx.revert();
    mm.revert();
  };
}, []);
```

- [ ] **Step 2: Animate the avatar menu on open and close**

In `Navbar`, add a second effect:

```tsx
useEffect(() => {
  if (!menuOpen || !menuRef.current) {
    return;
  }

  const menu = menuRef.current;
  gsap.fromTo(
    menu,
    { autoAlpha: 0, y: -8, scale: 0.98 },
    { autoAlpha: 1, y: 0, scale: 1, duration: 0.22, ease: "power2.out" },
  );
}, [menuOpen]);
```

Also add a lightweight hover lift to menu trigger and top-level navbar buttons through CSS class adjustments only:

```tsx
className="flex items-center transition-transform duration-200 hover:-translate-y-0.5"
```

- [ ] **Step 3: Add grouped entry and panel-open motion to `Toolbar`**

Update `src/app/components/Toolbar.tsx` imports:

```tsx
import { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
```

Add refs:

```tsx
const panelRef = useRef<HTMLDivElement>(null);
```

Mark the shell and the panel:

```tsx
<div ref={rootRef} className="absolute left-6 top-1/2 z-40 flex -translate-y-1/2 items-start gap-3">
```

```tsx
<div ref={panelRef} className="max-h-[70vh] w-[340px] overflow-y-auto rounded-2xl border border-white/10 bg-[#15181d]/95 p-3 shadow-2xl backdrop-blur-xl">
```

Add a mount effect:

```tsx
useEffect(() => {
  const root = rootRef.current;

  if (!root) {
    return;
  }

  const mm = gsap.matchMedia();
  const ctx = gsap.context(() => {
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.from(root.children, {
        autoAlpha: 0,
        x: -14,
        duration: 0.36,
        ease: "power2.out",
        stagger: 0.06,
      });
    });
  }, root);

  return () => {
    ctx.revert();
    mm.revert();
  };
}, []);
```

Add a panel-open effect:

```tsx
useEffect(() => {
  if (!open || !panelRef.current) {
    return;
  }

  gsap.fromTo(
    panelRef.current,
    { autoAlpha: 0, x: -12 },
    { autoAlpha: 1, x: 0, duration: 0.24, ease: "power2.out" },
  );
}, [open]);
```

- [ ] **Step 4: Run the build**

Run: `npm run build`

Expected: PASS with navbar and toolbar motion compiling cleanly.

- [ ] **Step 5: Commit the workspace shell motion**

```bash
git add src/app/components/Navbar.tsx src/app/components/Toolbar.tsx
git commit -m "feat: animate workspace shell controls"
```

### Task 5: Add Modal Open/Close Motion and Final Verification

**Files:**
- Modify: `src/app/components/Modals.tsx`
- Test: `npm run build`
- Verify: local browser review of `/login`, `/register`, and `/app`

- [ ] **Step 1: Refactor `ModalOverlay` to animate mounted content**

Update `src/app/components/Modals.tsx` imports:

```tsx
import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { X, BarChart3, User as UserIcon, History } from "lucide-react";
```

Inside `ModalOverlay`, add refs:

```tsx
const overlayRef = useRef<HTMLDivElement>(null);
const panelRef = useRef<HTMLDivElement>(null);
```

Attach them:

```tsx
<div ref={overlayRef} className="fixed inset-0 z-[100] flex items-center justify-center">
  <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
  <div ref={panelRef} className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#0c0e11] shadow-2xl">
```

- [ ] **Step 2: Add the modal entry effect**

Inside `ModalOverlay`, add:

```tsx
useEffect(() => {
  if (!isOpen || !overlayRef.current || !panelRef.current) {
    return;
  }

  const mm = gsap.matchMedia();
  let ctx: gsap.Context | null = null;

  mm.add(
    {
      reduceMotion: "(prefers-reduced-motion: reduce)",
      noPreference: "(prefers-reduced-motion: no-preference)",
    },
    ({ conditions }) => {
      if (conditions?.reduceMotion) {
        gsap.set([overlayRef.current, panelRef.current], { clearProps: "all", autoAlpha: 1, y: 0, scale: 1 });
        return;
      }

      ctx = gsap.context(() => {
        gsap.fromTo(
          overlayRef.current,
          { autoAlpha: 0 },
          { autoAlpha: 1, duration: 0.18, ease: "power2.out" },
        );

        gsap.fromTo(
          panelRef.current,
          { autoAlpha: 0, y: 18, scale: 0.985 },
          { autoAlpha: 1, y: 0, scale: 1, duration: 0.26, ease: "power3.out" },
        );
      });
    },
  );

  return () => {
    ctx?.revert();
    mm.revert();
  };
}, [isOpen]);
```

- [ ] **Step 3: Run the full automated verification**

Run: `npm run test`

Expected: PASS with all existing tests plus `src/app/components/motion/user-motion.test.ts`.

Run: `npm run build`

Expected: PASS with the full frontend compiling.

- [ ] **Step 4: Run manual browser verification**

Open the local app and verify:

```text
1. /login: layered page entry, CTA hover/press, social button lift
2. /register: same auth rhythm plus animated invite note presence
3. /app: navbar enters cleanly, toolbar panel opens with slide/fade, avatar menu feels smoother
4. Profile and dashboard modals: overlay and panel open smoothly without hard cuts
5. Canvas drag/zoom and node interactions remain unchanged
6. Reduced-motion mode removes travel-heavy animation
```

- [ ] **Step 5: Commit the modal motion and verification pass**

```bash
git add src/app/components/Modals.tsx src/app/components/motion/user-motion.ts src/app/components/motion/user-motion.test.ts src/app/components/auth-layout.tsx src/app/components/LoginPage.tsx src/app/components/RegisterPage.tsx src/app/components/Navbar.tsx src/app/components/Toolbar.tsx
git commit -m "feat: add user frontend gsap motion system"
```
