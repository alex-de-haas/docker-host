export function safeMarkdownBase(sourceUrl: string): URL | null {
  try {
    const source = new URL(sourceUrl);
    if ((source.protocol !== "http:" && source.protocol !== "https:") || source.username || source.password) {
      return null;
    }
    return new URL(".", source);
  } catch {
    return null;
  }
}

export function transformMarkdownUrl(value: string, base: URL | null): string {
  if (value.startsWith("#")) {
    return value;
  }
  if (!base) {
    return "";
  }

  try {
    const resolved = new URL(value, base);
    return (resolved.protocol === "http:" || resolved.protocol === "https:") && !resolved.username && !resolved.password
      ? resolved.href
      : "";
  } catch {
    return "";
  }
}

export function isSameMarkdownOrigin(value: string, base: URL): boolean {
  try {
    return new URL(value).origin === base.origin;
  } catch {
    return false;
  }
}
