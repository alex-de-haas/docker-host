export type CoreStatus = {
  status: string;
  component: string;
  version?: string;
  dataRoot: string;
  listenUrl: string;
  corePublicOrigin?: string | null;
  shellPublicOrigin?: string | null;
  runtimePublicHost?: string | null;
  // Live ingress provider: "none", "cloudflare-remote" (published over Cloudflare's API), or "cloudflared"
  // (a locally managed tunnel whose config Core renders). The anonymous status payload blanks it to "",
  // which reads as ingress off. See ./ingress.ts for the predicates that branch on it.
  ingressProvider?: string | null;
  warnings?: string[];
  serverTime: string;
};

// GET /api/core/update-status — a newer Core binary is available for the selected release channel.
export type CoreUpdateStatus = {
  currentVersion: string;
  updateAvailable: boolean;
  releaseTag: string;
  checkedAt: string;
  error?: string | null;
};

// A choice for a select-typed setting: the stored value and its display label.
export type CoreSettingOption = {
  value: string;
  label: string;
};

export type CoreSetting = {
  key: string;
  type: string;
  value?: string | null;
  secret: boolean;
  // Whether a value is stored. For secrets `value` is always masked to null, so this is the only
  // signal separating "set (shown as Unchanged)" from "never configured".
  hasValue?: boolean;
  required?: boolean;
  label?: string | null;
  description?: string | null;
  // Present for select-typed settings (e.g. the ingress provider); absent for free-form inputs.
  options?: CoreSettingOption[] | null;
};

// "error" means the app is broken; "warning" means it needs attention but may still work.
export type AlertSeverity = "error" | "warning";

// One problem an app has, as derived by collectAppProblems. Rendered both as a severity icon on the
// collapsed row and as an alert in the details panel, from that single derivation.
export type AppProblem = { severity: AlertSeverity; title: string; detail?: string };

// One declared cross-app dependency as Core resolved it against the installed set. `running` is only
// meaningful when `installed`; `endpoints[].resolved` is false for everything while the provider is
// absent. See docs/features/cross-app-dependencies/feature.md.
export type CoreAppDependency = {
  appId: string;
  version?: string | null;
  required: boolean;
  installed: boolean;
  running: boolean;
  endpoints?: CoreAppDependencyEndpoint[];
};

export type CoreAppDependencyEndpoint = { endpointKey: string; alias: string; resolved: boolean };

export type CoreEndpoint = {
  key: string;
  protocol: string;
  url?: string | null;
  public: boolean;
  service?: string | null;
  port?: string | null;
  publicOrigin?: string | null;
  // Install-time port reservations: "assigned" (a durable port target exists but the service is stopped),
  // "running" (the service is up), or "unavailable" (the reserved port failed preflight/binding). Absent on
  // older Core builds, so treat undefined as "no availability information".
  availability?: "assigned" | "running" | "unavailable" | null;
};

// GET /api/core/cloudflare/status — the Cloudflare connection projection (masked token, never raw).
export type CloudflareConnectionStatus = {
  status: "connected" | "disconnected" | "reconnect_required";
  reconnectReason?: string | null;
  token: { present: boolean; tokenId?: string | null; tokenName?: string | null; expiresOn?: string | null; masked?: string | null };
  accountName?: string | null;
  baseDomain?: string | null;
  tunnelName?: string | null;
  connectorStatus?: string | null;
  locality?: string | null;
  connectedAt?: string | null;
};

// GET /api/core/cloudflare/token-template — dashboard URL + the permissions to grant.
export type CloudflareTokenTemplate = { url: string; requiredPermissions: string[] };

// The 409 body from POST /api/core/cloudflare/connect when the token can reach more than one account,
// zone, or tunnel: the candidates, so the operator can answer instead of dead-ending.
export type CloudflareSelectionOption = { id: string; name: string; detail?: string | null };
export type CloudflareSelectionRequired = { kind: "account" | "zone" | "tunnel"; options: CloudflareSelectionOption[] };
export type CloudflareSelectionError = { code: string; message: string; selection: CloudflareSelectionRequired };

