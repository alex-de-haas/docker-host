# Plan Portfolio Review — 2026-10-10

Baseline: `177c07e66326bd3cb986df0dc4ab141b97e4661e`, plus the working-copy documentation available during this review. The checkout already contained edits to Default Applications, Replaceable UI Clients and the generated index. A new SDK Panel System Draft appeared during the review, followed by its coordination changes to panel visibility, embedding restrictions and vision decision 27. Those changes were read and are included in the final assessment, but are not attributed to this review. This review adds only this archive; final index regeneration found the concurrently maintained index already current.

Scope: all 55 plans present at the initial inventory, plus the newly added panel plan. Read goals, remaining deliverables, decisions, dependencies and acceptance requirements against [the vision](../vision.md). Inspect current feature documents and selected implementation/test paths for closure candidates and architectural conflicts. This is a portfolio review with targeted source verification, not a full implementation audit of every deliverable or fresh deployment acceptance. Counts below are recorded checklist counts, not independently verified completion percentages.

Initial inventory: 39 Draft, 8 In Progress, 6 On Hold, 2 Blocked; no Ready plans. The additional panel Draft brings the reviewed inventory to 56. Draft design changes still need explicit approval before implementation. This review does not approve, abandon, close or change any plan.

## Recommended Next Work

The best small completion candidate is **Assistant Entry Points**, after reconciling its old contract and checking the remaining legacy receiver. **Manifest-Level App Assets** is the clearest small visible feature, but closing its entire plan includes another repository. **Panel Visibility** is modest in isolation, but now needs coordination with the proposed shared SDK panel host.

Effort categories are comparative estimates: Small means plausibly one focused implementation/verification session after decisions are settled; Medium means several sessions or a meaningful cross-component change; Large means a substantial feature. They exclude waiting for hardware, release publication, owner decisions and external repository access. No duration is guaranteed.

| Priority | Candidate | Work needed to close the whole plan | Assessment |
| --- | --- | --- | --- |
| 1 | [Assistant Entry Points](../features/assistant-entry-points/plan.md), 4/6 | Reconcile D4/D6 with authenticated handoffs; resolve the remaining legacy parent-message receiver; prove actual embedded-app ask wiring, rate limiting, destination selection and draft behavior; replace obsolete reality text. | Small–Medium; strongest completion candidate, not already complete. |
| 2 | [Manifest-Level App Assets](../features/manifest-level-app-assets/plan.md), 0/3 | Add the installed-app About view; decide screenshots; verify asset vendoring for every relevant catalog app before removing legacy catalog assets. | Small Shell slice; full closure depends on catalog work not inspected here. |
| 3 | [App UI Surfaces / Panel Visibility](../features/app-ui-surfaces/plan.md), 0/4 | Stable per-user panel identity, persistence, hide/restore, all-hidden recovery and explicit-open behavior. | Medium; agree the shared identity/host contract with SDK Panel System first. Do not create a second panel implementation. |

Useful small **partial** improvements also exist: observability D4 (trace/log navigation), secrets D4 (names-only CLI diagnostic), SDK extraction/adoption and runtime-update D3 (immutable Shell release tags). None closes its current owning plan. Do not quietly drop the remaining deliverables or manufacture per-phase PRs to report a whole feature complete. Any narrower independently scoped feature needs an explicit ownership/scope decision.

Backup retention has only two deliverables but explicitly records no concrete product need. It is a bounded enhancement, not a stronger priority than finishing existing accepted behavior.

## Near Completion, But Waiting On Acceptance

