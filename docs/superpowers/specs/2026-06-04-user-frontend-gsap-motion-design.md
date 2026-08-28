# User Frontend GSAP Motion Design

## Goal

Add GSAP-driven motion and interaction polish to the user-facing frontend so the product feels more premium and responsive without disrupting core creation workflows.

This pass should:

- add medium-intensity motion to both auth and workspace surfaces
- improve perceived quality on first load and common UI interactions
- keep the motion practical rather than decorative
- respect reduced-motion preferences
- avoid touching high-risk canvas drag/zoom behavior in this round

## User-Confirmed Direction

- Scope: both the login/register flow and the `/app` workspace
- Motion intensity: medium
- Priority: page enter/transition and hover/click feedback first
- Product intent: auth surfaces should feel branded; workspace surfaces should feel efficient and tactile

## Current Problems

1. The login and register experience has a strong visual base, but the page currently appears statically, so the brand presentation feels flatter than the design language suggests.
2. Buttons, inputs, and social actions on auth pages rely mostly on CSS hover states and do not communicate enough depth or responsiveness.
3. The workspace shell includes multiple surfaces that appear abruptly, including the top navbar, left toolbar panels, user menu, and modals.
4. There is no shared motion system for user-facing UI, so interactions risk becoming inconsistent if animation is added ad hoc.
5. The core canvas already carries high interaction density, so motion changes need tighter guardrails than ordinary marketing UI.

## Proposed Solution

### 1. Shared Frontend Motion Foundation

Introduce a lightweight reusable GSAP foundation for user-facing components. This layer will:

- centralize shared easing, duration, and stagger values
- wrap animation setup with `gsap.context()` so component cleanup is reliable
- standardize `prefers-reduced-motion` behavior through `gsap.matchMedia()`
- encourage scoped, component-level motion instead of global selector-heavy animation

This keeps the motion language consistent across auth and workspace surfaces while limiting implementation risk.

### 2. Auth Surface Motion

Apply motion to the login and register experience through the shared `AuthLayout`:

- left visual panel enters with a subtle scale and fade
- logo, title, subtitle, and form container reveal in layered sequence
- fields and action groups inherit the page rhythm rather than animating independently in a noisy way
- primary CTA and social buttons get tactile hover and press feedback
- focused input fields gain a stronger sense of activation through animated emphasis rather than only border changes

The result should feel polished and premium, not like a marketing splash screen.

### 3. Workspace Shell Motion

Apply motion to the non-canvas shell around `/app`:

- navbar enters with a short fade and downward-to-rest motion
- left toolbar enters as a grouped shell with fast stagger on primary controls
- toolbar side panels open with directional slide/fade based on their anchor position
- avatar menu opens and closes more smoothly
- modal overlays and modal panels animate independently so open/close states feel intentional

This improves the perceived quality of the workspace without interfering with creation speed.

### 4. Practical Micro-Interactions

Add subtle interaction feedback to frequently used controls:

- buttons lift slightly on hover and compress on press
- panel rows and project cards get small positional and brightness feedback
- menu items and action chips become more tactile
- emphasis stays strongest on primary actions and active states

Micro-interactions should be brief and consistent so they help orientation rather than stealing focus.

## Approaches Considered

### Approach A: Auth-Only Motion Pass

- Pros: fast, low-risk, immediate visual payoff
- Cons: leaves the everyday workspace feeling comparatively static

### Approach B: Shared Motion Foundation with Auth + Workspace Shell Coverage

- Pros: creates a coherent motion language, improves both first impression and daily use, and keeps scope away from the riskiest canvas internals
- Cons: touches more components and requires deliberate organization to avoid scattered GSAP code

### Approach C: Full Workspace Motion Including Canvas and Node Behavior

- Pros: highest possible wow factor
- Cons: much higher risk to performance, interaction correctness, and editing ergonomics

### Recommendation

Use Approach B.

It provides the best balance between visible product improvement and implementation safety. It also establishes a reusable motion system that later work can extend into more advanced workspace states if needed.

## Experience Design

