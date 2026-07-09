export type CoreStatus = {
  status: string;
  component: string;
  version?: string;
  dataRoot: string;
  listenUrl: string;
  corePublicOrigin?: string | null;
  shellPublicOrigin?: string | null;
  runtimePublicHost?: string | null;
  warnings?: string[];
  serverTime: string;
};

export type CoreSetting = {
  key: string;
  type: string;
  value?: string | null;
  secret: boolean;
  required?: boolean;
  label?: string | null;
  description?: string | null;
};

export type CoreEndpoint = {
  key: string;
  protocol: string;
  url?: string | null;
  public: boolean;
  service?: string | null;
  port?: string | null;
  publicOrigin?: string | null;
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
  // The catalog feed this install follows (catalog-hosted-app-feeds.md A3), for the feed selector and
  // choose-a-feed guidance. Null/absent = no feed set. Optional for older Core builds.
  followedFeedId?: string | null;
  mounts?: CoreMountSlot[];
  // Compiled-artifact pull/lock policy ("pinned"/"rolling") and per-service run-locks (the locked
  // image digest). Optional for backwards compatibility with older Core builds. See digest pinning.
  updatePolicy?: string | null;
  artifactLocks?: Record<string, CoreArtifactLock> | null;
  // True when the selected runtime is a development runtime (a localCommand profile with
  // development: true) running live from the operator's own source folder: the manifest is adopted on
  // restart, so there is no reviewed-update path and the Update affordance is hidden in favour of a
  // "Live" badge. Optional for backwards compatibility with older Core builds. See
  // runtime-artifact-model.md.
  live?: boolean | null;
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
};

