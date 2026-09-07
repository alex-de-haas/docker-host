import { describe, expect, it } from "vitest";
import { appendThemeLaunchParams } from "./embedder";
import {
  applyTheme,
  createShellThemeMessage,
  createThemeBootstrapScript,
  normalizeResolvedTheme,
  normalizeThemePreference,
  parseShellThemeMessage,
  resolveTheme,
  SHELL_THEME_TYPE,
  THEME_ATTRIBUTE,
  THEME_PREFERENCE_ATTRIBUTE,
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  themeBootstrapScript,
} from "./theme";

describe("resolveTheme", () => {
  it("takes the launch parameter over a stale stored theme", () => {
    // The regression the slice exists for: a tab that once stored `dark` kept every later embedded
    // load dark, because the shell's post lost the race with the listener and nothing else spoke.
    expect(
      resolveTheme({ param: "light", preferenceParam: "system", stored: "dark", storedPreference: "dark", systemPrefersDark: true }),
    ).toEqual({ theme: "light", preference: "system", source: "param" });
  });

  it("falls back to the stored theme for app-internal navigation, which carries no parameter", () => {
    expect(resolveTheme({ stored: "dark", storedPreference: "dark", systemPrefersDark: false })).toEqual({
      theme: "dark",
      preference: "dark",
      source: "stored",
    });
  });

  it("reads the operating system when no shell has spoken", () => {
    expect(resolveTheme({ systemPrefersDark: true })).toEqual({ theme: "dark", preference: "system", source: "system" });
    expect(resolveTheme({ systemPrefersDark: false })).toEqual({ theme: "light", preference: "system", source: "system" });
  });

  it("defaults a missing or unrecognized preference to the theme itself", () => {
    expect(resolveTheme({ param: "dark", preferenceParam: "auto", systemPrefersDark: false }).preference).toBe("dark");
    expect(resolveTheme({ stored: "light", storedPreference: null, systemPrefersDark: true }).preference).toBe("light");
  });

  it("ignores unrecognized values on either channel rather than honouring them", () => {
    expect(resolveTheme({ param: "sepia", stored: "dark", systemPrefersDark: false })).toMatchObject({ theme: "dark", source: "stored" });
    expect(resolveTheme({ param: "sepia", stored: "purple", systemPrefersDark: false })).toMatchObject({ theme: "light", source: "system" });
  });
});

describe("normalizers", () => {
  it("accept only the protocol's values", () => {
    expect(normalizeResolvedTheme("light")).toBe("light");
    expect(normalizeResolvedTheme("system")).toBeNull();
    expect(normalizeResolvedTheme(undefined)).toBeNull();
    expect(normalizeThemePreference("system")).toBe("system");
    expect(normalizeThemePreference("auto")).toBeNull();
    expect(normalizeThemePreference(1)).toBeNull();
  });
});

describe("parseShellThemeMessage", () => {
  const parent = {};
  const self = {};
  const embedded = { parent, self };
  const message = (data: unknown, source: unknown = parent) => ({ data, source });

  it("accepts the parent frame's message and defaults the preference to the theme", () => {
    expect(parseShellThemeMessage(message(createShellThemeMessage("dark", "system")), embedded)).toEqual({ theme: "dark", preference: "system" });
    expect(parseShellThemeMessage(message({ type: SHELL_THEME_TYPE, theme: "light" }), embedded)).toEqual({ theme: "light", preference: "light" });
  });

  it("rejects any sender but the parent, and a document that has no parent", () => {
    expect(parseShellThemeMessage(message(createShellThemeMessage("dark", "dark"), {}), embedded)).toBeNull();
    expect(parseShellThemeMessage(message(createShellThemeMessage("dark", "dark"), self), embedded)).toBeNull();
    expect(parseShellThemeMessage(message(createShellThemeMessage("dark", "dark"), self), { parent: self, self })).toBeNull();
  });

  it("rejects other message types and unrenderable themes", () => {
    expect(parseShellThemeMessage(message({ type: "hosty:auth-required", theme: "dark" }), embedded)).toBeNull();
    expect(parseShellThemeMessage(message({ type: SHELL_THEME_TYPE, theme: "sepia" }), embedded)).toBeNull();
    expect(parseShellThemeMessage(message(null), embedded)).toBeNull();
    expect(parseShellThemeMessage(message("hosty:shell-theme"), embedded)).toBeNull();
  });
});

function themeRoot() {
  const attributes: Record<string, string> = {};
  const classes = new Set<string>();
  const root = {
    classList: {
      toggle: (token: string, force?: boolean) => {
        if (force) classes.add(token);
        else classes.delete(token);
        return force;
      },
    },
    style: { colorScheme: "" },
    setAttribute: (name: string, value: string) => {
      attributes[name] = value;
    },
  };
  return { root, attributes, classes };
}

