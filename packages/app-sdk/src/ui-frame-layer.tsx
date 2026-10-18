"use client";
import { createContext, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { HostyAppFrame, type HostyAppFrameProps } from "./ui-frame";
import { createPortal } from "react-dom";
import { panelKey } from "./ui-types";
import type { UiHost } from "./ui-host";
import type { PanelTarget } from "./ui-types";
export type UiViewport = { element: HTMLElement; drawer: boolean;
  onAskAssistant?: HostyAppFrameProps["onAskAssistant"]; onAuthRequired?: HostyAppFrameProps["onAuthRequired"];
  outbound?: { target: PanelTarget; presentationId?: string; message: unknown; nonce: number } | null };
/** One stable React frame tree for every dock/window rectangle in this document. */
export class UiFrameLayer {
  root: HTMLDivElement | null = null;
  readonly containers = new Map<string, HTMLDivElement>();
  ensure(id: string): boolean {
    if (!this.root?.isConnected) return false;
    if (!this.containers.has(id)) {
      const element = document.createElement("div"); element.dataset.hostyPresentation = id; element.id = `hosty-presentation-${id}`;
      element.className = "hosty-panel-frame"; element.hidden = true; element.inert = true;
      element.style.display = "none"; this.root.append(element); this.containers.set(id, element); this.update();
    }
    return true;
  }
  release(id: string) { this.containers.get(id)?.remove(); this.containers.delete(id); this.update(); }
  readonly viewports = new Map<string, UiViewport>();
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  update = () => { this.revision++; for (const listener of this.listeners) listener(); };
  register(id: string, viewport: UiViewport) {
    this.viewports.set(id, viewport); this.update();
    const observer = new ResizeObserver(this.update); observer.observe(viewport.element);
    return () => { observer.disconnect(); if (this.viewports.get(id) === viewport) this.viewports.delete(id); this.update(); };
  }
}
export const UiFrameLayerContext = createContext<UiFrameLayer | null>(null);
export function presentationElement(id: string) {
  return document.querySelector<HTMLElement>(`[data-hosty-presentation="${id}"]`);
}
export function HostyPresentationLayer({ layer, host, active }: { layer: UiFrameLayer; host: UiHost; active: boolean }) {
  const state = useSyncExternalStore(host.subscribeSnapshot, host.getSnapshot, host.getSnapshot);
  useSyncExternalStore(layer.subscribe, layer.getSnapshot, layer.getSnapshot);
  useEffect(() => {
    window.addEventListener("resize", layer.update); window.addEventListener("scroll", layer.update, true);
    return () => { window.removeEventListener("resize", layer.update); window.removeEventListener("scroll", layer.update, true); };
  }, [layer]);
  useLayoutEffect(() => {
    for (const [id, element] of layer.containers) {
      const tool = state.tools.find(t => t.presentationId === id);
      if (!tool) { layer.release(id); continue; }
      const viewport = layer.viewports.get(tool.workspaceId), workspace = state.workspaces?.find(w => w.workspaceId === tool.workspaceId);
      const visible = !!(active && viewport && workspace?.expanded && workspace.selectedId === id);
      const rect = viewport?.element.getBoundingClientRect();
      element.hidden = !visible; element.inert = !visible;
      Object.assign(element.style, { position: "fixed", left: `${rect?.left ?? 0}px`, top: `${rect?.top ?? 0}px`,
        width: `${rect?.width ?? 0}px`, height: `${rect?.height ?? 0}px`, zIndex: viewport?.drawer ? "103" : "10", display: visible ? "block" : "none" });
    }
  });
  return <><div ref={element => { layer.root = element; }} className="hosty-presentation-layer" />{state.tools.map(tool => {
    const viewport = layer.viewports.get(tool.workspaceId), workspace = state.workspaces?.find(w => w.workspaceId === tool.workspaceId);
    const surface = tool.resolved.surface, container = layer.containers.get(tool.presentationId);
    if (!container) return null;
    const focusControls = (last: boolean) => {
      const controls = Array.from(viewport?.element.closest("aside")?.querySelectorAll<HTMLElement>('button,a[href],select') ?? [])
        .filter(element => !(element as HTMLButtonElement).disabled);
      (last ? controls.at(-1) : controls[0])?.focus();
    };
    return createPortal(<>
      {viewport?.drawer && <span tabIndex={0} aria-hidden="true" className="hosty-panel-focus-guard" onFocus={() => focusControls(true)} />}
      {surface ? <HostyAppFrame surface={{ ...surface, panelId: tool.target.panel.panelId }}
        view={{ viewId: `tool-${tool.presentationId}`, workspaceId: tool.workspaceId, presentationId: tool.presentationId, chrome: { navigation: "hide", tools: { launcher: "hide" } } }}
        title={state.catalog.find(p => panelKey(p.panel) === tool.key)?.label ?? "Tool"} standaloneHref={tool.resolved.standaloneHref}
        onAskAssistant={viewport?.onAskAssistant} onAuthRequired={viewport?.onAuthRequired}
        onAttention={count => host.setAttention(tool.presentationId, count)}
        outbound={viewport?.outbound && panelKey(viewport.outbound.target.panel) === tool.key
          && (viewport.outbound.presentationId ? viewport.outbound.presentationId === tool.presentationId
            : workspace?.selectedId === tool.presentationId && viewport.outbound.target.route === tool.currentRoute) ? viewport.outbound : null} />
        : <div className="hosty-panel-notice" role="status">This tool is unavailable ({tool.resolved.state}).</div>}
      {viewport?.drawer && <span tabIndex={0} aria-hidden="true" className="hosty-panel-focus-guard" onFocus={() => focusControls(false)} />}
    </>, container, tool.presentationId);
  })}</>;
}