| Plan | Recorded progress | Actual remainder | Why it is not an immediate closure |
| --- | --- | --- | --- |
| [Core development mode](../features/core-dev-target/plan.md) | 0/3 remaining acceptance items | Windows build/restart/locked output/service adoption; full Linux CLI/Shell flow; real Claude/Codex continuation across restart. | The implementation already ships. Zero checked items describes the residual acceptance plan, not zero implementation. Real provider execution and OS evidence are still required. |
| [Mixed development runtimes](../features/mixed-development-runtimes/plan.md) | 10/13 | D7 embedded Telemetry on macOS/Windows, D8 native Linux routing, D13 final verification/docs. | A good acceptance campaign if those environments are available; isolated API tests are not browser embedding evidence. |
| [Speech provider consumption](../features/provider-consumption/plan.md) | 0/3 remaining acceptance items | CPU inference on the owner's Windows/AMD host, actual microphone/Shell flow, measurements and documentation. | Hardware-specific Blocked plan. Generic CI or this Mac cannot discharge it. |
| [App code exchange](../features/app-code-exchange/plan.md) | 16/20 | D14 production client rollout, D18 remaining acceptance, D20 native live first-open/switch/renewal/browser handoff, D16 final documentation. | Source merge and automated tests do not prove released/deployed clients or GUI/Keychain behavior. |
| [Local browser origins](../features/local-browser-origins/plan.md) | 31/40 | Nine open deliverables, including compatibility/migration, browser/OS matrix, clean installer, private-source acceptance and D39 coordinated upgrade/preflight. | The checklist combines implementation, acceptance and another design decision. It is not just final paperwork. |
| [Cardputer Shell](../features/cardputer-shell/plan.md) | 26/33 | Storage schema/migration, host-test seams, OTA rollback tests, stream revocation, board evidence and hardware acceptance. | There is real missing implementation. `SettingsStore` has no schema migration and image-health confirmation still uses readiness/time rather than migration success. |

The Windows/Linux portions of Core development, mixed runtimes and speech can share an environment-preparation effort. Each plan still needs its own scenario and evidence. Older documents saying that Linux was unavailable should be refreshed before scheduling: Local Browser Origins later records Linux VM acceptance, but that does not prove that the VM is available now or that the other plans' scenarios passed there.

## Material Reconciliation Findings

### R1. Assistant Entry Points describes a superseded path, with a real legacy remainder

The plan and its feature document still describe Shell forwarding text directly into the assistant frame, requiring an operator Send in every case, a delegated-token seed and no component-test harness. Current Shell's `askAssistant` applies its per-app limiter and calls an authenticated server handoff; the receiving assistant is opened at the finalized destination. Shell has Vitest component tests. [Harness integration](../features/hosty-harness-rename/feature.md) documents durable handoffs, and [Local Browser Origins](../features/local-browser-origins/plan.md#live-assistant-handoff-and-revocation-2026-10-01) records a real Core-managed protocol/revocation check, explicitly not a browser UI pass.

