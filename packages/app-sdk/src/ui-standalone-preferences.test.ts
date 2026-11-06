// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createStandalonePreferenceStore, parseStandalonePreferences, standalonePreferenceKey } from "./ui-standalone-preferences";
import { panelKey, type UiBootstrap, type UiPanel } from "./ui-types";
const panel = { panel: { appId: "provider", installationId: "provider-1", panelId: "notes" } } as UiPanel;
const bootstrap: UiBootstrap = { version: 1, coreOrigin: "https://core.test", userId: "alice", app: { appId: "editor", installationId: "editor-1", origins: [] }, canHost: true, pinnedOpen: true };
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
it("scopes preferences to the user, Core and app installation", () => {
  const key = standalonePreferenceKey(bootstrap)!;
  const store = createStandalonePreferenceStore(key); store.setPinned(panel, true); store.setCollapsed(true);
  expect(createStandalonePreferenceStore(key).getSnapshot()).toMatchObject({ pins: [panelKey(panel.panel)], collapsed: true });
  for (const other of [{ ...bootstrap, userId: "bob" }, { ...bootstrap, coreOrigin: "https://elsewhere.test" },
    { ...bootstrap, app: { ...bootstrap.app, installationId: "editor-2" } }])
    expect(createStandalonePreferenceStore(standalonePreferenceKey(other)).getSnapshot()).toMatchObject({ pins: [], collapsed: false });
});
it("recovers malformed storage and keeps this session's preferences when writes fail", () => {
  expect(parseStandalonePreferences('{')).toEqual({ pins: [], collapsed: false });
  expect(parseStandalonePreferences(JSON.stringify({version: 1, pins: [false, '{}', '["a","b","c"]', '["a","b","c"]'], collapsed: 'yes'}))).toEqual({pins:['["a","b","c"]'],collapsed:false});
  const store = createStandalonePreferenceStore('prefs'); store.getSnapshot();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  store.setPinned(panel, true); expect(store.getSnapshot()).toMatchObject({pins:[panelKey(panel.panel)], error: expect.any(String)});
  store.setCollapsed(true); expect(store.getSnapshot().pins).toEqual([panelKey(panel.panel)]);
});
it("updates an existing consumer on cross-tab preference changes", () => {
  const store = createStandalonePreferenceStore('prefs'), listener = vi.fn(), stop = store.subscribe(listener);
  store.getSnapshot(); localStorage.setItem('prefs', JSON.stringify({version:1,pins:[panelKey(panel.panel)],collapsed:true}));
  window.dispatchEvent(new StorageEvent('storage',{key:'prefs'}));
  expect(listener).toHaveBeenCalledOnce(); expect(store.getSnapshot().collapsed).toBe(true); stop();
});
