# Shell Dev Turbopack Verification

Date: 2026-10-13. Baseline: `f146d0ddd810eeaaa1d9cc922bf6c000a6d1d3e2`, with the
Shell 0.101.10 working-copy change selecting `next dev --turbopack`. Production remains
`next build --webpack`. This report records this verification run only.

## Environment And Method

- macOS ARM64, Node 24.18.0, Next.js 16.3.8, workspace SDK 0.27.24.
- An isolated source/dependency copy and Core data root under
  `/private/tmp/hosty-shell-turbo-qa`; Core 0.131.0 built from the baseline into a separate
  artifacts directory. Core installs and starts Shell using its dev runtime.
- Normal first-administrator setup and password login; no seeded or fabricated sessions.
- Both bundlers use the same application sources, dependencies, Core, browser session and
  service port. The candidate also updates the displayed Shell version from 0.101.9 to 0.101.10.
  Each starts with a separate empty `.next` directory. The root page and authentication are
  allowed to finish before measuring the three previously unopened route entries.
- Playwright clicks Settings > General, Apps, then Dashboard, in that order, for six rounds.
  Elapsed browser time includes the click, the expected pathname and main heading becoming
  available, and two animation frames. Round zero measures first visits; rounds one through
  five measure repeated transitions. No production build or test suite runs during the timings.
- The stopped Marketplace remains listed as a fixture app. No embedded app navigation is timed.

## Results

All times are milliseconds. Warm values are medians of five repetitions.

| Destination | Webpack first visit | Turbopack first visit | First-visit speedup | Webpack warm | Turbopack warm |
| --- | ---: | ---: | ---: | ---: | ---: |
| Settings / General | 11305 | 2059 | 5.5x | 65 | 83 |
| Apps | 10141 | 1870 | 5.4x | 49 | 66 |
| Dashboard | 5291 | 1942 | 2.7x | 67 | 85 |

Warm samples in route order:

- Webpack Settings: 92, 58, 436, 57, 65; Apps: 58, 48, 70, 49, 49;
  Dashboard: 67, 67, 75, 67, 68.
- Turbopack Settings: 108, 83, 67, 64, 114; Apps: 66, 65, 64, 66, 69;
  Dashboard: 75, 85, 85, 100, 75.

The measured improvement is cold route compilation. Warm medians are slightly higher with
Turbopack in this run; this is not evidence of faster already-compiled navigation. These are
local sequential measurements, not a statistically controlled performance guarantee.

## SDK And Browser Checks

- Turbopack serves the authenticated Shell and its client and server SDK imports without any
  new aliases or SDK source changes. Existing `transpilePackages` remains in effect; the
  webpack-only extension aliases remain available to production builds.
- Fresh password login succeeds on Turbopack, including the SDK app-code exchange. Session,
  navigation and panel bootstrap requests return HTTP 200.
- All 18 transitions per bundler complete, retain the signed-in administrator and report no
  uncaught JavaScript errors. The subsequent Turbopack browser console check reports zero errors
  and zero warnings.
- A temporary hidden marker added to the copied SDK's `HostyNextOverlay` appears via Fast Refresh.
  Removing it also refreshes correctly. `performance.timeOrigin` is unchanged and the signed-in
  account remains present. The temporary SDK change is restored before production verification.

## Reproduction

Prepare a separate Core data root and source copy; install Shell through Core with its dev
runtime and an available port. Complete ordinary setup and password login. For each bundler,
start with an empty, separate dev output directory, open `/`, wait for the authenticated
Dashboard, and expand Settings. Measure real sidebar clicks through General, Apps and Dashboard
for six rounds. Keep other builds and tests out of the measurement interval. Use the existing
`next dev --webpack` command for the baseline and the candidate `npm run dev` for Turbopack.

Keep the isolated app manifest's port and setup adjustments out of repository changes. The
candidate changes only the Shell dev command, its version/lockfile entries and documentation.

## Verification Commands And Deployment

| Check | Result |
| --- | --- |
| `npm test --workspace @haas/hosty-shell` | Passed: 191 Node tests and 254 component tests across 30 Vitest files |
| `npm run lint --workspace @haas/hosty-shell` | Passed with two existing warnings in `shell-client.tsx` and `shell-sidebar.tsx` |
| `npm run build --workspace @haas/hosty-shell` in the isolated copy | Passed with webpack, including TypeScript and standalone output |
| `node scripts/docs-index.mjs --check` | Passed |
| `node scripts/check-versions.mjs` | Passed |
| `git diff --check` | Passed |

The Docker image was not rebuilt: its build command and runtime are unchanged, and this change
targets development. Embedded third-party app navigation was not included in the timings.

After verification, the working Core-managed Shell was restarted with
`hosty --data-root /Users/haas/.hosty apps restart hosty.shell`. Its process changed from
PID 68735 to PID 12078, with the new start timestamp `2026-10-13T17:54:55.377557+00:00`.
Startup logs report Next.js 16.3.8 (Turbopack), and Core reports Shell 0.101.10 running in dev
mode with no last error. Live session, navigation and panel requests return HTTP 200. The
working Core retains PID 72204 and its original process-start identity. The isolated QA Core,
its services and browser are stopped after verification.
