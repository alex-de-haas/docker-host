// Theme slice: the protocol by which a shell hands an embedded app the theme it is rendering in,
// and the app half that applies it. Pure — no React, and no DOM beyond the narrow shapes the
// functions take — so one precedence runs in the pre-hydration bootstrap, in the React bridge,
// and in the tests.
//
// The design answers one failure. A shell posts `hosty:shell-theme` when its iframe fires `load`,
// and that post routinely lands before the app's effect has attached a listener, so it is lost.
// The copies this replaced then read whatever an earlier post had stored for the tab: one session
// in dark pinned an app dark for the life of the tab, whatever the shell was set to (telemetry-ui,
// 2026-09-07). So the launch parameters — which travel with the document and cannot be missed —
// decide the theme a document loads with; the post is for changes made while the frame is up.

export type HostyResolvedTheme = "light" | "dark";
/** What the operator chose in the shell. `system` means the shell follows the OS, and so does the app. */
export type HostyThemePreference = "light" | "dark" | "system";

/** The message a shell posts its frame on every theme change, and again when the frame loads. */
export const SHELL_THEME_TYPE = "hosty:shell-theme";
/** The launch parameters a shell appends to every URL it loads into a frame. */
export const THEME_PARAM = "hosty_theme";
export const THEME_PREFERENCE_PARAM = "hosty_theme_preference";
/**
 * Where a declared theme is kept for the life of the tab. App-internal navigation carries no
 * parameter and must not lose the theme; a tab the app opens itself inherits the storage, which
 * is the one accepted leak — no first-party app opens one.
 */
export const THEME_STORAGE_KEY = "hosty.theme.resolved";
export const THEME_PREFERENCE_STORAGE_KEY = "hosty.theme.preference";
/** The root attributes written beside the class, for CSS or scripts that key on them. */
export const THEME_ATTRIBUTE = "data-hosty-theme";
export const THEME_PREFERENCE_ATTRIBUTE = "data-hosty-theme-preference";
/** The root class every Hosty app's `dark:` variant keys on. */
export const DARK_THEME_CLASS = "dark";

export interface ShellThemeMessage {
  type: typeof SHELL_THEME_TYPE;
  theme: HostyResolvedTheme;
  preference: HostyThemePreference;
}

export function createShellThemeMessage(
  theme: HostyResolvedTheme,
  preference: HostyThemePreference,
): ShellThemeMessage {
  return { type: SHELL_THEME_TYPE, theme, preference };
}

export function normalizeResolvedTheme(value: unknown): HostyResolvedTheme | null {
  return value === "light" || value === "dark" ? value : null;
}

export function normalizeThemePreference(value: unknown): HostyThemePreference | null {
  return value === "light" || value === "dark" || value === "system" ? value : null;
}

export type ThemeSource = "param" | "stored" | "system";

export interface ThemeResolution {
  theme: HostyResolvedTheme;
  preference: HostyThemePreference;
  /** Which channel decided. `system` is the only one no shell spoke through. */
  source: ThemeSource;
}

/**
 * Resolves the theme a document paints with, in explicit precedence: the launch parameter a
 * shell just sent, then the value persisted for this tab, then the operating system.
 *
 * The parameter outranks storage because a shell rewrites it on every launch and every page
 * switch it drives, so it is the one channel that cannot go stale. An unrecognized value on
 * either channel is ignored rather than honoured — a newer shell must degrade an older app to
 * what it did before, never to a theme it cannot render. A preference that arrives without a
 * recognizable value defaults to the theme itself: a shell that resolved `dark` and said nothing
 * more chose dark.
 */
export function resolveTheme(input: {
  param?: string | null;
  preferenceParam?: string | null;
  stored?: string | null;
  storedPreference?: string | null;
  systemPrefersDark: boolean;
}): ThemeResolution {
  const declared = normalizeResolvedTheme(input.param);
  if (declared) {
    return { theme: declared, preference: normalizeThemePreference(input.preferenceParam) ?? declared, source: "param" };
  }

  const stored = normalizeResolvedTheme(input.stored);
  if (stored) {
    return { theme: stored, preference: normalizeThemePreference(input.storedPreference) ?? stored, source: "stored" };
  }

  return { theme: input.systemPrefersDark ? "dark" : "light", preference: "system", source: "system" };
}

/** The slice of the document root the bridge writes to. */
export interface ThemeRoot {
  classList: { toggle(token: string, force?: boolean): unknown };
  style: { colorScheme: string };
  setAttribute(name: string, value: string): void;
}