// GET /api/apps/{id}/public-origins
export type CloudflarePublicationState = "not_configured" | "active" | "app_stopped" | "restart_required" | "origin_drifted" | "error";
export type CloudflarePublicationSummary = {
  endpointKey: string;
  label: string;
  hostname: string;
  publicOrigin?: string | null;
  ownershipState: string;
  state: CloudflarePublicationState;
};
export type CloudflareAppPublications = { publications: CloudflarePublicationSummary[] };
// POST /api/apps/{id}/public-origins/publish | unpublish
export type CloudflarePublicationResult = {
  appId: string;
  endpointKey: string;
  hostname?: string | null;
  publicOrigin?: string | null;
  restartRequired: boolean;
  // Where the connector was observed to run, checked just before the mutation. "not_local" means the
  // publish succeeded but the address reaches a different machine. Null when nothing was mutated.
  locality?: string | null;
};

// GET /api/core/cloudflare/diagnostics — a read-only comparison of what Hosty believes it published
// against what Cloudflare serves, plus the public endpoints that have no address at all.
export type CloudflareDiagnosticState =
  | "ok"
  | "app_missing"
  | "endpoint_missing"
  | "route_missing"
  | "route_stale"
  | "dns_missing"
  | "dns_foreign"
  // Core's own address only.
  | "not_configured"
  | "external"
  | "unknown";
export type CloudflarePublicationDiagnostic = { appId: string; endpointKey: string; hostname: string; state: CloudflareDiagnosticState };
export type CloudflareUnpublishedEndpoint = { appId: string; displayName: string; endpointKey: string };
// Core's own hostname rides the same tunnel but is not a publication: Core is not an app, so nothing
// creates its route or DNS record. `expectedDnsContent` and `expectedService` are the two objects the
// operator has to create by hand.
export type CloudflareCoreDiagnostic = {
  origin: string;
  hostname: string | null;
  state: CloudflareDiagnosticState;
  expectedDnsContent: string | null;
  expectedService: string;
};
export type CloudflareDiagnostics = {
  checked: boolean;
  publications: CloudflarePublicationDiagnostic[];
  unpublishedEndpoints: CloudflareUnpublishedEndpoint[];
  core: CloudflareCoreDiagnostic;
};

// POST /api/apps/{id}/ports/reassign/plan — preview of reassigning one automatic host port.
export type CoreReassignDependent = { appId: string; running: boolean };
export type CoreReassignPlan = {
  appId: string;
  service: string;
  portKey: string;
  currentPort: number;
  currentUrl?: string | null;
  ownerRunning: boolean;
  affectedDependents: CoreReassignDependent[];
  // True when the current port is an operator pin rather than an automatic assignment, so the dialog
  // opens in the mode the endpoint is actually in.
  pinned: boolean;
  // Lowest port a manual pin may use; below it Core lacks the privileges to bind.
  minManualPort: number;
  digest: string;
};

// POST /api/apps/{id}/ports/reassign — result of applying a reassignment.
export type CoreReassignResult = {
  appId: string;
  service: string;
  portKey: string;
  oldPort: number;
  newPort: number;
  newUrl?: string | null;
  restartRequiredAppIds: string[];
};

export type CoreNavigationItem = {
  label: string;
  path: string;
  entryPath?: string | null;
  embeddedUrl?: string | null;
  // Core-origin-relative URL for this page link's manifest-declared icon (manifest-level app assets),
  // or null when the manifest declares none. Prefix with coreOrigin to load; fall back to a Lucide icon.
  iconUrl?: string | null;
};

