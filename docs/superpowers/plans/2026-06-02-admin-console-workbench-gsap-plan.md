# Admin Console Workbench GSAP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the admin area into a full-width workbench with GSAP motion, stronger shared surfaces, and a chart-rich overview page.

**Architecture:** Keep the current route structure and backend API contract intact while replacing the admin shell, introducing a reusable animation hook, and upgrading admin pages onto a unified panel system. Reuse existing `recharts` utilities for visualization and scope GSAP setup to component refs so motion remains isolated and accessible.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS 4, GSAP, Recharts, lucide-react

---

### Task 1: Install GSAP and Create Shared Admin Motion Helpers

**Files:**
- Modify: `package.json`
- Create: `src/app/components/admin/useAdminWorkbenchMotion.ts`
- Test: `npm run build`

- [ ] **Step 1: Add the GSAP dependency**

Update `package.json` dependencies to include:

```json
"gsap": "^3.12.7"
```

- [ ] **Step 2: Create the shared motion hook**

Create `src/app/components/admin/useAdminWorkbenchMotion.ts` with:

```ts
import { RefObject, useEffect } from "react";
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
            gsap.set([...hero, ...cards, ...panels], { clearProps: "all", autoAlpha: 1, y: 0, x: 0 });
            return;
          }

          gsap.from(hero, {
            autoAlpha: 0,
            y: 20,
            duration: 0.55,
            ease: "power2.out",
            stagger: 0.08,
          });

          gsap.from(cards, {
            autoAlpha: 0,
            y: 26,
            duration: 0.65,
            ease: "power3.out",
            stagger: 0.08,
            delay: 0.08,
          });

          gsap.from(panels, {
            autoAlpha: 0,
            y: 30,
            duration: 0.7,
            ease: "power3.out",
            stagger: 0.1,
            delay: 0.16,
          });
        },
      );
    }, root);

    return () => {
      ctx.revert();
      mm.revert();
    };
  }, [rootRef, heroSelector, cardSelector, panelSelector]);
}
```

- [ ] **Step 3: Run the build to catch dependency or typing issues**

Run: `npm run build`

Expected: build fails only on yet-to-be-updated admin components or passes if no other errors exist.

- [ ] **Step 4: Commit the dependency and hook**

```bash
git add package.json package-lock.json src/app/components/admin/useAdminWorkbenchMotion.ts
git commit -m "feat: add shared admin gsap motion hook"
```

### Task 2: Rebuild the Admin Shell Into a Full-Width Workbench

**Files:**
- Modify: `src/app/components/admin/AdminShell.tsx`
- Modify: `src/app/components/admin/AdminSidebar.tsx`
- Test: `npm run build`

- [ ] **Step 1: Update the shell structure**

Replace `AdminShell.tsx` with a ref-based workbench shell that removes `max-w-[1600px]` and introduces full-width layered surfaces:

