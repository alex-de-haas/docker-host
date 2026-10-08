---
status: In Progress
created: 2026-07-15
updated: 2026-10-08
summary: The SDK's second wave, extracting the remaining platform glue every app still hand-writes.
components: [packages/app-sdk, packages/app-sdk-dotnet]
---

# Hosty App SDK — Second Wave

Auth was phase 1 and shipped ([feature.md](feature.md)). What remains is the rest of the platform glue
every app still hand-writes, plus the last adoption debts of the auth slice itself.

The ranking below comes from a fleet-wide sweep run 2026-07-19/20 across media-server,
project-manager, the three in-tree Next apps, and Shell, after the media-server migration. It replaced
the original shortlist guesswork with evidence, and the argument is the same one auth won on: the drift
examples are already real. Ordering is by payoff.

Owner-approved scope split, 2026-10-08: [Hosty Overlay](../hosty-overlay/plan.md) owns the shared
browser session coordinator, standard identity/session route adapters and uniform root UI.
Its D1 replaces those portions of D1 below. Overlay presentation has no app customization; the
remaining SDK extraction and adoption debts retain their scope here.

## Deliverables

- [ ] D1. **Finish the auth slice — adoption plus the missing factories, not new extraction.**
  - The optional `/logout` route-handler factory. Standard identity/session route adapters are
    owned by Hosty Overlay D1 rather than duplicated here.
  - The middleware/proxy factory: public paths, launch-code pass-through, header stripping,
    trusted-identity injection. project-manager's `proxy.ts` is the live reference.
  - The scoped app-directory client (`/api/internal/apps/{id}/directory/users`) — three parallel
    implementations exist (demo-app `host-auth.ts`, project-manager `host-directory.ts`, media-server
    .NET `HostyCoreClient`).
  - The adoption debts: demo-app's server slice (its 545-line `host-auth.ts` is the last hand-rolled
    revalidation copy in-tree, and migrating it frees the app-directory client for extraction);
    project-manager's pre-SDK wrapper layer (`module-runtime.ts`, `host-app-code.ts`,
    `host-app-cookie.ts`, and its own token reading in `host-identity.ts`/`proxy.ts`); and the
    `^0.1.2` pins in media-server and project-manager, which a 0.x caret can never lift on its own.
- [ ] D2. **`/otel` — OpenTelemetry wiring.** `instrumentation.ts` plus `otel-logs.ts` (the console→OTLP
      bridge with trace correlation and SIGTERM flush) are copied in media-server and project-manager,
      but secret redaction and the 200-records/10s rate limit exist **only** in the project-manager
      copy. ~200 lines of platform glue whose only app-specific value is the service-name default. The
      .NET counterpart is media-server's `HostyTelemetry.cs` → `HostySdk.App`. The three in-tree Next
      apps wire no OTel today and would gain tracing for free.
- [x] D3. **`/theme` — theme bridging.** Decided 2026-09-07: the extraction carries the current
      protocol and any theming redesign happens inside the SDK. The trigger was a real defect, not
      duplication for its own sake — the Shell's `hosty:shell-theme` post at frame `load` lands before
      the app's listener exists, and the marketplace/telemetry-ui copy, which read nothing else, then
      painted whatever its tab had stored. Telemetry-ui is where it was found and first fixed
      privately; that fix is replaced here rather than shipped, so its 0.9.1 lands with this work.
  - The slice: `@hosty-sdk/app/theme` (protocol constants, `resolveTheme`, `applyTheme`,
        `parseShellThemeMessage`, `createShellThemeMessage`, `themeBootstrapScript`),
        `HostThemeBridge` in `react`, `appendThemeLaunchParams` in `embedder` — SDK 0.12.0, with the
        suite in `theme.test.ts`.
  - In-tree adoption in the same PR: marketplace, telemetry-ui, and demo-app mount the SDK bridge
        and bootstrap and delete their copies; Shell sends through the SDK.
  - media-server web and project-manager take 0.12.0 and delete their copies — media-server
        #253 (0.72.2) and project-manager #77 (0.10.2), both merged 2026-09-07.
  - ai-gateway web's `startThemeSync` — a sixth listener the 2026-07 sweep predates. Its web
        workspace now declares `@hosty-sdk/app` of its own and mounts the bridge and bootstrap; the
        two pages no longer start a sync each. Six copies of the protocol are down to none.