export type CoreApp = {
  id: string;
  displayName: string;
  description?: string | null;
  version: string;
  kind: string;
  system: boolean;
  source: string;
  selectedRuntime?: string | null;
  autostart?: boolean | null;
  operationStatus: string;
  runtimeState: string;
  lastOperation?: string | null;
  lastError?: string | null;
  capabilities: string[];
  settings?: CoreSetting[];
  endpoints?: CoreEndpoint[];
  runtimeProfiles?: CoreRuntimeProfile[];
  navigation?: CoreNavigationItem[];
  entryPath?: string | null;
  embeddedUrl?: string | null;
  // Core-origin-relative URLs for the app's manifest-declared display assets (manifest-level app
  // assets): iconUrl for the sidebar/app-card icon, descriptionUrl for a markdown long-description.
  // Null when the manifest declares none; an absolute https icon passes through unchanged. Prefix a
  // relative value with coreOrigin to load. Optional for backwards compatibility with older Core builds.
  iconUrl?: string | null;
  descriptionUrl?: string | null;
  // The app-owned feed this install follows, for the feed selector and choose-a-feed guidance.
  // Null/absent = no feed set. Optional for older Core builds.
  followedFeedId?: string | null;
  mounts?: CoreMountSlot[];
  // Compiled-artifact pull/lock policy (always "pinned"; the "rolling" opt-out was removed) and
  // per-service run-locks (the locked image digest). Optional for older Core builds. See digest pinning.
  updatePolicy?: string | null;
  artifactLocks?: Record<string, CoreArtifactLock> | null;
  // True when the selected runtime is a development runtime (a localCommand profile with
  // development: true) running live from the operator's own source folder: the manifest is adopted on
  // restart, so there is no reviewed-update path and the Update affordance is hidden in favour of a
  // "Live" badge. Optional for backwards compatibility with older Core builds. See
  // runtime-artifact-model.md.
  live?: boolean | null;
  // Last-known update verdict from the Core fleet check (plan-first updates); null until a check has
  // run for this app. Drives the row Update/Review affordances. Optional for backwards compatibility.
  updateCheck?: AppUpdateAvailability | null;
  // Declared cross-app dependencies with their state resolved against the installed set. Core reports
  // state only — whether a given state is a problem is decided here, in collectAppProblems. Null/absent
  // when the app declares none, or when talking to an older Core that predates the projection.
  dependencies?: CoreAppDependency[] | null;
  // Set when the live source folder manifest was invalid on the last start and Core kept the last-good
  // copy running; surfaced as a non-blocking warning. Null when valid or not a live source app.
  manifestError?: string | null;
  // Contract deltas (version/capabilities/mounts/...) a live source app adopted at its last start,
  // surfaced as an informational "adopted" breadcrumb. Null/empty when nothing changed.
  liveChanges?: string[] | null;
  // True when the app can run from a local source folder (non-URL install that declares a development
  // runtime — a localCommand profile with development: true); gates the settings "Source" tab. A
  // non-development localCommand runtime does not qualify. sourceOverridePath is the operator-set folder
  // (null = using the standard Hosty-managed source); sourceManagedPath is the Hosty-managed checkout
  // folder for display. Optional for backwards compatibility with older Core builds.
  supportsSource?: boolean | null;
  sourceOverridePath?: string | null;
  sourceManagedPath?: string | null;
  // The folder a live source app actually runs from (override folder, else the original folder
  // install); shown in the "Live" badge tooltip. Null when the app is not running live from source.
  sourceLivePath?: string | null;
  // Platform interfaces the app exposes (manifest `interfaces`, e.g. "ai-gateway"), each declaration
  // resolved to a ready-to-call URL where possible. Shell gates the assistant surface on a running
  // app declaring "ai-gateway". Null/absent when none are declared or the Core build predates them.
  interfaces?: Record<string, CoreAppInterface[]> | null;
};

export type CoreAppInterface = {
  key: string;
  path: string;
  url?: string | null;
};

export type CoreArtifactLock = {
  kind: string;
  imageDigest?: string | null;
  resolvedFromRef?: string | null;
  bundleHash?: string | null;
  commit?: string | null;
  resolvedAt: string;
};

export type CoreMountBinding = {
  label: string;
  hostPath: string;
  containerPath: string;
  // "global" (resolved from a shared-mounts library entry) or "local" (inline host path).
  source?: string;
  globalMountName?: string | null;
};

export type CoreMountSlot = {
  key: string;
  mode: string;
  multiple: boolean;
  required: boolean;
  service?: string | null;
  bindings: CoreMountBinding[];
};

// A global binding sends only key + globalMountName; a local binding sends key + label + hostPath.
export type MountBindingInput = {
  key: string;
  label?: string;
  hostPath?: string;
  globalMountName?: string;
};

