---
created: 2026-10-08
updated: 2026-10-08
summary: SDK-owned React overlay combines session and required-permission readiness, hides blocked content and preserves same-user state through recovery.
components: [packages/app-sdk, apps/shell, apps/marketplace, apps/plans, apps/demo-app, apps/harness, apps/telemetry-ui]
---

# Hosty Overlay

`HostyOverlay` from `@hosty-sdk/app/react` wraps protected React content once. Shell, Plans,
Marketplace, Demo App, Harness web and Telemetry UI use this component instead of separate sign-in,
activity and required-permission notices. Public routes can sit outside its scope.

## Integration Contract

The default endpoints are `GET /api/hosty/session` and `POST /api/auth/app-code`. The SDK's
`createHostySessionRouteHandler(config, options)` supplies the Web/Next handler;
`createHostySessionResponse(validatedSession, recovery, options)` from `/session/server` supplies
the framework-neutral Node adapter used by Harness. Existing app-code factories handle exchange.
Shell's standard code endpoint forwards its existing HttpOnly-only renewal handler. App-specific
administrator restrictions remain explicit in the adapter options and application API handlers.

The shared `useAppIdentity` and `useAppActivity` coordinators also back the legacy bridges. Existing
exports, authentication protocols, Core validation, per-app cookie names and embedded grant storage
remain compatible. Apps use SDK request clients instead of handling raw tokens. Service credentials
stay on the server; the setup response does not return tokens. See the
[integration example](../../../packages/app-sdk/README.md) and [SDK reference](../hosty-app-sdk/feature.md).

The overlay accepts only children and optional endpoint paths. Compatible SDK updates change its
standard presentation and recovery behavior through a dependency update and app rebuild. New Core
capabilities still require a compatible Core. No app-specific palette, branding, text or renderer
override is available. Legacy bridges retain their older customization API for existing consumers.

## SDK Release And Consumer Updates

A merge to `main` touching `packages/app-sdk` triggers the SDK publication workflow. The workflow
runs tests, builds the package and publishes its new version to npm through trusted publishing;
an already-published version is skipped. Dependabot detects registry versions, not source edits or
pull-request branches.

In this repository, the six React consumers resolve `@hosty-sdk/app` through npm workspaces. SDK
changes trigger their CI checks; the Shell, Plans, Marketplace, Demo App and Telemetry UI image
workflows include the SDK path. They do not need a Dependabot PR to consume this workspace package.

External Project Manager and Media Server repositories configure weekly npm checks and a separate
`hosty-sdk` group for minor/patch versions. Their declared `^0.21.0` range does not admit `0.22.0`
on its own; Dependabot can update both the requirement and lockfile. Existing merged SDK update
PRs demonstrate that flow ([Project Manager #94](https://github.com/alex-de-haas/project-manager/pull/94),
[Media Server #295](https://github.com/alex-de-haas/media-server/pull/295)). Checks follow the schedule
and applicable cooldown, rather than running immediately on a release. GitHub documents a default
three-day version-update cooldown in its
[Dependabot overview](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-version-updates).
An update PR still needs merging and the consumer's normal build/deployment.

External apps using the legacy bridges need the one-time wrapper and session-route migration
before standard overlay improvements arrive through dependency updates alone. Keeping old exports
compatible means updating the package by itself does not replace an app's existing custom UI.

## Readiness And Presentation

The authenticated adapter reads this app's own permissions through its service credential. Identity,
app access and required setup form one readiness result; the client never mounts protected children
between separate identity and permission responses. Unknown or failed readiness remains blocked.

| State | Behavior |
| --- | --- |
| Connecting or recovering | Stable surface with a progress indicator delayed by 180 ms |
| Sign-in or activity renewal required | Action opens the existing Core-owned flow |
| Required permissions missing, administrator | Core review action, with a direct link while review is pending |
| Required permissions missing, regular user | Administrator setup explanation without buttons or permission details |
| Unsupported required permission or incompatible session endpoint | Compatibility explanation |
| Optional permission missing | No general warning or gate |
| Access denied | Explanation without repeated automatic sign-in |
| Core unavailable | Retry while retaining the mounted application state |
| Ready | Reveal protected content |

Review remains Core-owned and uses the existing verified embedder message where available. Focus and
pending review refresh readiness; there is no background identity keepalive polling. Missing or
malformed permission data does not become successful readiness.

The fixed design follows Hosty's light/dark theme and uses a transparent background in embedded
mode, with a neutral standalone surface. Its heading uses the official Shell's connected-node mark
and uppercase HOSTY wordmark, rendered in the theme's foreground color. A modal dialog holds focus; Escape does not dismiss the
access requirement. The component hides and makes inert the retained content, including sibling
app portals inserted later. Cleanup restores prior inert values and focus. Motion honors the
reduced-motion preference. This presentation is not a substitute for endpoint or server-rendered
data authorization.

## Recovery And State

Initial content mounts only after readiness. Later interruption retains the mounted tree in memory.
The known privileged activity deadline blocks the page even before an API request receives a 401.
Successful renewal validates the stable user ID and required setup before pending SDK requests retry.
New SDK requests also wait during credential exchange and validation. If renewal succeeds but setup
is incomplete, the page stays blocked; later setup completion restores it without replaying the
previously rejected writes.
The same user resumes existing state. A different user triggers a full app-document reload and
cancels old pending work instead of replaying it under the new identity. An embedded app reload
does not navigate Shell. Failed or cancelled recovery keeps content blocked.

`APP_SESSION_RESTORED` from `/browser-auth` reports validated same-user restoration with
`detail.userId` and no credential. Applications do not need to subscribe. Generic draft snapshots,
persistent cache cleanup and restoration after a document reload are outside this component.

Identity still has its existing sliding idle and absolute limits; local editing alone does not
renew it. Privileged activity has its existing fixed deadline. See
[session lifecycle](../auth-session-lifecycle/feature.md) and [activity window](../app-activity-window/feature.md).
Element picking, screenshots and assistant evidence belong to
[App Feedback Inbox](../app-feedback-inbox/plan.md), separately from this overlay.

## Testing Expectations

- SDK tests cover combined readiness, administrator/member setup, unsupported and optional grants,
  transport errors, delayed or superseded probes and compatibility failures.
- Recovery tests retain a mounted input and hide sibling portals, enforce known expiry, preserve
  state after outages, and verify actor identity before retrying pending mutations.
- `npm run build --workspace @hosty-sdk/app` followed by
  `node packages/app-sdk/scripts/check-overlay-upgrade.mjs` verifies published exports and identical
  consumer source across a dependency-only presentation change.
- Build and test all six consumers after SDK changes. Use an isolated Core-managed environment and
  normal password login for embedded/standalone, review-return and cookie-only Shell browser checks.
- Browser acceptance includes light/dark, focus, keyboard interaction, delayed loading and app
  portals. Unverified acceptance cases stay in the remaining plan until exercised.
