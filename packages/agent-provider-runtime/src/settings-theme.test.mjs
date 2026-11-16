import { expect, it, vi } from 'vitest';
import {
  createShellThemeMessage,
  THEME_ATTRIBUTE,
  THEME_PREFERENCE_ATTRIBUTE,
  THEME_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
} from '@hosty-sdk/app/theme';
import { configureProviderTheme } from './settings-theme.mjs';

function browser({ embedded = false, dark = false, search = '', stored = new Map(), storageDenied = false, matchMedia = true } = {}) {
  const listeners = new Map();
  const events = target => ({
    addEventListener: vi.fn((type, listener) => {
      const key = `${target}:${type}`;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(listener);
    }),
    removeEventListener: vi.fn((type, listener) => listeners.get(`${target}:${type}`)?.delete(listener)),
  });
  const emit = (target, type, event) => {
    for (const listener of listeners.get(`${target}:${type}`) ?? []) listener(event);
  };
  const attributes = new Map(), classes = new Set();
  const root = {
    classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
    style: {},
    setAttribute: (name, value) => attributes.set(name, value),
  };
  const media = { matches: dark, ...events('media') };
  const window = {
    location: new URL(`https://provider.example/settings${search}`),
    ...events('window'),
  };
  window.self = window;
  window.parent = embedded ? {} : window;
  window.history = {
    state: { app: 'keep' },
    replaceState: vi.fn((_state, _title, url) => { window.location = new URL(url); }),
  };
  const storage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: key => stored.delete(key),
  };
  Object.defineProperty(window, 'sessionStorage', {
    get: () => {
      if (storageDenied) throw new Error('Storage denied');
      return storage;
    },
  });
  if (matchMedia) window.matchMedia = vi.fn(() => media);
  return {
    window, document: { documentElement: root }, root, classes, stored, media, listeners,
    theme: () => attributes.get(THEME_ATTRIBUTE),
    preference: () => attributes.get(THEME_PREFERENCE_ATTRIBUTE),
    post: (data, source = window.parent) => emit('window', 'message', { data, source }),
    changeSystem: value => { media.matches = value; emit('media', 'change', { matches: value }); },
  };
}

const storedTheme = (theme, preference) => new Map([
  [THEME_STORAGE_KEY, theme], [THEME_PREFERENCE_STORAGE_KEY, preference],
]);

it('launch theme overrides stale tab storage and survives reload without changing app auth parameters', () => {
  const stored = storedTheme('dark', 'dark');
  const first = browser({ embedded: true, dark: true, stored, search: '?hosty_theme=light&hosty_theme_preference=light&code=keep&state=proof&appauth=keep&session=one&hosty_launch=embedded#return' });
  const stop = configureProviderTheme(first);
  expect(first.theme()).toBe('light');
  expect(first.preference()).toBe('light');
  expect(first.classes.has('dark')).toBe(false);
  expect(first.root.style.colorScheme).toBe('light');
  expect(first.window.location.search + first.window.location.hash).toBe('?code=keep&state=proof&appauth=keep&session=one&hosty_launch=embedded#return');
  expect(first.window.history.replaceState).toHaveBeenCalledWith(first.window.history.state, '', expect.any(URL));
  stop();

  const reload = browser({ embedded: true, dark: true, stored });
  configureProviderTheme(reload);
  expect(reload.theme()).toBe('light');
  expect(reload.preference()).toBe('light');
});

it('ignores unknown launch values and falls back through valid storage to the operating system', () => {
  const stored = browser({ dark: true, stored: storedTheme('light', 'light'), search: '?hosty_theme=unknown&hosty_theme_preference=unknown' });
  configureProviderTheme(stored);
  expect(stored.theme()).toBe('light');
  expect(stored.preference()).toBe('light');

  const system = browser({ dark: true, stored: storedTheme('unknown', 'unknown') });
  configureProviderTheme(system);
  expect(system.theme()).toBe('dark');
  expect(system.preference()).toBe('system');
  expect(system.stored.size).toBe(0);
});

