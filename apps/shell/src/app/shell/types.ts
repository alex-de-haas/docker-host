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
  selectedChannel?: string | null;
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
};

export type CoreMountBinding = {
  label: string;
  hostPath: string;
  containerPath: string;
};

export type CoreMountSlot = {
  key: string;
  mode: string;
  multiple: boolean;
  required: boolean;
  service?: string | null;
  bindings: CoreMountBinding[];
};

export type MountBindingInput = {
  key: string;
  label: string;
  hostPath: string;
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
};

export type AppHealthResponse = {
  appId: string;
  runtime: string;
  runtimeType: string;
  status: string;
  services: CoreRuntimeServiceHealth[];
};

export type CoreUpdatePlan = {
  appId: string;
  currentVersion: string;
  targetVersion: string;
  currentRuntime?: string | null;
  targetRuntime: string;
  targetChannel?: string | null;
  manifestPath: string;
  manifestDigest: string;
  planDigest: string;
  willCreatePreUpdateBackup: boolean;
  changes: string[];
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
  selectedChannel?: string | null;
  defaultAutostart?: boolean | null;
  runtimeProfiles?: CoreInstallRuntimeProfile[];
  settings: CoreInstallSetting[];
};

export type CoreError = {
  code?: string;
  message?: string;
};

export type AppAction = "start" | "stop" | "restart" | "backup";
export type DetailView = "logs" | "backups" | "configure" | "mounts" | "update" | "remove";
export type ShellView = "available-apps" | "dashboard" | "installed-apps" | "users";
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
  logs: string | null;
  logServices?: LogsServiceSegment[] | null;
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
  configureSection?: "publicOrigins";
};

export type OpenPanelOptions = {
  configureSection?: "publicOrigins";
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