// Host-level shared-mounts library entry (GET /api/global-mounts).
export type CoreGlobalMount = {
  name: string;
  hostPath: string;
  mode: string;
  description?: string | null;
  usedBy: number;
  // Advisory: registration accepts a path on a drive that is not attached yet, so this flags a path
  // that would fail the start gate. Optional for older Core builds that do not send it.
  hostPathExists?: boolean;
};

export type AppsResponse = {
  apps: CoreApp[];
  // Fleet update-check status (plan-first updates): drives the header "Check updates" spinner from
  // server state, so a page opened mid-sweep (or after a reload) shows the check in progress.
  updateCheck?: AppUpdateCheckStatus | null;
};

// Last-known update verdict for one app, written by the Core fleet check (and by any successful plan
// build), cleared by a successful apply. `planDigest` names the cached pending plan a one-click
// apply consumes; `error` means the latest check failed for this app.
export type AppUpdateAvailability = {
  updateAvailable: boolean;
  requiresReview: boolean;
  planDigest?: string | null;
  checkedAt: string;
  error?: string | null;
};

export type AppUpdateCheckStatus = {
  running: boolean;
  lastCompletedAt?: string | null;
};

// Response of GET /api/apps/{id}/update/plan: the cached pending plan, or null when nothing is
// pending (never built, expired, or consumed by an apply).
export type AppPendingUpdatePlanResponse = {
  plan: CoreUpdatePlan | null;
};

// What removing an app would affect, from GET /api/apps/{id}/remove-impact. Advisory only: Core never
// refuses a removal, and an app nothing declares against reports empty lists.
// See docs/features/removable-system-apps/.
export type CoreRemovalImpact = {
  appId: string;
  displayName: string;
  system: boolean;
  dependents: CoreRemovalDependent[];
  capabilities: CoreRemovalCapabilityImpact[];
  // Hosty-published hostnames that removal takes offline.
  publicOrigins: CoreRemovalPublicOrigin[];
};

// One published hostname the removal takes down. An "adopted" record keeps its DNS entry — Hosty manages
// it but did not create it.
export type CoreRemovalPublicOrigin = { endpointKey: string; hostname: string; ownershipState: string };

// An installed app that declares a cross-app dependency on the one being removed. A running dependent
// keeps its wired HOSTY_DEPENDENCY_* values until it restarts, so the loss lands at its next start.
export type CoreRemovalDependent = {
  appId: string;
  displayName: string;
  runtimeState: string;
  required: boolean;
  aliases: string[];
};

export type CoreRemovalCapabilityImpact = {
  slot: string;
  consumers: CoreRemovalConsumer[];
};

export type CoreRemovalConsumer = {
  appId: string;
  displayName: string;
  runtimeState: string;
};

// Core's own behavior settings (auth session/grant lifetimes for now), served in the same shape as
// per-app settings so the platform panel renders them with the shared settings form. Reuses the shared
// field types from CoreSetting; `value` is the current effective value; `default` is the built-in
// fallback; `group` clusters related keys; `overridden` marks a persisted override (so the UI can reset).
export type CoreSettingItem = Pick<CoreSetting, "key" | "type" | "label" | "description" | "options"> & {
  value: string;
  default: string;
  group: string;
  overridden: boolean;
  // Display unit appended after value/default (e.g. "h" for hours), or absent for none.
  unit?: string | null;
};

export type CoreSettingsState = {
  settings: CoreSettingItem[];
};

export type CoreBackup = {
  appId: string;
  backupId: string;
  reason: string;
  createdAt: string;
  dataPath: string;
  archivePath: string;
  archiveSha256: string;
  archiveSize: number;
  fileCount: number;
  retention?: CoreBackupRetentionStatus | null;
};

export type BackupsResponse = {
  backups: CoreBackup[];
};

// Returned on a Development-Mode disable that Core judged risky: the app ran a different version live
// than the reviewed baseline, so its data may have been migrated one-way. Core leaves the app stopped
// and hands back the pre-development-mode snapshot to offer for rollback. See ConfigureDevelopmentModeAsync.
export type CoreDevelopmentModeRestoreHint = {
  recommended: boolean;
  runtime: string;
  backupId?: string | null;
  baselineVersion: string;
  currentVersion: string;
};

