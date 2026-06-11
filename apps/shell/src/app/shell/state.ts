import type { DetailPanelState, InstallPanelState } from "./types";

export const emptyDetailPanelState = (): DetailPanelState => ({
  loading: false,
  error: null,
  logs: null,
  backups: null,
  backupCleanupPlan: null,
  updatePlan: null,
});

export const emptyInstallPanelState = (): InstallPanelState => ({
  loading: false,
  error: null,
  plan: null,
});
