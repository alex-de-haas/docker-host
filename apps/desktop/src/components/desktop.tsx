"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { APP_ACTIVITY_RENEWED, APP_SESSION_RESTORED } from "@hosty-sdk/app/browser-auth";
import { AppWindow, ArrowLeftToLine, ArrowRightToLine, ChevronRight, CircleHelp, Grid2X2, LogOut, Maximize2, Minus, Monitor, Moon, Pin, Play, Power, RotateCw, Search, Settings2, Sun, PinOff, UserRound, X } from "lucide-react";
import { readDesktop, lifecycle } from "@/lib/api";
import { subscribeToCoreEvents, CoreEventNames } from "@/lib/core-events";
import { APPEARANCE, APPLICATIONS, dockApps, focusWindow, initialBounds, isAdministrator, isBusy, restoreWorkspace, storageKey, visibleApps,
  type App, type DesktopWindow as WindowState, type User, type Viewport, type WindowMode, type Workspace } from "@/lib/model";
import { readWallpaper } from "@/lib/wallpaper";
import { AppIcon } from "./app-icon";
import { DesktopMark } from "./desktop-mark";
import { Dock, DockButton } from "./dock";
import { DesktopWindow } from "./desktop-window";
import { ApplicationLibrary } from "./application-library";
import { Appearance } from "./appearance";
import { AppContent } from "./app-content";
import { DesktopTools, WindowTools } from "./window-tools";

export function Desktop({ appId, coreOrigin }: { appId: string; coreOrigin: string }) {
  const [data, setData] = useState<{ user: User; apps: App[] } | null>(null), [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    try { const next = await readDesktop(controller.signal); if (!controller.signal.aborted) { setData(next); setError(null); } }
    catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not refresh your desktop."); }
  }, []);
  useEffect(() => {
    // Initial data comes from an asynchronous Core request, not derived render state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    window.addEventListener(APP_SESSION_RESTORED, visible); window.addEventListener(APP_ACTIVITY_RENEWED, visible);
    return () => { request.current?.abort(); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible);
      window.removeEventListener(APP_SESSION_RESTORED, visible); window.removeEventListener(APP_ACTIVITY_RENEWED, visible); };
  }, [refresh]);
  const admin = data?.user.role === "host.admin";
  useEffect(() => {
    if (!data?.user.id) return;
    if (admin) return subscribeToCoreEvents(coreOrigin, { names: [CoreEventNames.appChanged, CoreEventNames.appRemoved], onSync: refresh });
    // Current Core sends domain events only to administrators. Visibility bounds this fallback.
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 20_000);
    return () => clearInterval(timer);
  }, [admin, coreOrigin, data?.user.id, refresh]);
  if (!data) return <div className="boot-screen"><DesktopMark size={40} /><p>{error || "Opening your desktop…"}</p>{error && <button className="subtle-button" onClick={refresh}>Try again</button>}</div>;
  return <WorkspaceDesktop key={data.user.id} {...data} ownId={appId} coreOrigin={coreOrigin} refresh={refresh} connectionError={error} />;
}