export type CoreAppLifecycleResult = {
  status?: string;
  developmentModeRestore?: CoreDevelopmentModeRestoreHint | null;
};

export type CoreBackupRetentionStatus = {
  eligible: boolean;
  reason: string;
  wouldDeleteInCurrentPlan: boolean;
};

export type CoreBackupCleanupCandidate = {
  appId: string;
  backupId: string;
  reason: string;
  cleanupReason: string;
  createdAt: string;
  archivePath?: string | null;
  metadataPath?: string | null;
  archiveSha256?: string | null;
  archiveSize?: number | null;
  automatic: boolean;
};

export type CoreBackupCleanupPlan = {
  appId?: string | null;
  planDigest: string;
  createdAt: string;
  candidates: CoreBackupCleanupCandidate[];
};

export type CoreBackupCleanupApplyResponse = {
  planDigest: string;
  deleted: CoreBackupCleanupCandidate[];
  skipped: CoreBackupCleanupCandidate[];
};

export type LogsServiceSegment = {
  service: string;
  text: string;
};

export type LogsResponse = {
  appId: string;
  text: string;
  services?: LogsServiceSegment[];
};

export type CoreRuntimeServiceHealth = {
  service: string;
  status: string;
  processId?: number | null;
  exitCode?: number | null;
  logPath?: string | null;
  workingDirectory?: string | null;
  message?: string | null;
  // The image the container is actually running (`repository@sha256:...`), used to surface
  // "running != lock" drift. Null for runtimes without an image (localCommand) or when unknown.
  image?: string | null;
  // Container HEALTHCHECK result ("healthy"/"unhealthy"/"starting"), or null when the runtime has no
  // health probe (localCommand) or the image declares no HEALTHCHECK. Distinct from `status`, which
  // is pure liveness (running/stopped).
  health?: string | null;
  // Times the runtime has restarted this service (docker RestartCount), or null when unavailable.
  restartCount?: number | null;
  // RFC3339 start timestamp of the current run, or null when not started.
  startedAt?: string | null;
};

export type AppHealthResponse = {
  appId: string;
  runtime: string;
  runtimeType: string;
  status: string;
  services: CoreRuntimeServiceHealth[];
};

export type AppServiceUpdateStatus = {
  service: string;
  lockedDigest?: string | null;
  candidateDigest?: string | null;
  updateAvailable: boolean;
  unknown: boolean;
};

// Read-only update-available report from GET /api/apps/{id}/update-status.
export type AppUpdateStatusResponse = {
  appId: string;
  runtime: string;
  runtimeType: string;
  updatePolicy: string;
  updateAvailable: boolean;
  services: AppServiceUpdateStatus[];
};

export type UpdateStatusState = {
  loading: boolean;
  error: string | null;
  status: AppUpdateStatusResponse | null;
};

export type CoreUpdatePlan = {
  appId: string;
  currentVersion: string;
  targetVersion: string;
  currentRuntime?: string | null;
  targetRuntime: string;
  manifestPath: string;
  manifestDigest: string;
  planDigest: string;
  willCreatePreUpdateBackup: boolean;
  changes: string[];
  // False when no external source is configured and Recheck could only read Core's internal copy,
  // so an empty `changes` list does not mean the app is up to date. Optional for backwards compatibility
  // with older Core builds that omit the field.
  sourceConfigured?: boolean;
  // True when the change list carries anything beyond routine version/manifest/artifact/image-tag
  // movement, so the plan must be reviewed by a human instead of applied silently. Optional for
  // backwards compatibility with older Core builds.
  requiresReview?: boolean;
};

export type CoreRuntimeSwitchPlan = {
  appId: string;
  currentRuntime?: string | null;
  targetRuntime: string;
  targetRuntimeType: string;
  planDigest: string;
  automaticBackup: boolean;
  changes: string[];
};

export type CoreInstallSetting = {
  key: string;
  type: string;
  defaultValue?: string | null;
  secret: boolean;
  required?: boolean;
  label?: string | null;
  description?: string | null;
  options?: CoreSettingOption[] | null;
};

