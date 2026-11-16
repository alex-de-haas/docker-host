// Independent structural oracle for OPUS tests; it does not invoke a translation backend.
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
    throw new ProviderError("translation_markdown_changed", "The translated output changed protected Markdown structure. The source document is unchanged.", 502);
}
