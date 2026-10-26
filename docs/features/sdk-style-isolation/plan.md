---
status: Draft
created: 2026-10-22
updated: 2026-10-26
summary: Draft ownership and compatibility design for isolating SDK chrome styles from app content while preserving authentication and retained UI contracts.
components: [packages/app-sdk, apps/harness, apps/shell, apps/marketplace, apps/documents, apps/demo-app, apps/telemetry-ui]
---

# SDK Style Isolation

## Goal And Owner Decision

On 2026-10-22 the owner requested a separate draft for full SDK style isolation. The architecture
is undecided. This records design and contract work only; it authorizes no implementation,
package migration, lifecycle change or production experiment. Keep this plan Draft until the owner
reviews the alternatives, boundaries and migration proposal. Implementation requires an explicit
owner-approved scope and a Ready plan; the current request is not that approval.

Reduce unintended style coupling between SDK-owned chrome and the application document. Define
which effects are intentional and testable rather than promising that an SDK can never affect
an application. Layout participation and authentication/access blocking are explicit exceptions:
a selected layout may allocate space, and a required access state may cover or make content inert
under its existing contract.

There is no feature.md for this proposed architecture because it is not implemented. Current
behavior remains documented by [SDK UI Composition](../sdk-ui-composition/feature.md) and
[SDK Panel System](../sdk-panel-system/feature.md). Narrow corrections to existing font, color or
focus selectors do not establish complete style isolation or select an architecture.

## Relationship To Existing Work

Reuse composition policy, navigation, identity, authorization, frame transport, placement and
retained presentation contracts. This plan does not redesign those APIs or grant new authority.
The [Design System plan](../design-system/plan.md) D31 continues to own SDK access/install visual
adoption and its acceptance. D19 continues to own app control adoption, and D39 owns app-accent
metadata decisions. This plan owns the style boundary and its compatibility/migration design,
without duplicating those deliverables or marking their acceptance complete.

## Design Axes To Compare

These are alternatives and independent axes for review, not a selected solution.

| Axis | Questions and evidence required |
| --- | --- |
| Headless authentication/access with optional layout | Can authentication and access integration operate without installing app-document presentation styles? How can an app explicitly opt into SDK navigation/tool layout while existing defaults and public entrypoints remain compatible? |
| Scoped CSS for SDK chrome in light DOM | Can selectors, resets, inherited properties and tokens be confined to SDK-owned controls? How are stylesheet order, CSS layers, specificity, app resets and third-party frameworks handled in both directions? |
| Shadow DOM for SDK-owned chrome | What boundaries improve, and what changes for styling, portals, events, focus and browser support? Keeping app content in light DOM is a candidate working assumption for compatibility, not an owner-approved architecture constraint; other boundaries can be compared on paper for owner review. |

A headless access layer could coexist with either chrome styling approach. Document tradeoffs and
unsupported cases before recommending an architecture; do not assume Shadow DOM removes inherited
values or that selector scoping eliminates every possible collision.

## Proposed Ownership Boundary

Develop an explicit contract against the current behavior:

- The app owns document typography, foreground/background, control styling, interaction states and
  its CSS cascade. App content must not inherit SDK chrome defaults through a shared ancestor.
- The SDK owns styles on its own navigation, tool rail/chooser, access/recovery and installation
  controls. Scope any reset and focus treatment to that owned subtree or explicit control classes.
- Define theme transport separately from ownership: supported theme input, CSS custom properties,
  font inheritance, color-scheme, live theme changes and defaults. Specify which values cross each
  boundary, in which direction, and how absent or invalid values behave. Keep existing theme
  negotiation unchanged until a separately approved contract describes any change.
- Identify portal destinations and ownership for dialogs, popovers, tooltips, menus and native
  dialog/top-layer content. Specify event propagation/retargeting, accessible naming, focus
  restoration/traps, Escape handling and inert behavior across any chosen boundary.
- Preserve SSR, bootstrap order, hydration, client-only hosts and CSP compatibility. Define where
  styles are mounted, updated and disposed without a flash that exposes protected content.
- Preserve retained iframe and presentation identity, drafts, scroll, focus, navigation policy,
  readiness, accessibility and recovery across layout changes. Style migration must not remount
  retained app views or weaken authentication, permissions or frame-origin checks.
- Record intended layout effects, including sizing, overflow, minimum widths and responsive tool
  placement, and intended access-blocking effects. These remain observable contract behavior,
  not evidence that isolation failed.

## Deliverables

- [ ] D1. Inventory current style injection, selectors, inherited values, theme variables, portal roots and layout/access effects across SDK renderers and representative app consumers. Classify ownership, accidental leaks and required exceptions with reproducible examples.
- [ ] D2. Compare headless access plus optional layout, scoped chrome CSS and SDK-chrome Shadow DOM on the same compatibility matrix. Record tradeoffs, unsupported cases and a recommendation on paper, preserving default compatibility and making no production DOM relocation or default change during design work. Alternative boundaries remain open for owner review; this draft authorizes no prototypes.
- [ ] D3. Draft the explicit style/theme/portal ownership contract, including inheritance, CSS custom properties, defaults, accessibility, SSR/hydration, lifecycle disposal and preserved public API/authentication/composition behavior.
- [ ] D4. Define acceptance fixtures and pass/fail criteria for both directions of style interference, supported browsers, consumer frameworks, theme changes, portals/focus/events, retained iframes and protected access states. Distinguish isolated design evidence from production or real-provider acceptance.
- [ ] D5. Propose a migration and compatibility plan with SDK version impact, default/opt-in behavior, legacy adapters, deprecation policy if needed, consumer ordering, rollback and required release verification. Keep D31 visual adoption and existing UI-composition contracts in their owning plans.
- [ ] D6. Obtain owner review of the architecture, exceptions, contract, acceptance matrix and migration scope. Record decisions and explicitly scoped implementation deliverables before any transition to Ready; do not treat completion of this design draft as implementation approval.

## Open Questions For Owner Review

- Which integration should be the default for new apps: headless access, the existing composed
  layout or an explicit selection? What compatibility guarantee is required for existing apps?
- Must the existing app DOM remain unchanged and in light DOM by default? Could an explicitly
  opt-in exception be acceptable? Any exception or prototype requires owner approval before work.
- Which SDK chrome surfaces belong in a proposed shadow root, and which portal/top-layer surfaces
  need an external host? Is scoped light-DOM CSS sufficient for the supported consumers?
- Which fonts, theme variables, color-scheme and inheritance are intentional inputs to SDK chrome,
  and which are entirely app-owned? How are custom app themes and missing tokens handled?
- Which supported browsers and SSR frameworks define the acceptance baseline, and what fallback
  is acceptable where a selected boundary or portal mechanism is unsupported?
- What package version/migration policy is acceptable if public defaults or adapter configuration
  must change? Which app moves first, and what evidence is required before widening adoption?

## Verification Design

The draft requests no builds, runtime changes or implementation tests. D4 defines the verification
work before implementation is approved. Its matrix must cover standalone and Core-managed Shell
embedding, SDK local tools and hosted tools, light/dark/custom themes, CSS layers and aggressive
app resets, keyboard/touch/assistive focus, dialog portals, SSR/hydration, repeated mount/disposal,
retained iframe transitions and normal setup/login/access recovery. Verify both that SDK styles do
not unintentionally restyle app content and that app styles do not break required SDK controls.

Keep layout sizing and access-blocking assertions distinct from accidental cascade interference.
Document unsupported cases and expected effects precisely. Do not claim zero impact for every
possible stylesheet, framework or browser, and do not claim full isolation from a narrow selector
fix or one app screenshot.