export type CoreRuntimeProfile = {
  key: string;
  type: string;
  default: boolean;
  // The manifest author's declared default for Development Mode on this runtime (the intent marker).
  // Optional for backwards compatibility with older Core builds. See runtime-artifact-model.md.
  development?: boolean;
  // The effective Development Mode after the operator's per-runtime toggle is applied (override else the
  // `development` default; false for a non-source runtime). This is what actually governs liveness — ON
  // runs the runtime live from source, OFF runs it locked/reviewed — so the Live/Locked badge and the
  // toggle switch read from it. Optional for older Core builds (fall back to `development`).
  developmentMode?: boolean;
};

export type CoreInstallRuntimeProfile = CoreRuntimeProfile;

export type CoreInstallPlan = {
  appId: string;
  displayName: string;
  description?: string | null;
  action: string;
  // Single-use handle echoed back on apply so Core installs exactly the reviewed manifest bytes.
  // Absent on the plan embedded in a feed-install flow (that flow binds by plan digest).
  planId?: string | null;
  currentVersion?: string | null;
  targetVersion: string;
  currentRuntime?: string | null;
  targetRuntime: string;
  targetRuntimeType: string;
  manifestPath: string;
  currentManifestDigest?: string | null;
  targetManifestDigest: string;
  defaultAutostart?: boolean | null;
  // True when this install produces a system app (manifest role: system). Surfaced in review so the
  // escalation is visible before the operator confirms — a system app is admin-only and hidden from
  // ordinary users.
  system?: boolean | null;
  runtimeProfiles?: CoreInstallRuntimeProfile[];
  settings: CoreInstallSetting[];
};

// Reviewed feed install envelope from POST /api/apps/install/feed/plan. Core owns feed resolution and
// binds apply to planDigest; Shell renders the nested ordinary install plan and returns the envelope's
// source selection + digest on apply.
export type CoreFeedInstallPlan = {
  install: CoreInstallPlan;
  feedsUrl: string;
  feedId: string;
  manifestUrl: string;
  feedDocumentDigest: string;
  planDigest: string;
};

export type CoreAppFeed = {
  id: string;
  manifestRef: string;
  default: boolean;
};

export type CoreAppFeedsResponse = {
  feedsUrl?: string | null;
  followedFeedId?: string | null;
  feeds: CoreAppFeed[];
};

export type CoreError = {
  code?: string;
  message?: string;
};

export type AppAction = "start" | "stop" | "restart" | "backup";
// "logs" is the per-app console-logs (docker logs) dialog, opened from the Installed Apps actions menu
// — distinct from the structured OTLP-logs stream in the Observability section.
export type DetailView = "backups" | "settings" | "update" | "remove" | "logs";

// Tabs inside the consolidated Settings dialog. Hidden when the app has no matching data.
export type SettingsTab = "app" | "publicOrigins" | "mounts" | "source";
// Three top-level destinations: the host you manage, the host you configure, and the apps you use.
// `installed-apps` and `users` were folded into `dashboard` and `settings`; their URLs still resolve
// and are canonicalized by the client.
export type ShellView =
  | "available-apps"
  | "dashboard"
  | "settings";

// Host-level configuration surfaces, addressable as /settings?tab=<value>. Distinct from the per-app
// `SettingsTab` above, which describes one app rather than the host.
export type HostSettingsTab = "users" | "tokens" | "core" | "mounts" | "ingress";

// A device waiting for someone to approve the code it is showing. Held in memory by Core and gone ten
// minutes later, so this is never a durable record of anything.
export type DeviceAuthorizationRequestView = {
  userCode: string;
  label: string | null;
  createdAt: string;
  expiresInSeconds: number;
};

// A credential belonging to a client with no browser. `id` is a fingerprint, never the credential
// itself — the value exists in the response to its own creation and nowhere else.
export type AccessTokenView = {
  id: string;
  kind: "device" | "manual";
  label: string | null;
  userId: string;
  userDisplayName: string | null;
  createdAt: string;
  lastSeenAt: string;
};
export type AppOpenTarget = "workspace" | "tab";
export type HostyResolvedTheme = "light" | "dark";
export type HostyThemePreference = "light" | "dark" | "system";
export type WorkspaceRoute = {
  appId: string;
  path: string;
};
export type ShellRouteState = {
  view: ShellView;
  workspace: WorkspaceRoute | null;
  // Always resolved, so no consumer has to repeat the default. Only read while `view` is
  // "settings"; carried on every route so a link into Settings can name its tab from anywhere.
  settingsTab: HostSettingsTab;
};
export type ShellSearchParams = {
  get(name: string): string | null;
};

