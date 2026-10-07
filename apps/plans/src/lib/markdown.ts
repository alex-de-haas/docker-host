import { resolveRepositoryPath } from "./parser";
export type MarkdownTarget = { kind: "anchor" | "external" | "document" | "text"; value: string; path?: string };
export function markdownTarget(from: string, raw: string): MarkdownTarget {
  if (raw.startsWith("#")) return { kind: "anchor", value: raw };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) {
    try {
      const url = new URL(raw);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return { kind: "external", value: url.href };
    } catch { /* Unknown and unsafe schemes are plain text. */ }
    return { kind: "text", value: raw };
  }
  let decoded = raw.replace(/[#?].*$/, "");
  try { decoded = decodeURIComponent(decoded); } catch { return { kind: "text", value: raw }; }
  const target = resolveRepositoryPath(from, decoded);
  if (!decoded.startsWith("/") && /^docs\/.+\.md$/.test(target) && !target.split("/").some(part => part === "..")) return { kind: "document", value: raw, path: target };
  return { kind: "text", value: target };
}