```tsx
import type { ReactNode } from "react";
import { useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";

import { AdminSidebar } from "./AdminSidebar";
import { useAdminWorkbenchMotion } from "./useAdminWorkbenchMotion";

type AdminShellProps = {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
};

export function AdminShell({ title, description, action, children }: AdminShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useAdminWorkbenchMotion({ rootRef });

  return (
    <div ref={rootRef} className="min-h-screen bg-[#060606] text-neutral-100">
      <div className="relative flex min-h-screen w-full overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,106,31,0.16),transparent_28%),radial-gradient(circle_at_top_right,rgba(73,119,255,0.12),transparent_24%)]" />
        <AdminSidebar />
        <main className="relative flex min-h-screen min-w-0 flex-1 flex-col bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0))]">
          <div className="border-b border-white/[0.06] px-6 py-5 lg:px-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div data-admin-hero className="flex items-center gap-3">
                <Link
                  to="/app"
                  className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs uppercase tracking-[0.18em] text-neutral-300 transition hover:border-[#ff6a1f]/25 hover:text-white"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  返回工作区
                </Link>
              </div>
              {action ? <div data-admin-hero>{action}</div> : null}
            </div>
            <header className="mt-6 flex flex-wrap items-start justify-between gap-6">
              <div data-admin-hero>
                <p className="text-xs uppercase tracking-[0.28em] text-[#ff9b68]">管理员工作台</p>
                <h1 className="mt-3 text-3xl font-semibold text-white lg:text-4xl">{title}</h1>
                <p className="mt-3 max-w-4xl text-sm leading-6 text-neutral-400 lg:text-[15px]">{description}</p>
              </div>
            </header>
          </div>
          <div className="flex-1 px-6 py-6 lg:px-8 lg:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Upgrade the sidebar**

Update `AdminSidebar.tsx` so it feels like a fixed system rail:

```tsx
<aside className="relative z-10 flex min-h-screen w-[280px] shrink-0 flex-col border-r border-white/[0.08] bg-[linear-gradient(180deg,#121212_0%,#0d0d0d_100%)] px-5 py-6">
```

Also:

- add `data-admin-hero` to the brand block
- add `data-admin-card` to nav and trust/help sections where appropriate
- strengthen active nav states with brighter border/background
- keep current route items and brand assets unchanged

- [ ] **Step 3: Run the build**

Run: `npm run build`

Expected: shell and sidebar changes compile cleanly.

- [ ] **Step 4: Commit the shell refresh**

```bash
git add src/app/components/admin/AdminShell.tsx src/app/components/admin/AdminSidebar.tsx
git commit -m "feat: rebuild admin shell into full-width workbench"
```

### Task 3: Build the Overview Dashboard With Charts and Animated KPI Cards

**Files:**
- Modify: `src/app/components/admin/AdminOverviewPage.tsx`
- Reuse: `src/app/components/ui/chart.tsx`
- Test: `npm run build`

- [ ] **Step 1: Replace the overview page with dashboard-oriented components**

Refactor `AdminOverviewPage.tsx` to:

- keep the existing `getAdminStats()` call
- derive chart-friendly arrays from returned aggregate stats
- render KPI cards, a trend chart, a donut/pie chart, and compact insight panels

Use these imports:

```ts
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, Boxes, CreditCard, Loader2, ShieldCheck, Sparkles, Users, Zap } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, XAxis } from "recharts";
import { gsap } from "gsap";
```

Use these shared UI wrappers:

```ts
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import { useAdminWorkbenchMotion } from "./useAdminWorkbenchMotion";
```

- [ ] **Step 2: Add KPI and panel structure**

The render structure should include:

- a `grid gap-4 xl:grid-cols-4` KPI row
- a second row with one large trend chart panel and one health panel
- a third row with compact insight cards

Each KPI card and panel should expose one of:

```tsx
data-admin-card
data-admin-panel
```

- [ ] **Step 3: Animate KPI values**

Inside the overview page, add a small effect that tweens number text from zero to the live stats:

```ts
useEffect(() => {
  if (!stats || !numbersRef.current.length) {
    return;
  }

  const values = [stats.total_users, stats.total_providers, stats.generations_today, stats.credits_consumed_today];
  const tweens = numbersRef.current.map((node, index) => {
    const counter = { value: 0 };
    return gsap.to(counter, {
      value: values[index] ?? 0,
      duration: 1.1,
      ease: "power2.out",
      onUpdate: () => {
        node.textContent = Math.round(counter.value).toLocaleString();
      },
    });
  });

  return () => {
    tweens.forEach((tween) => tween.kill());
  };
}, [stats]);
```

- [ ] **Step 4: Build the page and validate types**

Run: `npm run build`

Expected: overview compiles with charts and GSAP helpers.

- [ ] **Step 5: Commit the overview dashboard**

```bash
git add src/app/components/admin/AdminOverviewPage.tsx
git commit -m "feat: turn admin overview into animated dashboard"
```

### Task 4: Apply Shared Workbench Surfaces Across Table Pages

**Files:**
- Modify: `src/app/components/admin/AdminModelCatalogPage.tsx`
- Modify: `src/app/components/admin/AdminMembersPage.tsx`
- Modify: `src/app/components/admin/AdminInvitationsPage.tsx`
- Modify: `src/app/components/admin/AdminLogsPage.tsx`
- Test: `npm run build`

- [ ] **Step 1: Wrap the primary filter and table surfaces consistently**

For each page:

- convert outer content into `space-y-5` or `space-y-6`
- wrap filters/search in `rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4`
- wrap table regions in `rounded-[28px] border border-white/[0.08] bg-[#111111]/95 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]`
- add `data-admin-card` to filter strips and `data-admin-panel` to main table surfaces

- [ ] **Step 2: Improve page-level density and action alignment**

For each page:

- keep existing data flows and handlers unchanged
- align headers/actions so the CTA remains in the shell top rail if already passed through `AdminShell`
- ensure tables stretch wide enough to benefit from the new full-screen layout

- [ ] **Step 3: Add subtle hover polish where safe**

For cards, rows, or summary surfaces that are not interactive-critical:

```tsx
className="transition duration-300 hover:-translate-y-0.5 hover:border-white/[0.14] hover:bg-white/[0.04]"
```

Do not add transform hover states to elements whose position affects dense table usability.

- [ ] **Step 4: Build after the shared page updates**

Run: `npm run build`

Expected: all admin pages compile on the shared shell without type regressions.

- [ ] **Step 5: Commit the page-surface sweep**

```bash
git add src/app/components/admin/AdminModelCatalogPage.tsx src/app/components/admin/AdminMembersPage.tsx src/app/components/admin/AdminInvitationsPage.tsx src/app/components/admin/AdminLogsPage.tsx
git commit -m "feat: unify admin table pages with workbench surfaces"
```

### Task 5: Browser Verification and Final Cleanup

**Files:**
- Revisit if needed: `src/app/components/admin/*.tsx`
- Test: `npm run build`
- Verify: local admin routes in browser

- [ ] **Step 1: Run the final build**

Run: `npm run build`

Expected: exit code 0.

- [ ] **Step 2: Visually verify the admin overview and one table page**

Open:

- `http://localhost:5173/admin/overview`
- `http://localhost:5173/admin`

Confirm:

- no left/right guttered empty canvas
- shell and sidebar fill the screen
- charts render on the overview page
- GSAP entrance motion feels present but controlled
- model page table area now reads as part of a full workbench

- [ ] **Step 3: Spot-check reduced-risk regressions**

Verify:

- back link still navigates to `/app`
- sidebar routes still work
- CTA on model page still appears and functions visually

- [ ] **Step 4: Commit polish fixes if needed**

```bash
git add src/app/components/admin
git commit -m "fix: polish admin workbench verification issues"
```

## Self-Review

### Spec Coverage

- Full-screen workbench shell: covered by Task 2
- Shared page surface system: covered by Task 4
- Overview dashboard and visualization: covered by Task 3
- GSAP medium-intensity motion: covered by Tasks 1, 2, and 3
- Verification in browser and build: covered by Task 5

### Placeholder Scan

- No TODO/TBD markers remain
- Each task names exact files and commands
- Motion hook, shell structure, and verification commands are explicit

### Type Consistency

- Shared motion hook is consistently named `useAdminWorkbenchMotion`
- Shared data markers use `data-admin-hero`, `data-admin-card`, and `data-admin-panel`
- GSAP integration stays inside React effects and refs