function WorkspaceDesktop({ user, apps, ownId, coreOrigin, refresh, connectionError }: {
  user: User; apps: App[]; ownId: string; coreOrigin: string; refresh: () => Promise<void>; connectionError: string | null;
}) {
  const admin = isAdministrator(user), available = useMemo(() => visibleApps(apps, user, ownId), [apps, user, ownId]);
  const [viewport, setViewport] = useState<Viewport>(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [workspace, setWorkspace] = useState<Workspace>(() => {
    let raw: string | null = null; try { raw = localStorage.getItem(storageKey(user.id)); } catch { /* An ephemeral desktop still works. */ }
    const saved = restoreWorkspace(raw, apps.map(app => app.id), { width: window.innerWidth, height: window.innerHeight });
    saved.windows = saved.windows.filter(win => win.id.startsWith("desktop:") || available.some(app => app.id === win.id));
    if (!raw) saved.windows = [{ id: APPLICATIONS, bounds: initialBounds({ width: window.innerWidth, height: window.innerHeight }), mode: "normal", minimized: false, page: 0 }];
    return saved;
  });
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const theme = workspace.theme === "system" ? systemDark ? "dark" : "light" : workspace.theme;
  const [custom, setCustom] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [search, setSearch] = useState<string | null>(null), [accountOpen, setAccountOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ app: App; action: "stop" | "restart" } | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({}), [errors, setErrors] = useState<Record<string, string>>({});
  const pendingRef = useRef(new Set<string>()), customRef = useRef<string | null>(null), dockDrag = useRef<string | null>(null);
  const [snap, setSnap] = useState<WindowMode | null>(null), [clock, setClock] = useState(() => new Date());
  const activeWindow = workspace.windows.findLast(win => !win.minimized);
  const activeTitle = activeWindow?.id === APPLICATIONS ? "Applications" : activeWindow?.id === APPEARANCE ? "Appearance" : apps.find(app => app.id === activeWindow?.id)?.displayName || "Desktop";
  const orderedApps = dockApps(available, workspace);
  const update = useCallback((patch: Partial<Workspace>) => setWorkspace(current => ({ ...current, ...patch })), []);
  const focus = useCallback((id: string) => setWorkspace(current => {
    if (current.windows.at(-1)?.id === id && !current.windows.at(-1)?.minimized) return current;
    return { ...current, windows: focusWindow(current.windows, id) };
  }), []);
  const patchWindow = useCallback((id: string, patch: Partial<WindowState>) => setWorkspace(current => ({ ...current,
    windows: current.windows.map(win => win.id === id ? { ...win, ...patch } : win) })), []);
  const close = useCallback((id: string) => setWorkspace(current => ({ ...current, windows: current.windows.filter(win => win.id !== id) })), []);
  const open = useCallback((id: string) => {
    setMenu(null); setSearch(null); setAccountOpen(false);
    setWorkspace(current => current.windows.some(win => win.id === id) ? { ...current, windows: focusWindow(current.windows, id) }
      : { ...current, windows: [...current.windows, { id, bounds: initialBounds(viewport, current.windows.length), mode: "normal", minimized: false, page: 0 }] });
  }, [viewport]);
  const runAction = useCallback(async (app: App, action: "start" | "stop" | "restart") => {
    if (!admin || pendingRef.current.has(app.id) || isBusy(app)) return;
    pendingRef.current.add(app.id); setPending(current => ({ ...current, [app.id]: action }));
    setErrors(current => ({ ...current, [app.id]: "" }));
    try { await lifecycle(app.id, action); }
    catch (cause) { const message = cause instanceof Error ? cause.message : "The application action failed.";
      setErrors(current => ({ ...current, [app.id]: message })); setNotice(message); }
    finally { await refresh(); pendingRef.current.delete(app.id); setPending(current => { const next = { ...current }; delete next[app.id]; return next; }); }
  }, [admin, refresh]);
  const openApp = useCallback((app: App) => { open(app.id); if (admin && app.runtimeState !== "running" && !isBusy(app)) void runAction(app, "start"); }, [admin, open, runAction]);
  const context = (id: string, x: number, y: number) => { setMenu({ id, x: Math.min(x, viewport.width - 250), y: Math.min(y, viewport.height - 330) }); setAccountOpen(false); };

  useEffect(() => {
    try { localStorage.setItem(storageKey(user.id), JSON.stringify(workspace)); }
    catch {
      // Storage is an external system; report its write failure without resetting the desktop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNotice("This browser could not save your layout. Your desktop still works for this visit.");
    }
  }, [workspace, user.id]);
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(query.matches); query.addEventListener("change", changed);
    const resize = () => setViewport({ width: innerWidth, height: innerHeight }); window.addEventListener("resize", resize);
    const timer = setInterval(() => setClock(new Date()), 30_000);
    return () => { query.removeEventListener("change", changed); window.removeEventListener("resize", resize); clearInterval(timer); };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.hostyTheme = theme;
    document.documentElement.dataset.hostyThemePreference = workspace.theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme, workspace.theme]);
  useEffect(() => {
    let disposed = false;
    readWallpaper(user.id).then(blob => { if (!disposed && blob) { customRef.current = URL.createObjectURL(blob); setCustom(customRef.current); } }).catch(() => {});
    return () => { disposed = true; if (customRef.current) URL.revokeObjectURL(customRef.current); };
  }, [user.id]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearch(current => current === null ? "" : null); }
      if (event.key === "Escape") { setMenu(null); setSearch(null); setAccountOpen(false); setConfirmAction(null); }
    };
    const frameFocus = () => { const id = document.activeElement?.closest("[data-window-id]")?.getAttribute("data-window-id"); if (id) focus(id); };
    window.addEventListener("keydown", key); window.addEventListener("blur", frameFocus);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("blur", frameFocus); };
  }, [focus]);
  const wallpaper = workspace.wallpaper === "custom" && custom ? custom : `/wallpapers/coast-${workspace.wallpaper === "night" ? "dark" : theme}.png`;
  const menuApp = apps.find(app => app.id === menu?.id), menuWindow = workspace.windows.find(win => win.id === menu?.id);
  const matches = available.filter(app => app.displayName.toLowerCase().includes((search || "").toLowerCase()));

  return <DesktopTools revision={JSON.stringify(apps.map(app => [app.id, app.installationId, app.runtimeState, app.health?.status]))}><main className={`desktop theme-${theme}`} style={{ "--wallpaper": `url("${wallpaper}")` } as CSSProperties}
    onContextMenu={event => { if (event.target === event.currentTarget) { event.preventDefault(); open(APPEARANCE); } }}>
    <div className="desktop-wallpaper" aria-hidden="true" />
    <header className="menubar">
      <div className="menubar-left"><button className="brand-button" onClick={() => open(APPLICATIONS)} aria-label="Hosty applications"><DesktopMark size={20} /><span>HOSTY</span></button>
        <span className="active-app-name">{activeTitle.replace(/^Hosty /, "")}</span>
        <button className="menubar-text" onClick={() => activeWindow ? context(activeWindow.id, 220, 44) : open(APPLICATIONS)}>Window</button>
      </div>
      <div className="menubar-right"><button className="menubar-icon" title="Search applications (⌘K / Ctrl+K)" aria-label="Open Spotlight" onClick={() => setSearch("")}><Search size={17} /></button>
        <button className="menubar-icon theme-toggle" title={`Switch to ${theme === "light" ? "dark" : "light"} theme`} aria-label="Toggle theme" onClick={() => update({ theme: theme === "light" ? "dark" : "light" })}>{theme === "light" ? <Moon size={16} /> : <Sun size={16} />}</button>
        <button className="account-button" aria-label="Account menu" aria-expanded={accountOpen} onClick={() => { setAccountOpen(!accountOpen); setMenu(null); }}><span className="avatar">{(user.displayName || user.email || "U").split(/\s/).map(value => value[0]).slice(0, 2).join("").toUpperCase()}</span><span>{admin ? "Administrator" : user.displayName}</span></button>
        <time className="desktop-clock" dateTime={clock.toISOString()}>{clock.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}<span>{clock.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span></time>
      </div>
    </header>

    {!workspace.windows.some(win => !win.minimized) && <div className="desktop-welcome"><span className="welcome-label">YOUR OWN LITTLE CORNER</span><h1>Make room for what matters.</h1><p>Your applications are right here when you need them.</p><button onClick={() => open(APPLICATIONS)}><Grid2X2 size={17} />Open applications<ChevronRight size={16} /></button></div>}
    {snap && <div className={`snap-preview snap-${snap}`} />}
    {[...workspace.windows].sort((a, b) => a.id.localeCompare(b.id)).map(win => {
      const app = apps.find(item => item.id === win.id);
      const title = win.id === APPLICATIONS ? "Applications" : win.id === APPEARANCE ? "Appearance" : app?.displayName || "Application";
      return <WindowTools key={`${win.id}:${app?.installationId || ""}`} app={app} apps={apps} userId={user.id}>{(toolbar, wrap) => <DesktopWindow window={viewport.width < 700 ? { ...win, mode: "maximized" } : win} viewport={viewport} title={title}
        index={workspace.windows.findIndex(item => item.id === win.id)} active={activeWindow?.id === win.id} onFocus={() => focus(win.id)}
        onChange={patch => patchWindow(win.id, patch)} onClose={() => close(win.id)} onSnapPreview={setSnap}
        toolbar={toolbar}>
        {wrap(win.id === APPLICATIONS ? <ApplicationLibrary apps={available} admin={admin} onOpen={openApp} onContext={(app, x, y) => context(app.id, x, y)} />
          : win.id === APPEARANCE ? <Appearance user={user} workspace={workspace} resolved={theme} custom={custom} onChange={update} onUpload={file => {
            if (customRef.current) URL.revokeObjectURL(customRef.current); customRef.current = URL.createObjectURL(file); setCustom(customRef.current);
          }} /> : <AppContent app={app} pageIndex={win.page} theme={theme} preference={workspace.theme} admin={admin}
            pending={pending[win.id]} error={errors[win.id]} onPage={page => patchWindow(win.id, { page })}
            onStart={() => { if (app) void runAction(app, "start"); }} onRetry={refresh} />)}
      </DesktopWindow>}</WindowTools>;
    })}

    <Dock>
      <DockButton label="Applications" className="dock-item" aria-label="Applications" onClick={() => open(APPLICATIONS)}><AppIcon icon={Grid2X2} tone={0} /><span className={`dock-dot ${workspace.windows.some(win => win.id === APPLICATIONS) ? "open" : ""}`} /></DockButton>
      <span className="dock-separator" />
      <div className="dock-apps">{orderedApps.map(app => <DockButton key={app.id} label={app.displayName} hint={app.runtimeState === "stopped" ? "Click to start" : undefined} className={`dock-item ${app.runtimeState === "stopped" ? "stopped" : ""} ${pending[app.id] || isBusy(app) ? "launching" : ""}`}
        aria-label={`${app.displayName}${app.runtimeState === "stopped" ? " — click to start" : ""}`} onClick={() => openApp(app)} draggable
        onDragStart={event => { dockDrag.current = app.id; event.dataTransfer.setData("text/plain", app.id); event.dataTransfer.effectAllowed = "move"; }}
        onDragOver={event => { if (dockDrag.current) event.preventDefault(); }} onDragEnd={() => { dockDrag.current = null; }}
        onDrop={event => { event.preventDefault(); const id = dockDrag.current; dockDrag.current = null; if (!id || id === app.id) return;
          const order = orderedApps.map(item => item.id).filter(value => value !== id); order.splice(order.indexOf(app.id), 0, id); update({ order, pins: order.filter(value => workspace.pins.includes(value)) }); }}
        onContextMenu={event => { event.preventDefault(); context(app.id, event.clientX, event.clientY); }}>
        <AppIcon app={app} />
        <span className={`dock-dot ${workspace.windows.some(win => win.id === app.id) ? "open" : ""}`} />
      </DockButton>)}</div>
      <span className="dock-separator" /><DockButton label="Appearance" className="dock-item" aria-label="Appearance" onClick={() => open(APPEARANCE)}><AppIcon icon={Settings2} tone={5} /><span className={`dock-dot ${workspace.windows.some(win => win.id === APPEARANCE) ? "open" : ""}`} /></DockButton>
    </Dock>

    {menu && <div className="menu-backdrop" onPointerDown={() => setMenu(null)}><div className="context-menu" role="menu" aria-label="Application actions" style={{ left: Math.max(8, menu.x), top: Math.max(44, menu.y) }} onPointerDown={event => event.stopPropagation()}>
      <span className="menu-caption">{menuApp?.displayName || (menu.id === APPEARANCE ? "Appearance" : "Applications")}</span>
      <button role="menuitem" autoFocus onClick={() => { if (menuApp) openApp(menuApp); else open(menu.id); }}><AppWindow size={16} />{menuWindow ? "Show window" : "Open"}</button>
      {menuApp && <button role="menuitem" onClick={() => { update({ pins: workspace.pins.includes(menu.id) ? workspace.pins.filter(id => id !== menu.id) : [...workspace.pins, menu.id] }); setMenu(null); }}>{workspace.pins.includes(menu.id) ? <PinOff size={16} /> : <Pin size={16} />}{workspace.pins.includes(menu.id) ? "Unpin from favorites" : "Pin to favorites"}</button>}
      {menuWindow && <><div className="menu-divider" /><button role="menuitem" onClick={() => { patchWindow(menu.id, { minimized: true }); setMenu(null); }}><Minus size={16} />Minimize</button>
        <button role="menuitem" onClick={() => { patchWindow(menu.id, { mode: menuWindow.mode === "maximized" ? "normal" : "maximized", minimized: false }); setMenu(null); }}><Maximize2 size={16} />{menuWindow.mode === "maximized" ? "Restore size" : "Maximize"}</button>
        <div className="snap-menu-row"><button role="menuitem" onClick={() => { patchWindow(menu.id, { mode: "left", minimized: false }); setMenu(null); }}><ArrowLeftToLine size={14} />Tile left</button><button role="menuitem" onClick={() => { patchWindow(menu.id, { mode: "right", minimized: false }); setMenu(null); }}><ArrowRightToLine size={14} />Tile right</button></div>
        <button role="menuitem" onClick={() => { close(menu.id); setMenu(null); }}><X size={16} />Close window</button></>}
      {menuApp && admin && <><div className="menu-divider" />{menuApp.runtimeState === "stopped" ? <button role="menuitem" disabled={!!pending[menuApp.id]} onClick={() => { openApp(menuApp); setMenu(null); }}><Play size={16} />Start application</button>
        : <><button role="menuitem" disabled={!!pending[menuApp.id] || isBusy(menuApp)} onClick={() => { setConfirmAction({ app: menuApp, action: "restart" }); setMenu(null); }}><RotateCw size={16} />Restart for everyone…</button>
        <button role="menuitem" className="danger" disabled={!!pending[menuApp.id] || isBusy(menuApp)} onClick={() => { setConfirmAction({ app: menuApp, action: "stop" }); setMenu(null); }}><Power size={16} />Stop for everyone…</button></>}</>}
    </div></div>}

    {accountOpen && <div className="menu-backdrop" onPointerDown={() => setAccountOpen(false)}><div className="context-menu account-menu" role="menu" aria-label="Account" onPointerDown={event => event.stopPropagation()}>
      <span className="menu-caption">{user.displayName}<small>{user.email}</small></span>
      <button role="menuitem" autoFocus onClick={() => open(APPEARANCE)}><UserRound size={16} />Personal settings</button>
      <button role="menuitem" onClick={() => { void refresh(); setAccountOpen(false); }}><RotateCw size={16} />Refresh applications</button>
      <button role="menuitem" onClick={() => { setWorkspace(current => ({ ...current, windows: current.windows.map(win => ({ ...win, minimized: true })) })); setAccountOpen(false); }}><Monitor size={16} />Show desktop</button>
      <div className="menu-divider" /><a role="menuitem" href={`${coreOrigin}/logout`}><LogOut size={16} />Sign out</a>
    </div></div>}

    {search !== null && <div className="spotlight-backdrop" onPointerDown={() => setSearch(null)}><section className="spotlight" role="dialog" aria-modal="true" aria-label="Search applications" onPointerDown={event => event.stopPropagation()}>
      <label><Search size={23} /><input autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Where would you like to go?" aria-label="Spotlight search"
        onKeyDown={event => { if (event.key === "Enter" && matches[0]) openApp(matches[0]); }} /><button aria-label="Close search" onClick={() => setSearch(null)}><X size={17} /></button></label>
      <div className="spotlight-results">{matches.length ? matches.map(app => <button key={app.id} onClick={() => openApp(app)}><AppIcon app={app} /><span><strong>{app.displayName}</strong><small>{app.runtimeState === "stopped" ? "Start application" : "Application"}</small></span><ChevronRight size={17} /></button>) : <p>No applications found.</p>}</div>
      <footer><span>Search your applications</span><kbd>esc to close</kbd></footer>
    </section></div>}

    {confirmAction && <div className="dialog-backdrop" onPointerDown={() => setConfirmAction(null)}><section className="confirmation" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description" onPointerDown={event => event.stopPropagation()}>
      <AppIcon app={confirmAction.app} /><h2 id="confirm-title">{confirmAction.action === "stop" ? "Stop" : "Restart"} {confirmAction.app.displayName}?</h2>
      <p id="confirm-description">This affects everyone using this application on the host. Closing your window leaves it running.</p>
      <div><button className="subtle-button" autoFocus onClick={() => setConfirmAction(null)}>Cancel</button><button className="danger-button" onClick={() => { void runAction(confirmAction.app, confirmAction.action); setConfirmAction(null); }}>{confirmAction.action === "stop" ? "Stop for everyone" : "Restart for everyone"}</button></div>
    </section></div>}
    {(notice || connectionError) && <div className="desktop-toast" role="alert"><CircleHelp size={18} /><span>{notice || connectionError}</span><button aria-label="Dismiss message" onClick={() => { setNotice(null); if (connectionError) void refresh(); }}><X size={16} /></button></div>}
  </main></DesktopTools>;
}