export type SessionResponse = {
  authenticated: boolean;
  user?: {
    id: string;
    email: string | null;
    displayName: string | null;
    role: string;
    disabled: boolean;
  } | null;
};

export type AppLaunchResponse = {
  code: string;
  redirectUri: string;
  expiresAt: string;
};

export type HostUserSummary = {
  id: string;
  email?: string | null;
  displayName?: string | null;
  role: "host.admin" | "host.user";
  authProvider?: string | null;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  activeSessionCount: number;
  assignedAppIds: string[];
  lastSeenAt?: string | null;
};

export type UserInvitationSummary = {
  id: string;
  email: string;
  displayName?: string | null;
  role: "host.admin" | "host.user";
  assignedAppIds: string[];
  createdByUserId?: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt?: string | null;
  revokedAt?: string | null;
  status: "pending" | "expired" | "used" | "revoked";
};

export type AssignableAppSummary = {
  id: string;
  name: string;
  version: string;
  operationStatus: string;
};

export type InviteTtlOption = {
  label: string;
  ttlMs: number;
};

export type UserManagementResponse = {
  users: HostUserSummary[];
  invitations: UserInvitationSummary[];
  apps?: AssignableAppSummary[];
  inviteTtlOptions: InviteTtlOption[];
};

export type LoadState = {
  loading: boolean;
  error: string | null;
  status: CoreStatus | null;
  apps: CoreApp[];
  session: SessionResponse | null;
  updatedAt: string | null;
  // Fleet update-check status from the last apps load (plan-first updates).
  updateCheck?: AppUpdateCheckStatus | null;
};

export type DetailPanelState = {
  loading: boolean;
  error: string | null;
  backups: CoreBackup[] | null;
  backupCleanupPlan: CoreBackupCleanupPlan | null;
  updatePlan: CoreUpdatePlan | null;
};

export type InstallPanelState = {
  loading: boolean;
  error: string | null;
  plan: CoreInstallPlan | null;
  feedPlan: CoreFeedInstallPlan | null;
};

export type ActivePanel = {
  appId: string;
  view: DetailView;
  settingsTab?: SettingsTab;
};

export type OpenPanelOptions = {
  settingsTab?: SettingsTab;
};

export type OpenAppPanel = (app: CoreApp, view: DetailView, options?: OpenPanelOptions) => void;

export type RemoveOptions = {
  deleteData: boolean;
  deleteBackups: boolean;
  deleteSource: boolean;
  ignoreRuntimeErrors: boolean;
};

export type AppPageLink = {
  label: string;
  path: string;
  redirectUri: string;
  // Core-origin-relative icon URL for this page link, or null to fall back to a Lucide icon.
  iconUrl?: string | null;
};

export type EmbeddedWorkspace = {
  appId: string;
  title: string;
  pageLabel: string;
  path: string;
  src: string;
  externalUrl: string;
};

export type RuntimeHealthState = {
  loading: boolean;
  error: string | null;
  health: AppHealthResponse | null;
};

export type RuntimeServiceRow = {
  service: string;
  status: string;
  message?: string | null;
  endpoints: CoreEndpoint[];
};

export type NotificationSource = {
  kind: string;
  appId: string | null;
};

// Named ShellNotification to avoid shadowing the DOM `Notification` global.
export type ShellNotification = {
  id: string;
  source: NotificationSource;
  audience: string;
  level: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  read: boolean;
  readAt: string | null;
};

export type NotificationsResponse = {
  notifications: ShellNotification[];
  unreadCount: number;
  pagination: { limit: number; offset: number; total: number };
  updatedAt: string;
};

export type NotificationMarkReadResponse = {
  updated: number;
  unreadCount: number;
};
