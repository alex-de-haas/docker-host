export const RIGHT_PANEL_WIDTH_PREF_KEY = "hosty.shell.right-panel-width";
export const DEFAULT_RIGHT_PANEL_WIDTH = 360;
export const MAX_RIGHT_PANEL_WIDTH = 800;

/** Cookies are operator preferences, not trusted layout constraints. */
export function readPanelWidth(value: string | undefined): number {
  const width = Number(value);
  return Number.isFinite(width) && width >= 1 && width <= MAX_RIGHT_PANEL_WIDTH
    ? Math.round(width)
    : DEFAULT_RIGHT_PANEL_WIDTH;
}

/** Relax pixel minimums on small screens rather than overflowing the Shell viewport. */
export function panelWidthBounds(groupWidth: number) {
  const available = Math.max(0, groupWidth - 1); // The separator occupies one pixel.
  const workspaceMin = Math.min(240, available * 0.3);
  return {
    workspaceMin,
    panelMin: Math.min(280, available * 0.65),
    panelMax: Math.min(MAX_RIGHT_PANEL_WIDTH, available - workspaceMin),
  };
}
