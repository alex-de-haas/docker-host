import type { PanelTarget, UiChromeOverrides, UiFrameSurface, UiResolvedPanel, SurfaceReadiness } from "./ui-types";

export const DEFAULT_WORKSPACE = "default";
export const ROOT_VIEW = "root";
export type UiPresentation = { key: string; presentationId: string; workspaceId: string; target: PanelTarget;
  resolved: UiResolvedPanel; readiness: SurfaceReadiness; attention: number; currentRoute: string | null; focusedAt: number };
export type UiWorkspaceSnapshot = { workspaceId: string; selectedId: string | null; expanded: boolean; width: number };
/** Adapters retain frames in one layer; present is also used for movement to another region. */
export type UiWorkspaceRenderer = {
  present(instance: UiPresentation, signal: AbortSignal): Promise<"accepted" | "unavailable">;
  focus(presentationId: string): void; collapse(): void; release(presentationId: string): void;
  showToolPicker(signal: AbortSignal): Promise<"accepted" | "unavailable">;
  /** Only matching stable layer identities can move frames without recreating their document. */
  frameLayer?: object;
};
export type UiViewDescriptor = { viewId: string; workspaceId: string; chrome?: UiChromeOverrides;
  presentationId?: string; navigate?: (surface: UiFrameSurface) => void | Promise<void> };
export type UiPlacementResolver = (request: { source: Readonly<{ viewId: string; workspaceId: string }>;
  target: PanelTarget; presentations: readonly UiPresentation[] }) => { workspaceId: string; presentationId?: string };
export type UiWorkspace = UiWorkspaceSnapshot & { generation: number; renderer?: UiWorkspaceRenderer; owner?: object };
export const workspace = (workspaceId: string): UiWorkspace => ({ workspaceId, selectedId: null, expanded: false, width: 360, generation: 0 });