export type AppsResponse = {
  apps: CoreApp[];
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

// Observability metrics from GET /api/apps/{id}/metrics: one series per (metric, label set), each a
// rolling window of timestamped points. The Core-collected infra baseline is `container.cpu.percent`
// / `container.memory.bytes` / `container.memory.percent` (labelled by service); apps that export OTLP
// metrics add their own series.
export type MetricPoint = { timestampUnixMs: number; value: number };
export type MetricSeries = { name: string; labels: Record<string, string>; points: MetricPoint[] };
export type AppMetricsResponse = { appId: string; rangeSeconds: number; series: MetricSeries[] };

// Structured OTLP log record from GET /api/apps/{id}/otlp-logs — the OTLP-logs stream, distinct from
// the `docker logs` console tail surfaced by LogsPanel. Carries severity, attributes, and (when the
// app is trace-correlated) trace/span ids.
export type OtlpLogRecord = {
  timestampUnixMs: number;
  severityNumber: number;
  severityText: string;
  body: string;
  attributes: Record<string, string>;
  traceId?: string | null;
  spanId?: string | null;
};
export type AppOtlpLogsResponse = { appId: string; rangeSeconds: number; records: OtlpLogRecord[] };

// Cross-resource OTLP logs from GET /api/observability/logs — the same structured records merged
// across all (or a filtered set of) apps, each tagged with its source app id + display name.
export type FleetOtlpLogRecord = OtlpLogRecord & { appId: string; appName: string };
export type FleetOtlpLogsResponse = { rangeSeconds: number; appCount: number; records: FleetOtlpLogRecord[] };

// Cross-resource traces from GET /api/observability/traces — recent traces (spans grouped by trace
// id across apps) collapsed to summaries, newest first. Timestamps/durations are fractional unix
// milliseconds (OTLP nanos exceed the JS safe-integer range, so Core converts). Root* describe the
// root span when stored (`hasRootSpan`), else the earliest span of a partial trace.
export type TraceAppRef = { appId: string; appName: string };
export type FleetTraceSummary = {
  traceId: string;
  rootName: string;
  rootKind: string;
  rootAppId: string;
  rootAppName: string;
  hasRootSpan: boolean;
  startUnixMs: number;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  apps: TraceAppRef[];
};
export type FleetTracesResponse = { rangeSeconds: number; appCount: number; traces: FleetTraceSummary[] };

// One trace's spans from GET /api/observability/traces/{traceId}, merged across apps and ordered by
// start time (the span-waterfall view). `parentSpanId` is null for the root span.
export type TraceDetailSpan = {
  appId: string;
  appName: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  kind: string;
  startUnixMs: number;
  durationMs: number;
  statusCode: string;
  statusMessage?: string | null;
  attributes: Record<string, string>;
};
export type TraceDetailResponse = {
  traceId: string;
  startUnixMs: number;
  durationMs: number;
  spans: TraceDetailSpan[];
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
  currentVersion?: string | null;
  targetVersion: string;
  currentRuntime?: string | null;
  targetRuntime: string;
  targetRuntimeType: string;
  manifestPath: string;
  currentManifestDigest?: string | null;
  targetManifestDigest: string;
  defaultAutostart?: boolean | null;
  runtimeProfiles?: CoreInstallRuntimeProfile[];
  settings: CoreInstallSetting[];
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
export type ShellView =
  | "available-apps"
  | "dashboard"
  | "installed-apps"
  | "marketplace"
  | "users"
  | "obs-metrics"
  | "obs-logs"
  | "obs-traces";
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

// ---- Marketplace catalog (GET /api/catalog/*) ----------------------------------------------------

export type CatalogPublisher = {
  name?: string | null;
  url?: string | null;
  email?: string | null;
};

export type CatalogAppSummary = {
  id: string;
  name: string;
  summary?: string | null;
  category?: string | null;
  tags: string[];
  icon?: string | null;
  publisher?: CatalogPublisher | null;
  sourceName: string;
  installed: boolean;
  installedVersion?: string | null;
};

// A feed: an author-named pointer at the app's manifest at a moving ref (catalog-hosted-app-feeds.md).
// `default` is normalized by Core (a sole feed reports true), so A4 quick-install just picks the
// default-flagged feed and defers to Details when none is.
export type CatalogAppFeed = {
  id: string;
  // A manifest URL passed straight to the existing install/update flow.
  manifestRef: string;
  default: boolean;
};

export type CatalogAppDetail = {
  id: string;
  name: string;
  summary?: string | null;
  category?: string | null;
  tags: string[];
  icon?: string | null;
  screenshots: string[];
  // Absolute URL to a vendored markdown long-description (manifest-level app assets), or null. Rendered
  // on the detail dialog; relative images inside it resolve against this URL's folder.
  descriptionUrl?: string | null;
  publisher?: CatalogPublisher | null;
  sourceName: string;
  signerIdentity?: string | null;
  // Optional to reflect the wire: an older Core's detail response carries no feeds field, and the raw
  // JSON is cast to this type with no normalization — callers must guard (see selectInstallFeed).
  feeds?: CatalogAppFeed[];
  installed: boolean;
  installedVersion?: string | null;
  // The installed app's recorded feed; null means "no feed set" (pre-feeds install or cleared) and the
  // UI surfaces choose-a-feed guidance instead of an update state.
  followedFeedId?: string | null;
  // Digest-aware: the followed feed head's manifest content differs from the installed copy.
  updateAvailable: boolean;
};

export type CatalogAppsResponse = { apps: CatalogAppSummary[] };

// One operator-configured catalog source (WS7 federation). `name` is derived by Core from the URL host.
export type CatalogSource = {
  url: string;
  name: string;
};

// `managed` is false while the list is still the untouched HOSTY_CATALOG_SOURCES default and true once an
// operator has added/removed a source (the list is then persisted; env changes no longer apply).
export type CatalogSourcesResponse = {
  sources: CatalogSource[];
  managed: boolean;
};

export type CatalogListState = {
  loading: boolean;
  error: string | null;
  apps: CatalogAppSummary[];
};

export type CatalogDetailState = {
  loading: boolean;
  error: string | null;
  app: CatalogAppDetail | null;
};