it('accepts valid messages only from its embedding parent and persists later host decisions', () => {
  const page = browser({ embedded: true, search: '?hosty_theme=light' });
  configureProviderTheme(page);
  page.post(createShellThemeMessage('dark', 'dark'), {});
  page.post({ type: 'hosty:shell-theme', theme: 'unknown' });
  page.post({ type: 'unrelated', theme: 'dark' });
  expect(page.theme()).toBe('light');

  page.post(createShellThemeMessage('dark', 'system'));
  expect(page.theme()).toBe('dark');
  expect(page.preference()).toBe('system');
  expect(page.classes.has('dark')).toBe(true);
  expect(page.root.style.colorScheme).toBe('dark');
  expect(page.stored).toEqual(storedTheme('dark', 'system'));
  page.post(createShellThemeMessage('light', 'light'));
  expect(page.theme()).toBe('light');
});

it('follows OS changes in a standalone tab without creating a declared theme', () => {
  const page = browser();
  configureProviderTheme(page);
  expect(page.theme()).toBe('light');
  page.changeSystem(true);
  expect(page.theme()).toBe('dark');
  page.changeSystem(false);
  expect(page.theme()).toBe('light');
  expect(page.stored.size).toBe(0);
  page.post(createShellThemeMessage('dark', 'dark'));
  expect(page.theme()).toBe('light');
});

it.each(['param', 'stored'])('resolves stale standalone system mode against the OS and keeps following it (%s)', source => {
  const page = browser({
    stored: source === 'stored' ? storedTheme('dark', 'system') : new Map(),
    search: source === 'param' ? '?hosty_theme=dark&hosty_theme_preference=system' : '',
  });
  configureProviderTheme(page);
  expect(page.theme()).toBe('light');
  expect(page.preference()).toBe('system');
  expect(page.stored).toEqual(storedTheme('light', 'system'));
  page.changeSystem(true);
  expect(page.theme()).toBe('dark');
  expect(page.stored).toEqual(storedTheme('dark', 'system'));
});

it.each(['light', 'dark'])('keeps an explicit standalone %s choice through OS changes', theme => {
  const page = browser({ stored: storedTheme(theme, theme) });
  configureProviderTheme(page);
  page.changeSystem(true);
  expect(page.theme()).toBe(theme);
  page.changeSystem(false);
  expect(page.theme()).toBe(theme);
});

it('keeps embedded host system choices authoritative through local OS changes', () => {
  const page = browser({ embedded: true, search: '?hosty_theme=dark&hosty_theme_preference=system' });
  configureProviderTheme(page);
  expect(page.theme()).toBe('dark');
  page.changeSystem(false);
  expect(page.theme()).toBe('dark');
  page.post(createShellThemeMessage('light', 'system'));
  page.changeSystem(true);
  expect(page.theme()).toBe('light');
  expect(page.preference()).toBe('system');
});

it('follows OS changes in an embedded frame until its host declares a theme', () => {
  const page = browser({ embedded: true });
  configureProviderTheme(page);
  expect(page.theme()).toBe('light');
  page.changeSystem(true);
  expect(page.theme()).toBe('dark');
  expect(page.stored.size).toBe(0);
  page.post(createShellThemeMessage('light', 'system'));
  page.changeSystem(false);
  page.changeSystem(true);
  expect(page.theme()).toBe('light');
  expect(page.stored).toEqual(storedTheme('light', 'system'));
});

it('tolerates denied session storage and missing matchMedia', () => {
  const page = browser({ embedded: true, storageDenied: true, matchMedia: false, search: '?hosty_theme=dark' });
  const stop = configureProviderTheme(page);
  expect(page.theme()).toBe('dark');
  page.post(createShellThemeMessage('light', 'system'));
  expect(page.theme()).toBe('light');
  expect(() => stop()).not.toThrow();

  const standalone = browser({ storageDenied: true, matchMedia: false });
  expect(() => configureProviderTheme(standalone)).not.toThrow();
  expect(standalone.theme()).toBe('light');
});

it('removes both subscriptions on cleanup', () => {
  const page = browser({ embedded: true });
  const stop = configureProviderTheme(page);
  stop();
  page.post(createShellThemeMessage('dark', 'dark'));
  page.changeSystem(true);
  expect(page.theme()).toBe('light');
  expect(page.listeners.get('window:message').size).toBe(0);
  expect(page.listeners.get('media:change').size).toBe(0);
  expect(page.window.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  expect(page.media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
});
