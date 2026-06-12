# Gateway And App Wrapping Ideas

Status: Idea.

## Context

The retired Legacy Host gateway and ingress UI are not part of the current Hosty Core/Shell implementation. Current browser app launch relies on Hosty-aware runtime apps redirecting to Core, exchanging app authorization codes, and creating app-local sessions on their own origin.

## Idea

Future gateway, ingress, or app-wrapping work should build on current Core-owned app identity, app assignments, runtime app endpoints, and Shell-managed launch flows.

Potential directions:

- service/API endpoint exposure managed by Core or by an explicit Core-managed gateway runtime;
- Shell UI for gateway or ingress readiness only after Core owns the underlying APIs;
- wrapping support for browser apps that cannot exchange Hosty app codes or create app-local sessions;
- assigned-only exposure policy based on the existing app assignment model.

## Boundaries

- Do not restore the retired Legacy Host metadata contracts.
- Do not proxy app HTML through Shell as part of current embedded app launch.
- Do not forward Hosty browser session cookies to runtime app origins or gateway targets.
- Keep service/API exposure separate from browser UI launch until a gateway model is explicitly designed.

