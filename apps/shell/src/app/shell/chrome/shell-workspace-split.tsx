"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useGroupRef, usePanelRef } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { PANEL_RAIL_WIDTH, DEFAULT_RIGHT_PANEL_WIDTH, RIGHT_PANEL_WIDTH_PREF_KEY, WORKSPACE_PANEL_GAP, panelWidthBounds } from "./panel-width";

export function ShellWorkspaceSplit({ children, panel, expanded, initialPanelWidth }: {
  children: ReactNode;
  panel: ReactNode;
  expanded: boolean;
  initialPanelWidth: number;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const groupApi = useGroupRef();
  const panelRef = usePanelRef();
  const [preferredWidth, setPreferredWidth] = useState(initialPanelWidth);
  const [groupWidth, setGroupWidth] = useState(0);
  const visible = Boolean(panel);
  const bounds = panelWidthBounds(groupWidth);
  const railWidth = groupWidth > 0 ? Math.min(PANEL_RAIL_WIDTH, Math.max(0, groupWidth - WORKSPACE_PANEL_GAP)) : PANEL_RAIL_WIDTH;

  useEffect(() => {
    const element = groupRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setGroupWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Restore the preferred width when room returns after a temporary viewport constraint.
  // Conditional panels register after mounting, so their ref alone does not prove layout readiness.
  useEffect(() => {
    if (!visible || groupWidth <= 0) return;
    // Let the library apply the newly measured pixel constraints before issuing a resize.
    const frame = requestAnimationFrame(() => {
      if (groupApi.current?.getLayout()["right-panel"] !== undefined) {
        panelRef.current?.resize(expanded ? preferredWidth + PANEL_RAIL_WIDTH : railWidth);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [groupApi, groupWidth, panelRef, preferredWidth, visible, expanded, railWidth]);

  const rememberWidth = (width: number) => {
    const rounded = Math.round(width);
    setPreferredWidth(rounded);
    document.cookie = `${RIGHT_PANEL_WIDTH_PREF_KEY}=${rounded}; path=/; max-age=31536000; samesite=lax`;
  };

  return (
    <div className="h-full min-h-0 min-w-0 pr-3 pb-3">
    <ResizablePanelGroup id="shell-workspace" orientation="horizontal" elementRef={groupRef} groupRef={groupApi}
      className="min-h-0 min-w-0"
      onLayoutChanged={(layout, { isUserInteraction }) => {
        // Viewport constraints and mount/unmount changes must not overwrite the saved preference.
        if (visible && expanded && isUserInteraction && groupRef.current && layout["right-panel"] !== undefined) {
          // Use the completed layout: the imperative panel ref can still expose the previous size
          // during this callback, especially for a single keyboard resize step.
          rememberWidth((groupRef.current.clientWidth - WORKSPACE_PANEL_GAP) * layout["right-panel"] / 100 - PANEL_RAIL_WIDTH);
        }
      }}>
      <ResizablePanel id="workspace" minSize={visible && expanded ? bounds.workspaceMin : 0}
        style={{ overflow: "hidden" }} className="rounded-xl border bg-background shadow-xs">
        {children}
      </ResizablePanel>
      {visible && <>
        <ResizableHandle aria-label="Resize right panel" disabled={!expanded} aria-hidden={!expanded}
          style={{ width: WORKSPACE_PANEL_GAP, pointerEvents: expanded ? undefined : "none" }}
          className="shrink-0 bg-transparent after:inset-y-auto after:h-8 after:rounded-full after:bg-transparent hover:after:bg-border focus-visible:after:bg-ring active:after:bg-ring"
          title="Drag to resize. Double-click to reset width."
          disableDoubleClick onDoubleClick={() => {
            panelRef.current?.resize(DEFAULT_RIGHT_PANEL_WIDTH + PANEL_RAIL_WIDTH);
            rememberWidth(DEFAULT_RIGHT_PANEL_WIDTH);
          }} />
        <ResizablePanel id="right-panel" panelRef={panelRef} defaultSize={expanded ? preferredWidth + PANEL_RAIL_WIDTH : railWidth}
          minSize={expanded ? bounds.panelMin : railWidth} maxSize={expanded ? groupWidth > 0 ? bounds.panelMax : "100%" : railWidth}
          style={{ overflow: "hidden" }} className="rounded-xl border bg-background shadow-xs"
          groupResizeBehavior="preserve-pixel-size">
          {panel}
        </ResizablePanel>
      </>}
    </ResizablePanelGroup>
    </div>
  );
}
