import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { ProviderError } from "@hosty-sdk/app/providers";
import type { Nodes } from "mdast";

function signature(markdown: string): string {
  // Workflow metadata is machine-owned even when the document's prose is translated.
  const frontmatter = markdown.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? "";
  const source = markdown.slice(frontmatter.length);
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const protectedTypes = new Set(["code", "inlineCode", "html", "image", "imageReference", "definition"]);
  const visit = (node: Nodes): unknown => {
    if (protectedTypes.has(node.type))
      return [node.type, source.slice(node.position!.start.offset, node.position!.end.offset)];
    // Compare semantic Markdown structure, excluding translated prose and source coordinates.
    const { position: _position, value: _value, children: _children, ...properties } = node as Nodes & { value?: string; children?: Nodes[] };
    if (node.type === "text") return ["text", ...node.value.matchAll(/\bD\d+\b/g)].map(v => typeof v === "string" ? v : v[0]);
    const marker = node.type === "listItem"
      ? source.slice(node.position!.start.offset, node.position!.end.offset).match(/^(?:[-+*]|\d+[.)])/)?.[0] : undefined;
    return [properties, marker, ...( "children" in node ? node.children.map(child => visit(child as Nodes)) : [])];
  };
  return JSON.stringify([frontmatter, visit(tree)]);
}

/** A changed plan structure is a failed translation, never a successful rewritten plan. */
export function validateMarkdownTranslation(source: string, translated: string): void {
  if (signature(source) !== signature(translated))
    throw new ProviderError("translation_markdown_changed", "The agent changed protected Markdown structure. The source document is unchanged.", 502);
}

export type MarkdownPart = { text: string; translate: boolean };

/** Split only at Markdown block/item boundaries. Gaps and machine content remain byte-identical. */
export function markdownParts(markdown: string, maxSegment = 16_000): MarkdownPart[] {
  const frontmatter = markdown.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? "";
  const source = markdown.slice(frontmatter.length);
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const parts: MarkdownPart[] = frontmatter ? [{ text: frontmatter, translate: false }] : [];
  let cursor = 0;
  const append = (node: Nodes) => {
    const start = node.position!.start.offset!, end = node.position!.end.offset!;
    if (start > cursor) parts.push({ text: source.slice(cursor, start), translate: false });
    const text = source.slice(start, end);
    if (["code", "html", "definition", "thematicBreak"].includes(node.type)) parts.push({ text, translate: false });
    else if ([...text].length <= maxSegment) parts.push({ text, translate: true });
    else if (node.type === "list") {
      cursor = start;
      for (const item of node.children) append(item);
      if (cursor < end) parts.push({ text: source.slice(cursor, end), translate: false });
    } else throw new ProviderError("translation_block_too_large", "A single Markdown block exceeds the translation segment limit.", 413);
    cursor = end;
  };
  for (const node of tree.children) append(node);
  if (cursor < source.length) parts.push({ text: source.slice(cursor), translate: false });
  // Keep small intervening code blocks with surrounding prose to avoid an inference per paragraph.
  // The final integrity check still requires byte-identical code. Oversized code stays copy-only.
  const grouped: MarkdownPart[] = [];
  for (const part of parts) {
    const last = grouped.at(-1);
    if (last?.translate && [...last.text, ...part.text].length <= maxSegment) last.text += part.text;
    else grouped.push({ ...part });
  }
  return grouped;
}