/**
 * Writes one theme to the root: the `dark` class Tailwind keys on, `color-scheme` so native
 * controls and scrollbars follow, and the two attributes for anything that wants the words.
 */
export function applyTheme(root: ThemeRoot, theme: HostyResolvedTheme, preference: HostyThemePreference): void {
  root.classList.toggle(DARK_THEME_CLASS, theme === "dark");
  root.style.colorScheme = theme;
  root.setAttribute(THEME_ATTRIBUTE, theme);
  root.setAttribute(THEME_PREFERENCE_ATTRIBUTE, preference);
}

/**
 * Reads a `hosty:shell-theme` message, accepting it from the parent frame alone.
 *
 * `event.source === window.parent` is set by the browser and is the trustworthy gate. The parent's
 * origin is deliberately not checked: an app learns which origin embeds it from messages like this
 * one, so it cannot be used to pre-filter them, and `document.referrer` — what some copies used —
 * goes stale the moment the app reloads itself. Theme is not sensitive; the source check is
 * sufficient. Not embedded at all means no parent to hear from, so nothing is accepted.
 */
export function parseShellThemeMessage(
  event: { data: unknown; source: unknown },
  win: Pick<Window, "parent" | "self">,
): { theme: HostyResolvedTheme; preference: HostyThemePreference } | null {
  if (win.parent === win.self || event.source !== win.parent) {
    return null;
  }

  const data = event.data as { type?: unknown; theme?: unknown; preference?: unknown } | null;
  if (!data || typeof data !== "object" || data.type !== SHELL_THEME_TYPE) {
    return null;
  }

  const theme = normalizeResolvedTheme(data.theme);
  if (!theme) {
    return null;
  }

  return { theme, preference: normalizeThemePreference(data.preference) ?? theme };
}

/**
 * The pre-hydration bootstrap: applies the theme from the same precedence `resolveTheme`
 * implements, so a document never paints in the wrong theme before React can correct it. Mount
 * it as an inline `<script>` in the document head.
 *
 * `followSystem` is the same switch `HostThemeBridge` takes. An app that runs its own theme
 * provider for standalone use (next-themes) passes `false` here and there: the host's bootstrap
 * then applies only a theme a shell declared and otherwise leaves the root to the provider, whose
 * own stored choice must not be overwritten by the operating system's.
 *
 * A parameter is persisted here as well as in the bridge, on the launch mode's precedent, so a
 * reload between this script and hydration cannot lose it. It does not clean the parameter out of
 * the URL — that is `HostThemeBridge`'s job: a `history.replaceState` before hydration is a
 * router's business, not a paint-blocking script's.
 */
export function createThemeBootstrapScript(options: { followSystem?: boolean } = {}): string {
  const followSystem = options.followSystem !== false;
  return `
(() => {
  const themes = ["light", "dark"];
  const preferences = ["light", "dark", "system"];
  const pick = (known, value) => (known.indexOf(value) >= 0 ? value : null);
  const read = (key) => {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  };
  try {
    const params = new URLSearchParams(window.location.search);
    const declared = pick(themes, params.get(${JSON.stringify(THEME_PARAM)}));
    let theme = declared;
    let preference = null;
    if (declared) {
      preference = pick(preferences, params.get(${JSON.stringify(THEME_PREFERENCE_PARAM)})) || declared;
    } else {
      const stored = pick(themes, read(${JSON.stringify(THEME_STORAGE_KEY)}));
      if (stored) {
        theme = stored;
        preference = pick(preferences, read(${JSON.stringify(THEME_PREFERENCE_STORAGE_KEY)})) || stored;
      }
    }
    if (!theme) {
      if (!${JSON.stringify(followSystem)}) {
        return;
      }
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      preference = "system";
    }
    const root = document.documentElement;
    root.classList.toggle(${JSON.stringify(DARK_THEME_CLASS)}, theme === "dark");
    root.style.colorScheme = theme;
    root.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)}, theme);
    root.setAttribute(${JSON.stringify(THEME_PREFERENCE_ATTRIBUTE)}, preference);
    if (declared) {
      try {
        window.sessionStorage.setItem(${JSON.stringify(THEME_STORAGE_KEY)}, theme);
        window.sessionStorage.setItem(${JSON.stringify(THEME_PREFERENCE_STORAGE_KEY)}, preference);
      } catch {}
    }
  } catch {}
})();
`;
}

/** The bootstrap for an app that follows the host and otherwise the operating system — the common case. */
export const themeBootstrapScript = createThemeBootstrapScript();