describe("applyTheme", () => {
  it("writes the class, the color-scheme, and both attributes, and undoes the class for light", () => {
    const { root, attributes, classes } = themeRoot();
    applyTheme(root, "dark", "system");
    expect([...classes]).toEqual(["dark"]);
    expect(root.style.colorScheme).toBe("dark");
    expect(attributes).toEqual({ [THEME_ATTRIBUTE]: "dark", [THEME_PREFERENCE_ATTRIBUTE]: "system" });

    applyTheme(root, "light", "light");
    expect([...classes]).toEqual([]);
    expect(root.style.colorScheme).toBe("light");
    expect(attributes[THEME_ATTRIBUTE]).toBe("light");
  });
});

describe("themeBootstrapScript", () => {
  const run = (search: string, stored: Record<string, string> | "throws", systemDark: boolean, script = themeBootstrapScript) => {
    const { root, attributes, classes } = themeRoot();
    const store: Record<string, string> = stored === "throws" ? {} : { ...stored };
    const storage =
      stored === "throws"
        ? {
            getItem: () => {
              throw new Error("blocked");
            },
            setItem: () => {
              throw new Error("blocked");
            },
          }
        : {
            getItem: (key: string) => store[key] ?? null,
            setItem: (key: string, value: string) => {
              store[key] = value;
            },
          };
    const win = {
      location: { search },
      sessionStorage: storage,
      matchMedia: () => ({ matches: systemDark }),
    };
    const doc = { documentElement: root };
    new Function("window", "document", "URLSearchParams", script)(win, doc, URLSearchParams);
    return { dark: classes.has("dark"), scheme: root.style.colorScheme, attributes, store };
  };

  it("applies the parameter over storage and persists it, preference included", () => {
    const result = run("?hosty_theme=dark&hosty_theme_preference=system", { [THEME_STORAGE_KEY]: "light" }, false);
    expect(result).toMatchObject({ dark: true, scheme: "dark" });
    expect(result.attributes).toEqual({ [THEME_ATTRIBUTE]: "dark", [THEME_PREFERENCE_ATTRIBUTE]: "system" });
    expect(result.store).toEqual({ [THEME_STORAGE_KEY]: "dark", [THEME_PREFERENCE_STORAGE_KEY]: "system" });
  });

  it("keeps the stored theme across a page switch that carries no parameter", () => {
    const result = run("", { [THEME_STORAGE_KEY]: "dark", [THEME_PREFERENCE_STORAGE_KEY]: "dark" }, false);
    expect(result).toMatchObject({ dark: true, scheme: "dark" });
    expect(result.attributes[THEME_PREFERENCE_ATTRIBUTE]).toBe("dark");
  });

  it("reads the operating system when nothing is declared, and stores nothing", () => {
    expect(run("", {}, true)).toMatchObject({ dark: true, attributes: { [THEME_PREFERENCE_ATTRIBUTE]: "system" }, store: {} });
    expect(run("", {}, false)).toMatchObject({ dark: false, scheme: "light" });
  });

  it("ignores an unrecognized parameter and still paints from the next channel", () => {
    expect(run("?hosty_theme=sepia", { [THEME_STORAGE_KEY]: "dark" }, false)).toMatchObject({ dark: true, store: { [THEME_STORAGE_KEY]: "dark" } });
  });

  it("leaves an undeclared root alone when the app's own provider owns the system case", () => {
    const own = createThemeBootstrapScript({ followSystem: false });
    expect(run("", {}, true, own)).toMatchObject({ dark: false, scheme: "", attributes: {} });
    // A declared theme is still applied — the provider does not know what the shell chose.
    expect(run("?hosty_theme=dark", {}, false, own)).toMatchObject({ dark: true, scheme: "dark" });
    expect(run("", { [THEME_STORAGE_KEY]: "dark" }, false, own)).toMatchObject({ dark: true });
  });

  it("paints even where storage is blocked", () => {
    expect(run("?hosty_theme=dark", "throws", false)).toMatchObject({ dark: true, scheme: "dark" });
    expect(run("", "throws", true)).toMatchObject({ dark: true });
  });
});

describe("appendThemeLaunchParams", () => {
  it("declares both values, keeps the app path and query, and replaces rather than duplicates", () => {
    const once = appendThemeLaunchParams("http://app.local:3000/traces?x=1#top", "dark", "system");
    expect(once).toBe("http://app.local:3000/traces?x=1&hosty_theme=dark&hosty_theme_preference=system#top");
    const twice = appendThemeLaunchParams(once, "light", "light");
    expect(new URL(twice).searchParams.getAll("hosty_theme")).toEqual(["light"]);
    expect(new URL(twice).searchParams.getAll("hosty_theme_preference")).toEqual(["light"]);
  });
});
