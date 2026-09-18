import type { DetailPanelState } from "./types";

export const emptyDetailPanelState = (): DetailPanelState => ({
  loading: false,
  error: null,
  backups: null,
  backupCleanupPlan: null,
  updatePlan: null,
});
