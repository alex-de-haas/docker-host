export const RIGHT_PANEL_WIDTH_PREF_KEY = "hosty.shell.right-panel-width";
export const DEFAULT_RIGHT_PANEL_WIDTH = 360;
export const MAX_RIGHT_PANEL_WIDTH = 800;
export const WORKSPACE_PANEL_GAP = 12;
export const PANEL_RAIL_WIDTH = 48;

/** Cookies are operator preferences, not trusted layout constraints. */
export function readPanelWidth(value: string | undefined): number {
  const width = Number(value);
  return Number.isFinite(width) && width >= 1 && width <= MAX_RIGHT_PANEL_WIDTH
    ? Math.round(width)
    : DEFAULT_RIGHT_PANEL_WIDTH;
}

/** Relax pixel minimums on small screens rather than overflowing the Shell viewport. */
export function panelWidthBounds(groupWidth: number) {
  const available = Math.max(0, groupWidth - WORKSPACE_PANEL_GAP);
  const rail = Math.min(PANEL_RAIL_WIDTH, available);
  const bodySpace = available - rail;
  const workspaceMin = Math.min(240, bodySpace * 0.3);
  return {
    workspaceMin,
    panelMin: rail + Math.min(280, bodySpace * 0.65),
    panelMax: Math.min(MAX_RIGHT_PANEL_WIDTH + rail, available - workspaceMin),
  };
}
