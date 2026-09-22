"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useGroupRef, usePanelRef } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { DEFAULT_RIGHT_PANEL_WIDTH, RIGHT_PANEL_WIDTH_PREF_KEY, panelWidthBounds } from "./panel-width";

export function ShellWorkspaceSplit({ children, panel, initialPanelWidth }: {
  children: ReactNode;
  panel: ReactNode;
  initialPanelWidth: number;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const groupApi = useGroupRef();
  const panelRef = usePanelRef();
  const [preferredWidth, setPreferredWidth] = useState(initialPanelWidth);
  const [groupWidth, setGroupWidth] = useState(0);
  const visible = Boolean(panel);
  const bounds = panelWidthBounds(groupWidth);

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
        panelRef.current?.resize(preferredWidth);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [groupApi, groupWidth, panelRef, preferredWidth, visible]);

  const rememberWidth = (width: number) => {
    const rounded = Math.round(width);
    setPreferredWidth(rounded);
    document.cookie = `${RIGHT_PANEL_WIDTH_PREF_KEY}=${rounded}; path=/; max-age=31536000; samesite=lax`;
  };

  return (
    <ResizablePanelGroup id="shell-workspace" orientation="horizontal" elementRef={groupRef} groupRef={groupApi}
      className="min-h-0 min-w-0"
      onLayoutChanged={(layout, { isUserInteraction }) => {
        // Viewport constraints and mount/unmount changes must not overwrite the saved preference.
        if (visible && isUserInteraction && groupRef.current && layout["right-panel"] !== undefined) {
          // Use the completed layout: the imperative panel ref can still expose the previous size
          // during this callback, especially for a single keyboard resize step.
          rememberWidth((groupRef.current.clientWidth - 1) * layout["right-panel"] / 100);
        }
      }}>
      <ResizablePanel id="workspace" minSize={visible ? bounds.workspaceMin : 0}>
        {children}
      </ResizablePanel>
      {visible && <>
        <ResizableHandle withHandle aria-label="Resize right panel"
          title="Drag to resize. Double-click to reset width."
          disableDoubleClick onDoubleClick={() => {
            panelRef.current?.resize(DEFAULT_RIGHT_PANEL_WIDTH);
            rememberWidth(DEFAULT_RIGHT_PANEL_WIDTH);
          }} />
        <ResizablePanel id="right-panel" panelRef={panelRef} defaultSize={preferredWidth}
          minSize={bounds.panelMin} maxSize={groupWidth > 0 ? bounds.panelMax : "100%"}
          groupResizeBehavior="preserve-pixel-size">
          {panel}
        </ResizablePanel>
      </>}
    </ResizablePanelGroup>
  );
}
