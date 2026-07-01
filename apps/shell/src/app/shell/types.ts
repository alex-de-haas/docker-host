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
  mounts?: CoreMountSlot[];
  // Compiled-artifact pull/lock policy ("pinned"/"rolling") and per-service run-locks (the locked
  // image digest). Optional for backwards compatibility with older Core builds. See digest pinning.
  updatePolicy?: string | null;
  artifactLocks?: Record<string, CoreArtifactLock> | null;
  // True when the selected runtime runs live from the operator's own source folder (a source-kind
  // runtime, localCommand in v1): the manifest is adopted on restart, so there is no reviewed-update
  // path and the Update affordance is hidden in favour of a "Live" badge. Optional for backwards
  // compatibility with older Core builds. See runtime-app-marketplace.md ("Live source").
  live?: boolean | null;
  // Set when the live source folder manifest was invalid on the last start and Core kept the last-good
  // copy running; surfaced as a non-blocking warning. Null when valid or not a live source app.
  manifestError?: string | null;
  // Contract deltas (version/capabilities/mounts/...) a live source app adopted at its last start,
  // surfaced as an informational "adopted" breadcrumb. Null/empty when nothing changed.
  liveChanges?: string[] | null;
  // True when the app can run from a local source folder (non-URL install with a localCommand runtime
  // profile); gates the settings "Source" tab. sourceOverridePath is the operator-set override folder
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
};

export type CoreRuntimeProfile = {
  key: string;
  type: string;
  default: boolean;
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
export type DetailView = "backups" | "settings" | "update" | "remove";

// Tabs inside the consolidated Settings dialog. Hidden when the app has no matching data.
export type SettingsTab = "app" | "publicOrigins" | "mounts" | "source";
export type ShellView =
  | "available-apps"
  | "dashboard"
  | "installed-apps"
  | "users"
  | "obs-metrics"
  | "obs-console"
  | "obs-logs";
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