However, [Harness's assistant page](../../apps/harness/web/src/app/assistant/page.tsx) still handles `hosty:ask-assistant` and `hosty:open-assistant-session` with a parent-window check and no origin check. The old D6 has not simply vanished. The receiver only fills a draft; this observation is not a claim that it executes arbitrary prompts. Decide whether the legacy receiver has supported callers and remove or properly authenticate it accordingly. Do not add a new Core origin-distribution mechanism merely to preserve an unused path, and do not remove a supported path without checking callers.

The D4 gap also survives in a narrower form: selected tests cover the server, panel lifecycle and receiving UI, but the panel test mocks the embedded frame. They do not establish the full Telemetry button → verified frame event → Shell limiter → handoff → displayed draft chain. Close that exact gap and update both documents. The new SDK panel plan explicitly leaves D4/D6 with this owner.

Evidence: [Shell callback](../../apps/shell/src/app/shell-client.tsx), [verified embedded-frame parsing](../../apps/shell/src/app/shell/embedding/embedded-app-frame.tsx), [server handoff](../../apps/shell/src/app/shell/assistant/handoff-server.ts), [server tests](../../apps/shell/test/assistant-handoff-server.test.tsx), [panel tests](../../apps/shell/test/panel-rail.test.tsx), [receiver tests](../../apps/harness/web/src/app/assistant/page.test.tsx).

### R2. Azure PR lifecycle should leave the active candidate queue

[Azure PR lifecycle](https://github.com/alex-de-haas/docker-host/blob/177c07e66326bd3cb986df0dc4ab141b97e4661e/docs/features/assistant-pr-lifecycle-azure/plan.md) assumes existing active Entra/PAT source connections. Vision decision 20 and [Source Providers](../features/source-providers/feature.md) explicitly remove Azure DevOps from active support, retaining unsupported saved records. [SourceProviderRegistry](../../apps/core/src/Haas.Hosty.Core/SourceProvider.cs) rejects unsupported providers.

Recommendation: ask for a disposition, either abandon this plan or keep it deliberately On Hold as provider reintroduction plus PR lifecycle. It is not a small extension of currently supported Azure source access. Do not delete it merely because the review recommends abandonment.

### R3. System App Pages preserves a proposal contrary to the shipped access model

The [plan](https://github.com/alex-de-haas/docker-host/blob/177c07e66326bd3cb986df0dc4ab141b97e4661e/docs/features/system-app-pages/plan.md) correctly flags the conflict, but spends most of its text recommending a separate administrator-only System group and canonical system-specific routes. Generic app pages already exist; unified Apps navigation, assignments and separate administrative permissions are intentional shipped behavior.

Recommendation: retire the old navigation/access proposal if the owner confirms that the current model is the desired one. Before deleting the plan, audit D3's unavailable/readiness behavior and retain any real gap in the owning Shell/app-surface plan with a stable deliverable. This is potentially a small documentation cleanup, not proof that every D3 case already passes.

### R4. AI Agent Bridge is no longer a useful single completion target

[D9](../features/ai-agent-bridge/plan.md#step-9--the-user-profile) proposes a direct MCP-only user agent/chat profile, while vision decision 1 excludes regular-user free-text agent access. D10 still proposes the old `ai-gateway` interface and `/api/ai/generate`; the [Core Extension Model](https://github.com/alex-de-haas/docker-host/blob/177c07e66326bd3cb986df0dc4ab141b97e4661e/docs/features/core-extension-model/plan.md) records the later owner direction that app-mediated AI calls go directly to an agent rather than through an assistant. D11 durable jobs and D12 non-interactive validation jobs remain distinct, unbuilt work. Background conversations and existing Git/PR workspaces do not complete them.

Recommendation: resolve D9's product conflict explicitly, re-home D10 under the current agent-provider exploration without duplicate implementation ownership, and keep durable jobs and isolated validation as identifiable remaining work. Refresh the umbrella and its status instead of treating 8/12 as a nearly finished feature.

### R5. The extension model needs a new factual baseline

[Core Extension Model](https://github.com/alex-de-haas/docker-host/blob/177c07e66326bd3cb986df0dc4ab141b97e4661e/docs/features/core-extension-model/plan.md) still says system role controls reachability, `provides` has only the collector use, role declarations are unconfirmed, interfaces are draft metadata and Marketplace has zero Core permissions. Parts of those statements have been superseded by app permissions, confirmed assistant/speech roles and provider consumption. Its graduation criterion should be reassessed against those shipped contribution points; that does not approve all remaining extension mechanisms.

[PlatformCapabilities](../../apps/core/src/Haas.Hosty.Core/PlatformCapabilities.cs) recognizes consent-bearing assistant and speech roles. [Provider Consumption](../features/provider-consumption/feature.md) documents real discovery, permission checks and two-minute provider-bound credentials. Rebase D1/D5 on these implementations; do not introduce another role/permission system. Telemetry sink authentication, durable domain events and login-provider extensions remain substantial separate work.

### R6. Three plans need one explicit telemetry-auth ownership map

[Observability D1](../features/observability/plan.md) is unchecked but says query auth shipped and ingest confinement moved to [Cross-App Dependencies D6](../features/cross-app-dependencies/plan.md). [Core Extension Model D2](https://github.com/alex-de-haas/docker-host/blob/177c07e66326bd3cb986df0dc4ab141b97e4661e/docs/features/core-extension-model/plan.md) also promises sink/data-plane authentication. These are different guarantees: authenticated reads, network reachability and authenticated ingest attribution. A private network does not by itself prevent one installed app from impersonating another producer.

Current [backend routes](../../apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Program.cs) authenticate query access; the exposed read routes are ordinary queries rather than the proposed live stream. Trace IDs render as fields in the [log details](../../apps/telemetry-ui/src/components/observability/otlp-log-table.tsx); the requested bidirectional navigation is still a useful small slice.

Recommendation: remove duplicated/stale ownership text through explicit deliverable reconciliation, preserving unfinished ingest work with its owning plan. Keep Observability focused on its actual stream/UI/correlation remainder. Do not check D1 wholesale because only the query half shipped.

### R7. Cross-App Auth should not forward the Core service credential to peers

The [older proposal](../features/cross-app-auth/plan.md) sends a consumer's `HOSTY_APP_SERVICE_TOKEN` directly to a provider for introspection and treats no-expiry/reinstallation limitations as acceptable. Today's provider contract deliberately sends that service token only to Core and sends a distinct short-lived, installation-bound credential to the selected provider. The old proposal would expose the consumer's Core-facing authority to the peer it calls.

Rebase cross-app authentication on the current provider/introspection precedent before approving it; choose any broader generic peer contract explicitly. Do not claim the current speech/assistant categories already authenticate arbitrary media/torrent/transcode APIs. Those external repositories were not inspected in this review. [AppServiceTokenService](../../apps/core/src/Haas.Hosty.Core/AppServiceTokenService.cs) still signs only the app identity without an expiry or install generation, so secrets D1 is also real unfinished platform work.

### R8. Containment and approval plans preserve competing execution shapes

[Assistant Runtime Containment](../features/assistant-runtime-containment/plan.md) proposes a Docker profile for the whole Harness app, defaulting to container execution; it still asks whether to ship with the already-completed rename. Vision decision 26 describes exposing only a session's owned worktrees to its agent execution container. [Approval Rules](../features/assistant-approval-rules/plan.md), [Execution Authorization](../features/assistant-execution-authorization/plan.md) and [Workspace Lifecycle Controls](../features/workspace-lifecycle-controls/plan.md) divide the native filesystem boundary, credential scope and verified stop/cleanup.

Before resuming containment, decide whether the unit is the whole assistant app or each session execution and eliminate competing ownership. Preserve the accepted unrestricted autonomous mode as current behavior; shell-prefix/native isolation proposals are not already delivered by that mode. Sandbox runtime isolation remains separate from agent execution isolation.

### R9. Several small-looking plans are accumulated backlogs, not small features

- [Hosty App SDK](../features/hosty-app-sdk/plan.md): July fleet inventory plus later Overlay transfer. Re-inventory current factories/adoption and external consumers before estimating. Local SDK now has provider, permission, session, assistant and overlay modules, while Demo still has custom identity/directory logic. Do not label all old D1 text either done or missing from its date alone.
- [App Secrets Store](../features/app-secrets-store/plan.md): service-token lifecycle, platform-wide encryption, Core backup, a CLI listing and events have different dependencies and payoffs. The names-only CLI is small; the whole plan is not. Encryption and events still lack an established product need.
- [Notifications](../features/notifications/plan.md): discovery, MCP read/write, app read-back and email/push delivery are separate scopes. Its claim that a mark-read tool would be Core MCP's first mutation is obsolete; Core already has explicitly scoped lifecycle/source/restart mutations. No notification MCP/read-back implementation was found in the inspected endpoint inventory.
- [Runtime App Update](../features/runtime-app-update/plan.md): artifact staging, rollback/data migration, publication ordering, compatibility and notices are a release-hardening program. [Shell's manifest](../../apps/shell/manifest.json) still references `latest`, and [its image workflow](../../.github/workflows/shell-image.yml) publishes `sha-*` and `latest`, so D3 is real, not an obsolete checkbox. Immutable tags alone do not close D3's artifact-before-manifest publication requirement.
- [Automatic Runtime App Ports](../features/automatic-runtime-app-ports/plan.md): remaining allocator/lifecycle/UDP work is substantive. [RuntimePortAllocator](../../apps/core/src/Haas.Hosty.Core/RuntimePortAllocator.cs) still writes TCP assignments, and live-contract adoption carries existing assignments. Re-audit individual items against current code instead of trusting the July remainder word for word.

### R10. The vision itself contains stale present-tense claims

Correct these alongside plan cleanup, preserving dated owner decisions and their scope:

- Decision 3 and open question 4 say there is no mechanism for live Core source development. [Core Development Mode](../features/core-dev-target/feature.md) now provides source selection, prepared builds and explicit restart while retaining the one-Core constraint. It is not hot reload, and its platform acceptance is still open.
- The later-directions Harness rename paragraph still calls the rename an unchecked Draft; [Harness Integration](../features/hosty-harness-rename/feature.md) records the shipped replacement.
- Open question 1 bases its authorization problem on every system app being administrator-only. Current assignments and provider contracts change that explanation. App-mediated agent execution still needs its own contract; fixing the stale rationale must not silently authorize regular-user prompting.
- Clarify that decision 1's deferred user-rights granularity does not mean that implemented app grants and external credential scopes do not exist.

The vision is useful as a record of owner intent, but a stale factual sentence should not resurrect an old design when a later decision and implementation supersede it.

## Complete Plan Disposition

Recommendations below do not change workflow status. “Reconcile” means update the baseline, ownership or scope before scheduling; “Keep” means the direction remains coherent, not that implementation is approved. The progress column reproduces the plans.

| Plan | Status; progress | Recommendation and remaining boundary |
| --- | --- | --- |
| [advertised-app-origins](../features/advertised-app-origins/plan.md) | Draft; 0/8 | Reconcile with canonical browser/transport origin resolution and UI-client selection. LAN advertising still has a use case, but loopback binding is a separate decision; old CLI-doc migration is already obsolete. Medium. |
| [agent-app-evaluations](../features/agent-app-evaluations/plan.md) | Draft; 0/3 | Keep deferred; requires Sandbox, feedback intake and observed invocation evidence. Three deliverables do not make it small. Large. |
| [ai-agent-bridge](../features/ai-agent-bridge/plan.md) | In Progress; 8/12 | Reconcile D9/D10 product conflicts and D11/D12 ownership; see R4. Large remaining program. |
| [app-authoring](../features/app-authoring/plan.md) | Draft; 0/8 | Keep umbrella; real remaining creation/integration/adaptation examples and cross-feature acceptance. Compose/image adaptation makes it large. |
| [app-code-exchange](../features/app-code-exchange/plan.md) | Blocked; 16/20 | Preserve rollout and native live acceptance gates; near implementation completion, not verified deployment completion. |
| [app-data-backup-retention](../features/app-data-backup-retention/plan.md) | Draft; 0/2 | Park deliberately or abandon if no concrete need; bounded age/override feature, not implemented merely because backups exist. |
| [app-development-controls](../features/app-development-controls/plan.md) | Draft; 0/7 | Keep; runtime-control grants, wrappers and verified edit/run/leave remain. Preserve existing source overrides until an approved parity/migration path exists. Medium–Large. |
| [app-embedding-restrictions](../features/app-embedding-restrictions/plan.md) | On Hold; 0/7 | Preserve hold; reconcile designated standalone panel hosts with SDK panels and the browser runner. Do not revive a Shell-only embedder assumption. |
| [app-feedback-inbox](../features/app-feedback-inbox/plan.md) | Draft; 0/4 | Keep; durable user intake, evidence, capture and administrator triage remain a substantial feature. Overlay availability alone does not deliver it. |
| [app-prototype-workspaces](../features/app-prototype-workspaces/plan.md) | Draft; 0/18 | Keep no-Git bootstrap goal; rebase Git save/push and authority descriptions on Core-managed source operations. D9's “without Core clone/commit/push” needs a boundary clarification against decision 17. Large. |
| [app-publication](../features/app-publication/plan.md) | Draft; 0/7 | Keep release/feed/catalog scope distinct from shipped code PR lifecycle; refresh provider choice against GitHub-first source support. Large. |
| [app-sandbox-runtimes](../features/app-sandbox-runtimes/plan.md) | On Hold; 0/9 | Preserve explicit deferral; instance identity, substitute data/dependencies and browser execution remain unbuilt. Large. |
| [app-secrets-store](../features/app-secrets-store/plan.md) | Draft; 0/5 | Reconcile independent scopes; service-token lifecycle remains real, CLI listing is small, encryption/backup/events need concrete justification. See R7/R9. |
| [app-ui-surfaces](../features/app-ui-surfaces/plan.md) | Draft; 0/4 | Viable modest UX feature after shared panel identity and hidden-target decisions. Coordinate with new SDK host. Medium. |
| [assistant-action-summary](../features/assistant-action-summary/plan.md) | Draft; 0/3 | Keep downstream of shared invocation correlation; success/count aggregation is not a small visual-only change. Medium–Large. |
| [assistant-ahp](../features/assistant-ahp/plan.md) | Draft; 0/5 | Keep bounded client/auth/reconnect spike first; a successful spike would not close adapter/interoperability deliverables. Do not gate internal work on it. |
| [assistant-approval-rules](../features/assistant-approval-rules/plan.md) | Draft; 0/16 | Reconcile older first-slice/native-sandbox proposals with deferred container direction and shipped autonomy. Prefix rules, enforcement and revocation remain. Large. |
| [assistant-development-sessions](../features/assistant-development-sessions/plan.md) | Draft; 0/3 | Keep integration umbrella; refresh shipped workspace/PR baseline. Switching and test runtime portions of its end-to-end journey remain, so three items do not imply near closure. |
| [assistant-entry-points](../features/assistant-entry-points/plan.md) | In Progress; 4/6 | First small closure candidate; R1 identifies the exact legacy/wiring remainder. Small–Medium. |
| [assistant-execution-authorization](../features/assistant-execution-authorization/plan.md) | Draft; 0/3 | Keep deliberately deferred execution-scoped authority; viewer permissions/task labels are not this contract. Medium–Large. |
| [assistant-external-session-context](../features/assistant-external-session-context/plan.md) | Draft; 0/3 | Keep lower priority. Workspace registration shipped, but explicit session reads/report import, deduplication and visibility are separate remaining work. Medium. |
| [assistant-pr-lifecycle-azure](https://github.com/alex-de-haas/docker-host/blob/177c07e66326bd3cb986df0dc4ab141b97e4661e/docs/features/assistant-pr-lifecycle-azure/plan.md) | Draft; 0/4 | Recommend abandonment or deliberate hold pending Azure provider reintroduction; see R2. |
| [assistant-runtime-containment](../features/assistant-runtime-containment/plan.md) | On Hold; 0/7 | Preserve hold and reconcile whole-Harness versus per-execution container ownership; see R8. Large. |
| [assistant-shared-history](../features/assistant-shared-history/plan.md) | Draft; 0/6 | Keep; current `SessionManager.setConnection` still rejects switching a started chat. Journal correlation, context cursors and sharing are genuine remaining work. Large. |
| [assistant-timeline-analysis](../features/assistant-timeline-analysis/plan.md) | Draft; 0/3 | Keep deferred behind invocation evidence/action summary; analysis and equivalence suggestions are not simple timeline rendering. Large. |
| [auth-provider-extensions](../features/auth-provider-extensions/plan.md) | Draft; 0/5 | Reconcile password-reset wording with existing explicit recovery; OIDC/provisioning and email remain. Distributed-deployment throttling is speculative under the single-Core vision. Medium–Large. |
| [automatic-runtime-app-ports](../features/automatic-runtime-app-ports/plan.md) | Draft; 0/10 | Re-audit item by item; allocator lifecycle and transport work remains. Current component tests invalidate the old “no harness” rationale. Medium–Large. |
| [cardputer-shell](../features/cardputer-shell/plan.md) | In Progress; 26/33 | Keep missing migration/test work and physical-device acceptance; not a documentation-only closure. Medium plus hardware. |
| [core-dev-target](../features/core-dev-target/plan.md) | In Progress; 0/3 | Acceptance-only closure candidate if Windows/Linux and real providers are available. Update old Gateway terminology. |
| [core-extension-model](https://github.com/alex-de-haas/docker-host/blob/177c07e66326bd3cb986df0dc4ab141b97e4661e/docs/features/core-extension-model/plan.md) | Draft; 0/6 | Rebase on confirmed roles, grants and existing providers; retain only unbuilt extension mechanisms. See R5/R6. Large. |
| [core-service-unit](../features/core-service-unit/plan.md) | On Hold; 0/1 | Preserve owner hold. One broad deliverable hides three OS integrations and update/supervisor coordination. Not small. |
| [core-single-binary](../features/core-single-binary/plan.md) | On Hold; 0/1 | Preserve hold. A decision to stay split could retire it quickly; merging binaries is significant release/update work. Runtime parameters are already shipped. |
| [cross-app-auth](../features/cross-app-auth/plan.md) | Draft; 0/6 | Redesign credential boundary before implementation; reuse current scoped provider precedent, not raw service-token forwarding. External app adoption remains. |
| [cross-app-dependencies](../features/cross-app-dependencies/plan.md) | Draft; 0/6 | Reconcile old trusted-fleet assumptions and telemetry ownership; mixed container/local networking remains substantial. Network scoping is not caller authorization. |
| [cross-port-session-capture](../features/cross-port-session-capture/plan.md) | Draft; 0/10 | Retain as unresolved protocol work, not a stale item closed by app code exchange. Current general session gate still lacks the proposed separate proof. No fresh exploit reproduction in this review. |
| [default-applications](../features/default-applications/plan.md) | Draft; 0/5 | Current coordinated design; keep separate approval. Shared state, migration, capabilities and frozen selections make it Medium–Large, not a preference-field patch. |
| [dependency-ordered-autostart](../features/dependency-ordered-autostart/plan.md) | Draft; 0/6 | Keep; code explicitly still omits cross-app dependency order. Waiting/wakeup/cycles and bootstrap interactions need decisions. Medium. |
| [hosty-app-sdk](../features/hosty-app-sdk/plan.md) | In Progress; 1/7 | Re-inventory post-Overlay code and external adoption; several small slices, no small whole-plan closure. See R9. |
| [hosty-harness-swift](../features/hosty-harness-swift/plan.md) | Draft; 0/8 | Keep deferred native product; AHP spike, platform/distribution and background notification boundaries remain. Large. |
| [internal-endpoint-exposure](../features/internal-endpoint-exposure/plan.md) | Draft; 0/4 | Decide whether Cloudflare-only routing protection is wanted. A decision to keep operator guidance only can retire it; implementation still needs actual ingress acceptance. Small–Medium. |
| [local-browser-origins](../features/local-browser-origins/plan.md) | In Progress; 31/40 | Preserve nine open requirements; consolidate acceptance evidence, but do not erase coordinated-upgrade design or external-platform gaps. |
| [manifest-level-app-assets](../features/manifest-level-app-assets/plan.md) | Draft; 0/3 | Best small visible feature; About rendering is absent in current Shell. Screenshot choice and catalog cleanup gate full closure. |
| [mcp-facade](../features/mcp-facade/plan.md) | On Hold; 0/5 | Preserve deliberate separate-app deferral. Refresh old Gateway identity; current Harness facade existence is not separate bridge delivery. |
| [mixed-development-runtimes](../features/mixed-development-runtimes/plan.md) | In Progress; 10/13 | Acceptance campaign candidate; retain browser, Windows and native Linux requirements. |
| [notifications](../features/notifications/plan.md) | Draft; 0/5 | Reconcile discovery/MCP claims and channel ownership with extensions/native clients. Core inbox already ships; push/delivery does not. See R9. |
| [observability](../features/observability/plan.md) | In Progress; 7/11 | Reconcile transferred D1; implement actual remaining stream/live-tail/correlation work. Correlation alone is a small slice. |
| [plan-provider-interface](../features/plan-provider-interface/plan.md) | Draft; 0/4 | Keep intentionally early exploration; a bounded comparison/consumer design exercise, not an approved implementation. Existing Markdown reader is not provider delivery. |
| [private-distribution-access](../features/private-distribution-access/plan.md) | Draft; 0/4 | Keep independent of Git source auth; feed/release/registry credential ownership remains undesigned. Large. |
| [provider-consumption](../features/provider-consumption/plan.md) | Blocked; 0/3 | Hardware acceptance only; schedule on the actual Windows/AMD deployment, not this Mac. |
| [replaceable-ui-clients](../features/replaceable-ui-clients/plan.md) | Draft; 0/6 | Current coordinated revision; default store, recovery, migrations and role authority remain. Retired D2 stays retired. Medium–Large. |
| [runtime-app-marketplace](../features/runtime-app-marketplace/plan.md) | Draft; 0/6 | Keep capability-led discovery, but revisit “administrator-only” assumptions against assignment-based app access. MCP reads plus capability metadata/classification/reuse are larger than a two-tool wrapper. |
| [runtime-app-update](../features/runtime-app-update/plan.md) | Draft; 0/5 | Keep release hardening; reconcile compatibility/preflight ownership with Local Browser Origins D39. Tag publication is a bounded slice, rollback/data policy is not. |
| [runtime-artifact-model](../features/runtime-artifact-model/plan.md) | Draft; 0/6 | Keep unbuilt prebuilt-download and platform-lock work; decide private distribution and app-adaptation dependencies explicitly. Large. |
| [system-app-pages](https://github.com/alex-de-haas/docker-host/blob/177c07e66326bd3cb986df0dc4ab141b97e4661e/docs/features/system-app-pages/plan.md) | Draft; 0/5 | Recommend retiring superseded navigation/access proposal after owner disposition; preserve any verified readiness gap. See R3. |
| [workspace-lifecycle-controls](../features/workspace-lifecycle-controls/plan.md) | Draft; 0/3 | Keep deliberately deferred; close, execution stop, access revocation and physical cleanup are distinct. Not a small Close button. |
| [sdk-panel-system](../features/sdk-panel-system/plan.md) | Draft; 0/7; added during review | New coherent proposal, not an old-plan closure candidate. Shared SDK host, Core discovery, Shell adoption and Plans integration are substantial; coordinate visibility, embedder policy and defaults. |

## Suggested Cleanup Sequence

1. Correct the vision's stale factual statements and refresh Assistant Entry Points, the extension model and the bridge umbrella against the current implementation. Preserve dated decisions and unbuilt deliverables.
2. Obtain explicit dispositions for Azure PR support, the old system-page policy and speculative retention/encryption/distribution ideas. Delete only genuinely abandoned plans; use On Hold for deliberate deferral.
3. Finish the bounded Assistant Entry Points remainder. If a visible new UI feature is preferred, settle assets/screenshots/catalog scope and implement Manifest-Level App Assets.
4. Batch platform preparation for the accepted near-complete plans. Record each missing scenario as unfinished until its own acceptance passes.
5. Sequence panel/default/UI-client work together at the design level, while keeping one complete feature per PR and independent approval boundaries.

This review is a dated archive, not another work queue. Turn an accepted recommendation into the owning plan's remaining deliverables before implementation. It does not supersede or delete previous security, OAuth or provider-experiment reviews, whose complete findings were not re-verified here.

## Verification Performed

- `npm run test:components --workspace @haas/hosty-shell -- test/assistant-handoff-server.test.tsx test/assistant-selection.test.tsx test/panel-rail.test.tsx` — passed, 3 files / 12 tests.
- `npm run test --workspace @haas/hosty-harness -- src/handoff/store.test.ts web/src/app/assistant/page.test.tsx web/src/lib/ask-draft.test.ts` — passed, 3 files / 46 tests.
- `node scripts/check-versions.mjs` — passed.
- `git diff --check` — passed.
- Initial `node scripts/docs-index.mjs --check` reported a stale generated index while concurrent documentation work was present. Final `node scripts/docs-index.mjs --fix` found the index already current; `node scripts/docs-index.mjs --check` then passed, as did version and whitespace checks.
- Inventory comparison — all 56 current plan folders have a disposition in the table. No plan status or checkbox was changed by this review.

No runtime implementation changed. Full builds and all-project tests were not run because this change is documentation-only; the selected existing tests validate the main closure recommendation only. No live Core/app restart, browser acceptance, external repository/catalog inspection, release/deployment verification, Windows/Linux/device test or current upstream AHP compatibility check was performed. Existing documents' live results are historical evidence, not runs performed in this review.

Version outcome: no version change — documentation-only. No commits or pull requests created.