### Auth Experience

- Entry motion should feel layered and cinematic but brief
- The left-side artwork acts as atmosphere, not the main event
- The form column remains the focal point
- CTA feedback should make submitting feel deliberate and responsive

### Workspace Experience

- Shell motion should feel fast and operational rather than theatrical
- Navigation, menus, panels, and modals should no longer hard-cut into place
- Hover states should communicate interactivity and priority more clearly
- The user should feel more control, not more distraction

### Motion Language

- Fast to medium durations
- Small travel distances
- Mostly `opacity`, `y`, and `x` transitions
- Slight scale use only where it adds polish
- Orange and cyan highlights should remain accents, not animated everywhere

## Motion Design Details

### Entry Motion

- Auth page: roughly `0.45s` to `0.8s` layered reveal with small upward movement and subtle image scale
- Workspace shell: roughly `0.28s` to `0.55s` reveal windows
- Stagger should be visible but restrained

### Hover and Press Motion

- Hover lift: about `2px` to `4px`
- Press feedback: short snap inward or reset toward baseline
- Brightness and shadow changes should support the transform, not replace it

### Panel and Menu Motion

- Use `autoAlpha` plus small `x` or `y` travel
- Keep open/close timing symmetric or slightly faster on close
- Avoid exaggerated bounce on operational surfaces

### Accessibility

- `prefers-reduced-motion: reduce` should disable travel-heavy animation
- Reduced-motion mode may keep instant states or very short fades only
- Animation must never block access to controls or state changes

## Technical Design

### Files Expected to Change

- `src/app/components/auth-layout.tsx`
- `src/app/components/LoginPage.tsx`
- `src/app/components/RegisterPage.tsx`
- `src/app/components/Navbar.tsx`
- `src/app/components/Toolbar.tsx`
- `src/app/components/Modals.tsx`
- `package.json`

### New Supporting Code

- a shared user-frontend motion hook or helper under `src/app/components` or a nearby motion-focused location
- optional small presentational wrappers or data attributes to provide stable animation targets

### Motion Architecture

- use ref-scoped GSAP setup per component
- expose a small set of shared motion tokens for duration/ease/stagger
- prefer data attributes or local selectors over brittle DOM traversal
- keep animation ownership close to the component that renders the UI

### Library Use

- use `gsap` as the runtime animation layer
- continue using CSS transitions for trivial cases where GSAP adds no value
- reserve GSAP for sequenced entry, coordinated hover systems, and layered open/close transitions

## Testing and Verification

1. Install or confirm the `gsap` dependency and ensure the frontend builds successfully with `npm run build`.
2. Manually verify `/login`, `/register`, and `/app`.
3. Confirm that auth pages animate in cleanly and remain immediately usable.
4. Confirm that navbar, toolbar panel toggles, avatar menu, and modal open/close states feel smoother and do not jump.
5. Confirm that hover and press feedback is present on the main interactive surfaces without feeling noisy.
6. Confirm that reduced-motion preferences disable travel-heavy motion and do not break rendering.

## Risks and Mitigations

### Risk: Motion code becomes scattered and inconsistent

Mitigation:

- create a shared motion helper/hook first
- keep durations and eases centralized
- scope animations by component

### Risk: Workspace motion interferes with high-frequency usage

Mitigation:

- limit this pass to shell UI and not core canvas gestures
- keep distances short and durations tight
- prefer reversible transforms over layout-affecting animation

### Risk: Menus and modals animate incorrectly during React state changes

Mitigation:

- use ref-based GSAP setup with proper cleanup
- animate mounted surfaces only
- keep open/close patterns simple and deterministic

### Risk: Reduced-motion users still receive distracting transitions

Mitigation:

- standardize `prefers-reduced-motion` handling in the shared motion layer
- reduce to immediate state or minimal fades when motion reduction is requested

## Out of Scope

- changing React Flow or core canvas drag/zoom mechanics
- animating node internals, generation progress, or complex canvas state choreography
- redesigning auth page layout or workspace information architecture
- adding decorative looping background animation that does not support usability
