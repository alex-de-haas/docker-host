# Free ReUI adoption audit: Shell and AI Gateway

Date: 2026-09-23

Baseline: `63605469322fef61ce1bab406dd0f554832f4a90`, plus the working-tree UI changes present during this review: Gateway's application-specific MCP access settings and Shell's left sidebar edge toggle/right resize cleanup. These changes are not all contained in the baseline commit.

Scope: source-level inventory and comparison with the public ReUI registry and documentation. This is an adoption assessment, not an implementation plan or a runtime accessibility certification. No components were installed, runtime code changed, or Pro source incorporated by this audit.

## Assessment

Free ReUI and the shadcn primitives used by its examples cover the ordinary presentation needs of both applications: grouped settings, forms, feedback, lists, dialogs, navigation, and chat presentation. A Pro purchase is not required for the recommendations below. There is no useful single coverage percentage: a component catalog supplies presentation and interaction primitives, while Hosty still owns permissions, identity, lifecycle operations, streaming, persistence, and provider behavior.

The strongest new component is **Frame**, applied to existing settings controls. It supplies the nested, grouped appearance requested for settings without importing an entire Agents block. The next opportunities are consistent field layouts and feedback in Shell, followed by selected list compositions in Gateway. Replacing every existing Button, Dialog, or Switch would add migration cost with little benefit.

Gateway already contains actual free ReUI source: its Code Block. Message Scroller and Attachment are shadcn components referenced by ReUI examples. Calling the whole current interface merely “inspired by ReUI” would be inaccurate; that description applies to the new settings composition, not the existing Code Block integration. See [chat component provenance and local modifications](../features/ai-gateway-chat-ui/feature.md).

## What “free ReUI” means here

| Category | Examples | Treatment |
| --- | --- | --- |
| ReUI's own free primitives | Frame, Code Block, Data Grid, Number Field, Filters | Inspect and add individual registry items where justified. Availability alone is not a reason to install them. |
| Upstream shadcn primitives and free compositions shown by ReUI | Field, Item, Input Group, Native Select, Tabs, Sidebar, Alert Dialog, Message, Bubble, Marker | Reuse local implementations when present; add missing primitives or adapt a free example. These are not all independent ReUI inventions. |
| Hosty components | ProviderRow, MCP access, application rows, approval/question cards, embedded panels | Keep domain behavior and compose it from the primitives above. |
| Pro blocks | Complete Agents/settings/App Shell compositions from the earlier references | Excluded from this audit's adoption recommendations. |

ReUI's open-source code is [MIT licensed](https://github.com/keenthemes/reui/blob/main/LICENSE.md). Preserve the applicable copyright and permission notices when copying it. This permits using that code in a commercial or open-source Hosty product; adopting the free source does not require changing Hosty's license. This finding does not extend MIT terms to paid blocks or third-party dependencies.

