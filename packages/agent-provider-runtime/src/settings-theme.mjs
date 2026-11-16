import {
  applyTheme,
  parseShellThemeMessage,
  resolveTheme,
  THEME_PARAM,
  THEME_PREFERENCE_PARAM,
  THEME_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
} from '@hosty-sdk/app/theme';

/** Follows the SDK theme protocol without requiring a React application. */
export function configureProviderTheme({ window = globalThis.window, document = globalThis.document } = {}) {
  if (!window || !document?.documentElement) return () => {};

  const root = document.documentElement;
  const standalone = window.parent === window.self;
  let system;
  try { system = window.matchMedia?.('(prefers-color-scheme: dark)'); } catch {}
  const read = key => {
    try { return window.sessionStorage.getItem(key); } catch { return null; }
  };
  const apply = (theme, preference, declared) => {
    applyTheme(root, theme, preference);
    try {
      if (declared) {
        window.sessionStorage.setItem(THEME_STORAGE_KEY, theme);
        window.sessionStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, preference);
      } else {
        window.sessionStorage.removeItem(THEME_STORAGE_KEY);
        window.sessionStorage.removeItem(THEME_PREFERENCE_STORAGE_KEY);
      }
    } catch {}
  };

  const params = new URLSearchParams(window.location.search);
  const resolution = resolveTheme({
    param: params.get(THEME_PARAM),
    preferenceParam: params.get(THEME_PREFERENCE_PARAM),
    stored: read(THEME_STORAGE_KEY),
    storedPreference: read(THEME_PREFERENCE_STORAGE_KEY),
    systemPrefersDark: system?.matches === true,
    standalone,
  });
  let declared = resolution.source !== 'system';
  let preference = resolution.preference;
  apply(resolution.theme, preference, declared);

  // Like the SDK bridge, consume only presentation parameters after persisting them.
  if (params.has(THEME_PARAM) || params.has(THEME_PREFERENCE_PARAM)) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete(THEME_PARAM);
      url.searchParams.delete(THEME_PREFERENCE_PARAM);
      window.history.replaceState(window.history.state, '', url);
    } catch {}
  }

  const handleMessage = event => {
    const message = parseShellThemeMessage(event, window);
    if (!message) return;
    declared = true;
    preference = message.preference;
    apply(message.theme, preference, true);
  };
  const handleSystemChange = () => {
    if (!declared || (standalone && preference === 'system')) {
      apply(system.matches ? 'dark' : 'light', preference, declared);
    }
  };
  window.addEventListener('message', handleMessage);
  system?.addEventListener?.('change', handleSystemChange);
  return () => {
    window.removeEventListener('message', handleMessage);
    system?.removeEventListener?.('change', handleSystemChange);
  };
}