- [ ] D4. **`/env` — the non-auth environment contract.** The SDK reads only the auth variables; every
      app hand-parses the rest: `HOSTY_PORT_{KEY}` (media-server `HostyKestrel`),
      `HOSTY_SERVICE_{KEY}_URL` (telemetry-ui `backend.ts`), `HOSTY_DEPENDENCY_{KEY}_URL`,
      `HOSTY_PUBLIC_ORIGIN_{ENDPOINT}`, `HOSTY_APP_DATA_DIR` (project-manager `storage.ts`), and the
      `HOSTY_MOUNT_{KEY}` `label=path,…` parser — duplicated across languages (demo-app
      `demo-config.ts`, media-server `MediaServerSettings.cs`). Cheap to type once; it is platform
      contract, not app logic.
- [ ] D5. **Core capability client (`server` + .NET).** media-server's `HostyCoreClient` is the fleet's
      only implementation of the backup trigger and operator notifications; any stateful app wants
      both, and the directory client from item 1 is the same surface. Adjacent: the data-dir ownership
      pattern (project-manager's `docker-entrypoint.sh` mkdir/chown/drop-privileges dance) for stateful
      Docker apps.
- [ ] D6. **Small standardizers.** A `healthz` route factory — marketplace and telemetry-ui are
      identical, while demo-app, project-manager, and media-server use three different paths and
      response shapes for the same manifest `healthcheck` contract. The BFF proxy route factory
      (media-server `api/proxy/[...path]`: hop-by-hop stripping, identity bearer injection, body
      streaming) together with the bearer-fallback browser transport (media-server `api.ts` plus the
      fetch-based SSE client in `sse.ts` — the cross-site-cookie workaround every app with its own
      backend service re-derives). `host-auth-debug` from project-manager. The manifest render script
      (project-manager `render-app-manifest.mjs`) as shared release tooling.
- [ ] D7. Docs: fold each shipped slice into [feature.md](feature.md), keep the adoption table current, and
      regenerate the index.

Version outcome: `@hosty-sdk/app` minor per slice, `HostySdk.App` minor for the .NET counterparts. No
platform change — every item is app-side glue against contracts Core already serves.

Checked and rejected as non-candidates: `app.0.1` manifest types (Core is the only parser — there is
no app-side duplication to collapse); project-manager's
`safe-fetch.ts` (an SSRF guard for user-configured outbound URLs — app business logic that only looks
like platform glue).

The former private installation protocol is removed by
[app-installation-sdk](../app-installation-sdk/feature.md), which owns the shared client, dialog
and Core confirmation workflow.

## Open Questions

- Question: Where does cross-app auth land if it is ratified?
  Answer: [cross-app-auth](../cross-app-auth/plan.md) proposes a provider middleware and a consumer
  handler, which are the same surface as item 5.
  Recommendation: fold it into the capability-client work rather than opening a parallel extraction; it
  needs no new distribution channel.

## Verification

- Each extracted slice ships with the package suite covering it, and at least one app migrated onto it
  in the same PR — an unadopted factory proves nothing and is how the last round of drift started.
- The adoption debts are verified by deletion: demo-app's `host-auth.ts` and project-manager's wrapper
  modules are gone, not merely bypassed.
- For `/otel`, the redaction and rate-limit behavior that exists only in project-manager today is
  asserted in the package, since collapsing five copies onto the weakest one would be a regression.
- Live: an app on the new factories recovers a dead session in both channels (embedded silent reissue,
  standalone `/open` redirect) exactly as it did before the migration.
