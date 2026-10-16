// Experimental prose-only adapter. Not used by the production provider.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes } from "mdast";

export function proseSpans(markdown: string, sentences = true) {
  const offset = markdown.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0].length ?? 0;
  const source = markdown.slice(offset);
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const spans: { start: number; end: number; text: string }[] = [];
  const visit = (node: Nodes) => {
    if (["code", "inlineCode", "html", "image", "imageReference", "definition"].includes(node.type)) return;
    if (node.type === "text") {
      const start = offset + node.position!.start.offset!;
      const raw = markdown.slice(start, offset + node.position!.end.offset!);
      // This probe supports the plain text leaves in the benchmark, not a general Markdown codec.
      if (raw !== node.value) throw new Error("Probe adapter requires plain text leaves without entities or escapes.");
      let cursor = 0;
      const append = (end: number) => {
        const fragment = raw.slice(cursor, end);
        const chunks = sentences ? [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(fragment)]
          : [{ segment: fragment, index: 0 }];
        for (const chunk of chunks) {
          const text = chunk.segment.trim();
          if (/[\p{L}]/u.test(text)) {
            const leading = chunk.segment.length - chunk.segment.trimStart().length;
            const begin = start + cursor + chunk.index + leading;
            spans.push({ start: begin, end: begin + text.length, text });
          }
        }
      };
      for (const id of raw.matchAll(/\bD\d+\b[.:]?/g)) { append(id.index); cursor = id.index + id[0].length; }
      append(raw.length);
    } else if ("children" in node) for (const child of node.children) visit(child as Nodes);
  };
  visit(tree);
  return spans;
}

export function restoreProse(source: string, spans: ReturnType<typeof proseSpans>, translations: string[]) {
  if (spans.length !== translations.length) throw new Error("Missing prose translations.");
  let output = "", cursor = 0;
  for (let i = 0; i < spans.length; i++) {
    const translated = translations[i].trim();
    if (!translated || /[\r\n]/.test(translated)) throw new Error("Expected a nonempty single-line translation.");
    // Escape all ASCII punctuation that can acquire Markdown semantics after substitution.
    const escaped = translated.replace(/([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "\\$1");
    output += source.slice(cursor, spans[i].start) + escaped;
    cursor = spans[i].end;
  }
  return output + source.slice(cursor);
}