Useful public references: [ReUI catalog](https://reui.io/docs), [Frame API and free examples](https://reui.io/docs/components/radix/frame), [Field examples](https://reui.io/components/field), [Item examples](https://reui.io/components/item), and the upstream APIs for [Native Select](https://ui.shadcn.com/docs/components/radix/native-select), [Tabs](https://ui.shadcn.com/docs/components/radix/tabs), [Alert Dialog](https://ui.shadcn.com/docs/components/radix/alert-dialog), and [Sidebar](https://ui.shadcn.com/docs/components/radix/sidebar).

## Existing foundation

| Area | Shell | AI Gateway web |
| --- | --- | --- |
| Styling and primitives | Tailwind 4, shadcn `new-york`, Radix, Lucide | Same foundation |
| Registry configuration | No custom registry | Explicit `@reui` → `https://reui.io/r/radix-vega/{name}.json` |
| Local `ui` component modules | 12, including Button, Card, Dialog, Table, Resizable, Switch, Tooltip | 22, including Field, Input Group, Select, Tabs, Empty, Attachment, Message Scroller |
| Extra ReUI source | None found in the audited component inventory | Code Block and highlighting support |
| Semantic feedback colors | Mostly local status classes | Additional success, info, warning, and invert tokens already present |

Evidence: [Shell registry configuration](../../apps/shell/components.json), [Gateway registry configuration](../../apps/ai-gateway/web/components.json), [Shell theme](../../apps/shell/src/app/globals.css), [Gateway theme](../../apps/ai-gateway/web/src/app/globals.css), and [Gateway Code Block adapter](../../apps/ai-gateway/web/src/components/chat-code-block.tsx).

The applications have separate stylesheets and embedded documents. Changing Shell's tokens or components does not automatically update Gateway. Shared visual conventions can be adopted in both without immediately creating a shared UI package.

## Shell opportunities

Priority: **First** is a strong initial candidate; **Later** needs a separate interaction decision or broader change; **Keep** has little replacement benefit. Effort: **S** is a local presentation adaptation, **M** spans several controls or state contracts, and **L** replaces substantial interaction structure. These are relative scope estimates, not delivery dates.

| Surface and source | Candidate and benefit | Priority / effort | Behavior to preserve |
| --- | --- | --- | --- |
| Core settings: [layout](../../apps/shell/src/app/shell/pages/core-settings-layout.tsx), [form](../../apps/shell/src/app/shell/pages/core-settings-form.tsx) | **Frame + Field** for section headers, grouped rows, descriptions, and save area. Closest fit to the requested visual style. | First / M | Explicit save, hidden settings retained in drafts, changed-key submission, override reset, duration conversion. |
| Shared setting controls: [SettingInput](../../apps/shell/src/app/shell/settings.tsx) | **Input Group**, **Native Select**, **Field** for unit suffixes, URL decoration, labels, and errors. Existing Switch remains useful. | First / M | Empty-string options, numeric string drafts, partial input, required validation, secret reveal and blank-value semantics. Do not blindly convert these to numeric state. |
| Shared feedback: [ui.tsx](../../apps/shell/src/app/shell/ui.tsx) | **Alert, Empty, Checkbox**, and consistent **Badge** variants behind existing helpers. Removes repeated custom markup. | First / M | StatusBadge's lifecycle/health precedence; feedback severity, action callbacks, and accessible labels. A green badge must not hide an unhealthy running app. |
| Mounts: [settings](../../apps/shell/src/app/shell/pages/settings-mounts-section.tsx), [application selection](../../apps/shell/src/app/shell/pages/shared-mount-apps-dialog.tsx) | **Field + Native Select + Checkbox**; optional **Item** rows for application selection. | First / M | Read/write binding meaning, existing selections, stale-binding conflicts, busy states, and expansion. |
| Users: [user management](../../apps/shell/src/app/shell/pages/user-management-page.tsx) | **Field, Checkbox, Native Select**, and **Alert Dialog** for destructive confirmation. Existing Table can remain. | First / M | Role/TTL values, access selection, exact destructive-action meaning, failure and retry. |
| Access tokens and OAuth: [token settings](../../apps/shell/src/app/shell/pages/settings-tokens-section.tsx), [consent](../../apps/shell/src/app/oauth/consent/consent-client.tsx) | **Frame, Field, Checkbox, Native Select, Alert** for credential groups and permission rows. | First / M | Scope identifiers, required read scope, explicit Approve/Deny, request expiry, CSRF handling, and redirect behavior. |
| Ingress: [section](../../apps/shell/src/app/shell/pages/settings-ingress-section.tsx), [port reassignment](../../apps/shell/src/app/shell/pages/port-reassign-control.tsx) | **Frame + Field + Input Group + Alert** across origin, Cloudflare, diagnostics, and port controls. | First / M | Existing validation, pending operations, connection state, and server-confirmed outcomes. |
| Right-panel tabs: [ShellRightPanel](../../apps/shell/src/app/shell/surfaces/shell-right-panel.tsx) | Controlled **Tabs** in place of hand-built tab roles, giving a standard keyboard interaction model. | First / M | Active key, attention indicators, unavailable panels, and embedded frame lifetime. Choose activation behavior deliberately to avoid loading panels on every arrow key. |
| Dashboard: [DashboardPage](../../apps/shell/src/app/shell/pages/dashboard-page.tsx) | **Input Group** for search and shared status variants now. **Data Grid** only if sorting, column controls, or virtualization become requirements. | First / S for toolbar; Later / L for grid | Separate aligned Core/app tables, service expansion, permission-gated actions, live updates, and row identity. Counts already use accessible pressed Buttons; a Filters builder adds no clear value. |
| Available apps: [AvailableAppsPage](../../apps/shell/src/app/shell/pages/available-apps-page.tsx) | Existing **Card** plus **Empty/Skeleton** for catalog and loading states. | Later / S | Launch targets, availability, and actionable errors. No need to introduce a new card system solely for branding. |
| App details and confirmations: [dialog](../../apps/shell/src/app/shell/dialogs/app-details-dialog.tsx), [operation handlers](../../apps/shell/src/app/shell-client.tsx) | **Field/Native Select/Checkbox** inside existing Dialog; **Alert Dialog** for selected `window.confirm` flows. | Later / M | Async cancellation, destructive labels, operation progress, backup/source/settings contracts. Preserve the local Dialog API, including its body wrapper. |
| Sidebar: [ShellSidebar](../../apps/shell/src/app/shell/sidebar/shell-sidebar.tsx), [settings navigation](../../apps/shell/src/app/shell/sidebar/settings-navigation.tsx) | Free **Sidebar/Collapsible** patterns can standardize parts of navigation. Full replacement has limited initial benefit. | Later / L | Authorized dynamic app pages, compact flyouts, mobile drawer, persisted expansion, and current left edge toggle. Keep top toggles and the right panel's plain resize boundary. |
| Notifications and source files: [notification bell](../../apps/shell/src/app/shell/notifications/notification-bell.tsx), [source changes](../../apps/shell/src/app/shell/source/source-changes.tsx) | **Item** for notification rows; **Tree** only if hierarchical file navigation is needed. | Later / M | Read actions, event/poll refresh, file selection, loading/error states, and existing path validation. |
| Diff, logs, embedded applications: [diff viewer](../../apps/shell/src/app/shell/source/source-diff-view.tsx), [Core logs](../../apps/shell/src/app/shell/dialogs/core-logs-dialog.tsx), [embedded frame](../../apps/shell/src/app/shell/embedding/embedded-app-frame.tsx) | Keep specialized renderers and lifecycle code; shared Alert/Empty can wrap their states. | Keep | `@pierre/diffs` is not replaced by Code Block. Streaming logs do not automatically benefit from syntax highlighting. Frame identity/authentication/sandbox rules remain Hosty logic. |

## AI Gateway opportunities

| Surface and source | Candidate and benefit | Priority / effort | Behavior to preserve |
| --- | --- | --- | --- |
| MCP application settings: [McpAccess](../../apps/ai-gateway/web/src/components/mcp-access.tsx), [ProviderRow](../../apps/ai-gateway/web/src/components/provider-row.tsx) | **Frame** around access, approvals, and instructions; keep existing **Field, Select, Switch**. Optional **Item** application rows. | First / M | Per-application access and approval policies, harness capability differences, save/error state, unavailable apps, and exact skill approval content. No global autonomy control implied by this visual change. |
| Settings container: [GatewaySettings](../../apps/ai-gateway/web/src/components/gateway-settings.tsx) | **Frame** for consistent section composition; **Skeleton** for initial loading if useful. Existing Tabs/Field/Textarea/Alert already fit. | First / S | Force-mounted hidden tab contents retain drafts; prompt save/reset behavior stays explicit. |
| Providers: [AgentProviders](../../apps/ai-gateway/web/src/components/agent-providers.tsx) | **Frame + Item** for provider rows, default marker, descriptions, and actions. Existing Dialog and inputs remain. | First / M | Default selection, revision conflicts, credential handling, connection state, edit/add/delete, and authentication polling. |
| Session provider: [SessionProvider](../../apps/ai-gateway/web/src/components/session-provider.tsx) | **Native Select + Checkbox + Field** around the existing choice and confirmation. | First / S | Explicit selection action, provider locking and connection revision. Styling must not turn selection into implicit reconnection. |
| Provider login: [ProviderLoginDialog](../../apps/ai-gateway/web/src/components/provider-login-dialog.tsx) | **Input Group** for the displayed code and Copy action, consistent feedback/spinner. | Later / S | Code is shown for entry on another site: **Input OTP is not the right control**. Keep cancel, expiry, polling, and copy failure behavior. |
| Conversation list: [SessionList](../../apps/ai-gateway/web/src/components/session-list.tsx) | **Item + Input + Button + Badge** for consistent rows and inline editing. | Later / M | Stable session identity, attention ordering, Enter/Escape/blur behavior, guarded deletion, and separate action targets without nested buttons. |
| Transcript messages: [Transcript](../../apps/ai-gateway/web/src/components/transcript.tsx) | Optional **Message/Bubble/Marker** for user/assistant/note presentation. | Later / M | Event order, streaming/replay identity, plain-text user messages, markdown URL policy, and stable scroll anchors. This is a presentation adapter, not a replacement transcript engine. |
| Approval, questions, and tool activity: [Transcript](../../apps/ai-gateway/web/src/components/transcript.tsx) | Existing **Card, Field, Checkbox, Radio Group, Collapsible** already provide a suitable foundation. Shared badges/spacing are enough initially. | Keep | Explicit decisions, denial reasons, required answers, duplicate-submit prevention, accepted-versus-confirmed state, retry drafts, and replay. Do not substitute a generic questionnaire workflow. |
| Context picker: [AppContextPicker](../../apps/ai-gateway/web/src/components/app-context-picker.tsx) | Optional **Input Group + Item** within existing Popover. | Later / S | Server search/paging, 16-app cap, conflict recovery, unavailable selections, and context application to the next message. Avoid accidental extra client filtering. |
| Feedback: [status.tsx](../../apps/ai-gateway/web/src/components/status.tsx) | Align custom wrappers with existing **Alert/Badge** and semantic theme tokens. | First / S | Distinguish idle, running, waiting, failed, and disconnected states; retain actionable errors. |
| Composer, scrolling, attachments, code: [assistant](../../apps/ai-gateway/web/src/app/assistant/page.tsx), [attachment adapter](../../apps/ai-gateway/web/src/components/chat-attachment.tsx), [Code Block adapter](../../apps/ai-gateway/web/src/components/chat-code-block.tsx) | Already integrated **Input Group, Message Scroller, Attachment, ReUI Code Block**. | Keep | IME and send shortcuts, scroll follow/pause, upload-on-Send, retry without duplicate uploads, local preview cleanup, exact copy, and compatibility patches. Generic File Upload would not replace these transport semantics. |

The optional chat presentation APIs are documented upstream as [Message](https://ui.shadcn.com/docs/components/radix/message), [Bubble](https://ui.shadcn.com/docs/components/radix/bubble), and [Marker](https://ui.shadcn.com/docs/components/radix/marker). Their presence is not evidence that Hosty's custom streaming and interaction model can be removed.

## Integration findings that affect the choice

### Registry selection is not a wholesale preset migration

ReUI distributes editable local source through the shadcn registry; `@reui` is a registry namespace. Its [registry documentation](https://reui.io/docs/registry) distinguishes styles and dependency installation. Gateway's explicit `radix-vega` URL is the appropriate starting point for this audit. Shell can use the same explicit mapping if adoption proceeds. Do not substitute the existing `new-york` value into a ReUI `{style}` URL or reinitialize either application to adopt a preset.

Add new components selectively and inspect generated diffs. Existing Button, Dialog, Input Group, Code Block, and scroll components have local behavior or compatibility adjustments. An overwrite can erase those changes even if the new files have familiar names.

### The current Radix registry contains Base UI dependencies

Read-only `shadcn view` inspection on the audit date returned the following for `radix-vega`:

| Item | Observed dependencies and scope | Consequence |
| --- | --- | --- |
| `@reui/frame` | One source file; `class-variance-authority`, `cn` | Small first candidate. Review utility import compatibility. |
| `@reui/number-field` | `@base-ui/react`; source imports its Number Field primitive | Not a pure Radix addition. Keep native numeric inputs initially, especially where empty/string drafts matter. |
| `@reui/data-grid` | 12 source files; Base UI, TanStack table/virtual, DnD Kit, and supporting registry items; scroll-area source imports Base UI | A deliberate table architecture change, not a cosmetic Table replacement. |
| `@reui/filters` | 14 source files, `date-fns`, and a broad supporting registry graph | Excessive for the current dashboard's text search and single state filter. |

Direct registry evidence: [Frame](https://reui.io/r/radix-vega/frame.json), [Number Field](https://reui.io/r/radix-vega/number-field.json), [Data Grid](https://reui.io/r/radix-vega/data-grid.json), and [Filters](https://reui.io/r/radix-vega/filters.json). These endpoints are mutable; the findings describe the retrieved versions, not a permanent guarantee about ReUI.

Some raw registry files reference an icon placeholder path. Because this review used `view`, not `add`, the final CLI import transformation is unverified; this is an installation check, not a confirmed defect. Likewise, the registry's `cn` package should be reconciled with each app's existing helper rather than introducing conflicting class-merging conventions.

### Tokens and interaction contracts matter more than component count

Keep the current theme initially. Adopt semantic feedback tokens consistently in both applications before depending on new status variants, including dark-mode contrast. Frame spacing and radii should match Hosty density; free example dimensions are not product requirements.

A custom `<select>` or checkbox is a good candidate only where native behavior, labels, keyboard access, and submission semantics remain intact. A hidden file input is intentional platform integration, not visual debt. Markdown tables represent message content and do not need Data Grid.

## Recommended adoption order

1. **Settings pilot in both applications.** Add Frame selectively, reuse Gateway's existing fields, and introduce Field/Input Group in Shell's shared setting controls. Start with MCP access/provider settings and Core settings to establish spacing, grouping, and responsive behavior.
2. **Form and feedback consistency.** Adapt Shell's native selects/checkboxes, alerts, empty states, and selected confirmations. Align Gateway's status wrappers. Standardize the right-panel tab keyboard behavior while preserving mounted surfaces.
3. **Lists and selected chat presentation.** Evaluate Item for providers and sessions after the settings pilot establishes the visual rules. Message/Bubble/Marker are optional; current chat foundations already use suitable free components.
4. **Separate decisions for larger interaction changes.** Consider Data Grid, full Sidebar replacement, or Number Field only against concrete requirements and dependency acceptance. They are not necessary to achieve the requested settings appearance.

This order is an audit recommendation, not approved implementation scope. Any adopted non-trivial work belongs in the owning feature's plan before implementation. Relevant current feature contracts include [AI Gateway](../features/ai-gateway/feature.md), [providers](../features/ai-gateway-providers/feature.md), [chat UI](../features/ai-gateway-chat-ui/feature.md), [app UI surfaces](../features/app-ui-surfaces/feature.md), and [panel resizing](../features/shell-panel-resize/feature.md).

No current use case in the audited screens justifies adding Calendar, Gantt, Kanban, Rating, or Phone Input. Charts need actual telemetry requirements. Shell's SDK-provided installation UI and Core-hosted login are separate ownership scopes; changing Shell components does not migrate them.

## Verification and limits

Audit evidence collected:

- Read both applications' component configuration, local primitives, relevant screen compositions, theme tokens, and existing chat component documentation.
- Ran read-only `npx --yes shadcn@latest info --json` in Gateway's web directory.
- Ran `npx --yes shadcn@latest view @reui/frame @reui/number-field @reui/data-grid @reui/filters` against its configured registry; command completed successfully. No `add` or overwrite was performed.
- Queried registry search for Frame and upstream component documentation; inspected the public free-source license and selected APIs.
- Validated local report links, documentation index, and patch whitespace after writing the report.

Application builds and tests were not run for this documentation-only audit. No dependency was installed into either application and no migration was executed, so runtime compatibility, bundle-size effects, and visual fit of proposed components remain unverified.

For an implementation, verification should match the changed behavior: settings draft/save/reset and secret handling; keyboard/focus and dark/narrow layouts; provider and access capability differences; panel persistence and iframe identity; chat streaming, scroll position, approval retry, and attachment retries if those areas change. Existing application test/lint/build commands and an authenticated Core-managed Shell/Gateway smoke check are necessary for those changes. Standalone component previews alone do not establish embedded Hosty behavior.
