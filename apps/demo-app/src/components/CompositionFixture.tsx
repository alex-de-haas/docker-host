"use client";

import { useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { HostyAppFrame, HostyNavigation, HostyPanelWorkspace, useHostyNavigation, useHostyUiHost } from "@hosty-sdk/app/ui/react";
import { createPresentationRequestId, panelKey, ui, type PanelTarget, type UiFrameSurface } from "@hosty-sdk/app/ui";
import type { UiHostSnapshot } from "@hosty-sdk/app/ui/host";

const empty: UiHostSnapshot = { bootstrap: null, catalog: [], tools: [], selected: null, expanded: false, width: 360, error: null };
const noop = () => () => {};

/** A small protocol fixture, not a desktop client: two direct children share one coordinator. */
export function CompositionDesktop() {
  const host = useHostyUiHost(), navigation = useHostyNavigation();
  const snapshot = useSyncExternalStore(host?.subscribeSnapshot ?? noop, host?.getSnapshot ?? (() => empty), () => empty);
  const [panel, setPanel] = useState(""), [route, setRoute] = useState("");
  const [launch, setLaunch] = useState<{ surface: UiFrameSurface; target: PanelTarget } | null>(null);
  const [views, setViews] = useState(["A", "B"]), [showNavigation, setShowNavigation] = useState(true);
  const [message, setMessage] = useState("");
  const selected = snapshot.catalog.find(p => panelKey(p.panel) === panel) ?? snapshot.catalog.find(p => p.panel.appId === snapshot.bootstrap?.app.appId) ?? snapshot.catalog[0];
  const active = snapshot.tools.filter(t => snapshot.workspaces?.some(w => w.selectedId === t.presentationId)).sort((a, b) => b.focusedAt - a.focusedAt)[0];
  const floating = snapshot.workspaces?.find(w => w.workspaceId === "floating");
  const launchViews = () => {
    const own = navigation.catalog, entry = navigation.entries.find(e => e.endpoint === "http" && e.origin && e.available);
    if (!own || !entry?.origin || !entry.endpoint || !selected) return;
    setLaunch({ surface: { appId: own.appId, installationId: own.installationId, origin: entry.origin, endpoint: entry.endpoint,
      route: "/composition/view", framePolicy: { microphone: false, popupEscape: false } }, target: { panel: selected.panel, route: route || selected.route } });
    setViews(["A", "B"]);
  };
  if (!host) return <p className="p-6">Open the composition fixture separately to host two app windows.</p>;
  return <div className="composition-desktop">
    <style>{fixtureStyles}</style>
    <HostyPanelWorkspace railMode="catalog">
      <main className="composition-main">
        <h1>UI composition conformance</h1>
        <p>Two app views share retained tools. Choose a declared panel and an existing route, then open the views.</p>
        <div className="composition-controls">
          <label>Tool <select value={selected ? panelKey(selected.panel) : ""} onChange={event => setPanel(event.target.value)}>
            {snapshot.catalog.map(item => <option key={panelKey(item.panel)} value={panelKey(item.panel)}>{item.appName}: {item.label}</option>)}
          </select></label>
          <label>Existing route <input value={route} placeholder={selected?.route ?? "/"} onChange={event => setRoute(event.target.value)} /></label>
          <button type="button" disabled={!selected || !navigation.catalog} onClick={launchViews}>Open two app views</button>
          <button type="button" onClick={() => setShowNavigation(value => !value)}>Toggle app navigation</button>
          <button type="button" onClick={() => host.setViewChrome("root", { tools: { enabled: !host.getChrome().tools.enabled } })}>Toggle tool access</button>
          <button type="button" disabled={!active} onClick={async () => {
            if (!active) return;
            const destination = active.workspaceId === "floating" ? "default" : "floating";
            setMessage(await host.movePresentation(active.presentationId, destination) ? `Moved to ${destination}` : "The tool could not be moved.");
          }}>Move selected tool</button>
          <button type="button" onClick={() => void ui.openToolPicker({ requestId: createPresentationRequestId() })}>Shared tools</button>
        </div>
        {snapshot.error && <p role="status">{snapshot.error.message}</p>}
        {!snapshot.bootstrap?.canHost && <p>Review the Demo app’s optional panel access in Core to use this fixture.</p>}
        {message && <p role="status">{message}</p>}
        <div className="composition-views">{launch && views.map(view => {
          const query = new URLSearchParams({ view, target: JSON.stringify(launch.target) });
          const surface = { ...launch.surface, route: `/composition/view?${query}` };
          return <section key={view} className="composition-view">
            <header><strong>App {view}</strong><button type="button" onClick={() => setViews(values => values.filter(value => value !== view))}>Close app {view}</button></header>
            <HostyAppFrame surface={surface} title={`App ${view}`} view={{ viewId: `fixture-${view}`, workspaceId: "default",
              chrome: { navigation: showNavigation ? "show" : "hide", tools: { enabled: true, launcher: "hide" } } }} />
          </section>;
        })}</div>
      </main>
    </HostyPanelWorkspace>
    <section className="composition-floating" hidden={!floating?.expanded} aria-label="Tool window">
      <HostyPanelWorkspace workspaceId="floating" layout="dock" className="composition-window" initialWidth={380}><span /></HostyPanelWorkspace>
    </section>
  </div>;
}

export function CompositionView() {
  const search = useSearchParams(), [message, setMessage] = useState("");
  const targetText = search.get("target");
  const open = async (reuse: "exact" | "new", distinct: boolean) => {
    try {
      const target = JSON.parse(targetText ?? "null") as PanelTarget | null;
      if (!target?.panel) { setMessage("Return to the desktop to select a target."); return; }
      if (distinct) {
        const address = new URL(target.route ?? "/", window.location.origin); address.searchParams.set("fixture", search.get("view") ?? "alternate");
        target.route = address.pathname + address.search + address.hash;
      }
      const result = await ui.openSurface(target, { placement: "side", requestId: createPresentationRequestId(), reuse });
      setMessage(result.status === "opened" ? `Opened ${result.presentationId}` : `${result.status}: ${result.code}`);
    } catch { setMessage("The fixture target is invalid."); }
  };
  return <div className="p-3"><HostyNavigation /><h1 className="my-3 text-lg">App view {search.get("view") ?? "on another endpoint"}</h1>
    <p>Navigation belongs to this app; tools belong to the desktop.</p>
    <div className="my-3 flex flex-wrap gap-2">
      <button className="rounded border p-2" onClick={() => void open("exact", false)}>Open shared target</button>
      <button className="rounded border p-2" onClick={() => void open("new", false)}>Open another instance</button>
      <button className="rounded border p-2" onClick={() => void open("exact", true)}>Open distinct route</button>
    </div>
    <label>App draft<textarea className="block w-full rounded border p-2" aria-label="App draft" /></label>
    {message && <p role="status">{message}</p>}
  </div>;
}

const fixtureStyles = `
.composition-desktop{height:100dvh;font:14px system-ui}.composition-main{padding:20px}.composition-main h1{font-size:20px;font-weight:600;margin-bottom:8px}
.composition-controls{display:flex;align-items:end;flex-wrap:wrap;gap:10px;margin:18px 0}.composition-controls label{display:grid;gap:4px}.composition-controls button,.composition-controls input,.composition-controls select,.composition-view header button{border:1px solid #8894a6;border-radius:6px;padding:6px 8px}
.composition-views{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.composition-view{height:65vh;display:flex;flex-direction:column;border:1px solid #8894a6;border-radius:8px;overflow:hidden}.composition-view header{display:flex;align-items:center;justify-content:space-between;padding:8px}
.composition-view iframe{min-height:0;flex:1}.composition-floating{position:fixed;right:60px;bottom:24px;width:430px;height:500px;z-index:40;box-shadow:0 8px 32px #0005;border:1px solid #8894a6;border-radius:8px;overflow:hidden}.composition-floating[hidden]{display:none}.composition-window.hosty-panel-workspace{height:100%}.composition-window .hosty-panel-document{display:none}.composition-window .hosty-panel-body{flex:1;margin:0}.composition-window .hosty-panel-resize{display:none}
@media(max-width:700px){.composition-views{grid-template-columns:1fr}.composition-floating{right:8px;width:min(430px,calc(100vw - 16px))}}
`;
