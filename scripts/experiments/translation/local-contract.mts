// Standalone experimental prompt and Markdown oracle. No production agent runtime is imported.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes } from "mdast";

// Retains the dated local-model experiment's prompt fixture, not an agent execution policy.
export const MARKDOWN_INSTRUCTIONS = " For markdown input, translate prose only. Preserve the complete YAML frontmatter byte for byte, "
  + "heading levels, paragraph/list/table structure, list numbering, task checkbox states and deliverable IDs such as D1. "
  + "Preserve every link destination, reference identifier, code fence, code block, inline code, HTML and image unchanged. "
  + "Keep emphasis and other Markdown syntax around the corresponding translated text. Do not wrap the document in a code fence.";

const parse = (text: string) => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
const metadata = (text: string) => text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? "";
const literal = new Set(["code", "inlineCode", "html", "image", "imageReference", "definition"]);
function signature(markdown: string): string {
  const header = metadata(markdown), source = markdown.slice(header.length);
  const visit = (node: Nodes): unknown => {
    if (literal.has(node.type)) return [node.type, source.slice(node.position!.start.offset!, node.position!.end.offset!)];
    const { position: _position, value: _value, children: _children, ...properties } = node as Nodes & { value?: string; children?: Nodes[] };
    if (node.type === "text") return ["text", ...[...node.value.matchAll(/\bD\d+\b/g)].map(match => match[0])];
    const marker = node.type === "listItem" ? source.slice(node.position!.start.offset!, node.position!.end.offset!).match(/^(?:[-+*]|\d+[.)])/)?.[0] : undefined;
    return [properties, marker, ...("children" in node ? node.children.map(child => visit(child as Nodes)) : [])];
  };
  return JSON.stringify([header, visit(parse(source))]);
}
export function validateMarkdownTranslation(source: string, translated: string): void {
  if (signature(source) !== signature(translated)) throw new Error("Experimental translation changed protected Markdown structure.");
}

/** Bounded Markdown blocks for local prompt diagnostics; this is not a production translator. */
export function markdownParts(markdown: string, maximum = 16_000): { text: string; translate: boolean }[] {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error("Supply a positive segment limit.");
  const header = metadata(markdown), body = markdown.slice(header.length), output: { text: string; translate: boolean }[] = [];
  const append = (text: string, translate: boolean) => {
    if (!text) return;
    if (!text.trim()) translate = false;
    if (translate && [...text].length > maximum) throw new Error("An indivisible experimental Markdown block exceeds the segment limit.");
    const last = output.at(-1);
    if (last?.translate === translate && (!translate || [...last.text + text].length <= maximum)) last.text += text;
    else output.push({ text, translate });
  };
  append(header, false);
  const gap = (text: string) => {
    const last = output.at(-1);
    if (last?.translate && [...last.text + text].length <= maximum) last.text += text;
    else append(text, false);
  };
  let cursor = 0;
  for (const node of parse(body).children) {
    const start = node.position!.start.offset!, end = node.position!.end.offset!;
    gap(body.slice(cursor, start));
    if (node.type === "list" && [...body.slice(start, end)].length > maximum) {
      let itemStart = start;
      for (const item of node.children) {
        const itemEnd = item.position!.end.offset!;
        append(body.slice(itemStart, itemEnd), true); itemStart = itemEnd;
      }
      append(body.slice(itemStart, end), false);
    } else append(body.slice(start, end), !["code", "html", "definition"].includes(node.type));
    cursor = end;
  }
  gap(body.slice(cursor));
  return output;
}
