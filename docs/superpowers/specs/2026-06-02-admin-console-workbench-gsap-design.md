# Admin Console Workbench GSAP Redesign

## Goal

Upgrade the admin experience from a centered dark panel layout into a full-screen workbench that feels closer to a modern operations console. The redesign should:

- remove the unused left and right canvas margins
- align the admin information architecture with a dense dashboard/workbench pattern
- add GSAP-driven motion with medium intensity
- strengthen the overview page with visualized metrics, charts, and icon-led insights
- keep the current dark/orange brand direction instead of switching to a light template

## User-Confirmed Direction

- Visual direction: approach the structure and information density of the provided full-screen admin template
- Scope: update the entire admin area, not only the overview page
- Motion intensity: medium

## Current Problems

1. The admin shell constrains the page with a `max-w-[1600px]` container, leaving large empty gray/black areas on both sides.
2. The overview page only shows static stat cards and lacks visual storytelling.
3. Other admin pages inherit the same shell but do not feel like part of a unified console system.
4. There is no shared motion language for page entry, section transitions, or card emphasis.

## Proposed Solution

### 1. Full-Screen Admin Workbench Shell

Replace the centered shell with a true full-bleed application frame:

- fixed-width left sidebar
- flexible right content region that fills the full viewport width
- top content rail inside the main region for back navigation, title, summary, and page actions
- layered backgrounds and panel surfaces so the screen feels intentionally occupied instead of empty

This keeps the current dark palette while borrowing the “workbench” composition from the reference.

### 2. Unified Admin Page Surface System

All admin pages will share a stronger visual system:

- consistent section containers
- larger content width
- denser spacing rhythm
- panel headers for tables, filters, and actions
- clearer empty, loading, and status states

This allows overview, model configuration, members, invitations, and logs to feel like one product instead of separate screens inside the same route family.

### 3. Overview as a Data Dashboard

The overview page will be expanded into a dashboard with:

- primary KPI cards
- a trend visualization for activity and output
- a composition or health chart for success/error/provider state
- quick insight cards with icons and short operational takeaways

Because the backend currently exposes only aggregate stats, chart data will be derived from available stats into presentational dashboard series. The data is decorative but grounded in real values from the API response.

### 4. GSAP Motion System

Introduce a small reusable GSAP pattern for admin screens:

- shell fade/slide entrance
- staggered card and section reveal
- chart and metric reveal
- hover lift/glow for important cards
- nav and section feedback that feels responsive but not flashy

Motion must honor `prefers-reduced-motion` and degrade gracefully to static rendering.

## Approaches Considered

### Approach A: Overview-Only Upgrade

- Pros: fastest, least risky
- Cons: the rest of the admin still feels unfinished and the empty margins remain a structural problem

### Approach B: Shared Workbench Shell Plus Dashboard Upgrade

- Pros: fixes the layout root cause, improves the whole admin area, and gives the overview page a strong centerpiece
- Cons: touches several page containers and requires some visual cleanup across multiple files

### Approach C: Full Information Architecture Rewrite

- Pros: closest to a brand-new admin template
- Cons: too broad for this pass and more likely to destabilize existing behavior

### Recommendation

Use Approach B.

It solves the shell-level problem first, keeps the scope realistic, and produces a visible upgrade across the entire admin experience without changing the route structure or backend contract.

## Information Architecture

### Shared Shell

- Sidebar: brand block, primary admin nav, bottom trust/help panel
- Main top rail: back link, page eyebrow, title, description, optional CTA
- Content body: wide responsive grid or stacked panels depending on page type

### Overview Page

- Hero metrics row
- Main analytics row with trend chart and operational health chart
- Insight row with compact summary cards

### Model Configuration

- Header with CTA
- Elevated filter/search strip
- Full-width data table inside a stronger surface panel

### Members / Invitations / Logs

- Consistent page section intro
- Wide table surfaces
- More structured badges, summaries, and spacing

## Motion Design

### Entry Motion

- Sidebar enters with a short x-axis slide and fade
- Header block enters first
- KPI cards reveal with stagger
- Secondary panels reveal after KPI cards

### Hover / Focus Motion

- Cards get a slight y lift and shadow bloom
- Important panels get a subtle highlight sweep or border emphasis
- Nav items feel more tactile on hover and active state transitions

### Data Motion

- KPI values animate in
- Charts fade and rise into view
- Insight chips can reveal with a short stagger

### Accessibility

- Use `gsap.matchMedia()` with `prefers-reduced-motion: reduce`
- In reduced motion mode, render immediate states or very short fades only

## Technical Design

### Files to Update

- `src/app/components/admin/AdminShell.tsx`
- `src/app/components/admin/AdminSidebar.tsx`
- `src/app/components/admin/AdminOverviewPage.tsx`
- `src/app/components/admin/AdminModelCatalogPage.tsx`
- `src/app/components/admin/AdminMembersPage.tsx`
- `src/app/components/admin/AdminInvitationsPage.tsx`
- `src/app/components/admin/AdminLogsPage.tsx`
- `package.json`

### New Supporting Code

- a small admin animation hook or helper inside the admin component area
- optional shared presentational helpers for metric cards or panel surfaces if repetition becomes high

### Libraries

- add `gsap` runtime dependency
- reuse existing `recharts`

## Testing and Verification

1. Build the frontend successfully with `npm run build`
2. Verify routes render without type errors
3. Open the admin overview and at least one table page in the browser
4. Confirm:
   - no gray side gutters remain
   - overview includes chart-based visualization
   - admin pages share the new workbench frame
   - motion is present but not excessive
   - reduced-motion logic does not break rendering

## Risks and Mitigations

### Risk: GSAP introduces hydration or React lifecycle issues

Mitigation:

- keep GSAP setup inside `useEffect`
- scope selectors via refs
- clean up animations on unmount

### Risk: Derived chart data could feel fake

Mitigation:

- use charts as operational summaries, not fabricated precise history
- keep labels generic and grounded in current totals and ratios

### Risk: Full-width layout could become visually sparse on large monitors

Mitigation:

- use layered panels, section groupings, and wider but intentional content rails
- allow certain data surfaces to span multiple columns

## Out of Scope

- changing backend stats endpoints
- rewriting route structure
- replacing the brand palette with a light theme
- building advanced drill-down analytics interactions
