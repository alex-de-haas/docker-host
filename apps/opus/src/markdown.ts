import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Nodes } from 'mdast';
import { ProviderError } from '@hosty-sdk/app/providers';

const protectedTypes = new Set(['code', 'inlineCode', 'html', 'image', 'imageReference', 'definition']);
const parse = (text: string) => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
const frontmatter = (text: string) => text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? '';
const escape = (text: string) => text.replace(/([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '\\$1');
type Piece = { literal: string } | { index: number };
type Replacement = { start: number; end: number; pieces: Piece[] };
export type ProseDocument = { source: string; fragments: string[]; replacements: Replacement[]; markdown: boolean };

/** Extract decoded prose; model output never owns Markdown delimiters or executable content. */
export function prepareDocument(source: string, markdown: boolean): ProseDocument {
  const result: ProseDocument = { source, fragments: [], replacements: [], markdown };
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const pieces = (value: string): Piece[] => {
    const output: Piece[] = [];
    // Deliverable identifiers are copied literally, including IDs inside a prose sentence.
    for (const part of value.split(/(\bD\d+\b[.:]?)/g)) {
      if (/^D\d+\b[.:]?$/.test(part)) { output.push({ literal: markdown ? escape(part) : part }); continue; }
      const normalized = part.replace(/[\r\n]/g, ' ');
      // Punctuation beside inline delimiters determines whether emphasis parses at all.
      const prefix = markdown ? normalized.match(/^[^\p{L}\p{N}]*/u)![0] : '';
      if (prefix) output.push({ literal: escape(prefix) });
      for (const { segment } of segmenter.segment(normalized.slice(prefix.length))) {
        const text = segment.trim();
        if (!/\p{L}/u.test(text)) { output.push({ literal: markdown ? escape(segment) : segment }); continue; }
        const leading = segment.slice(0, segment.length - segment.trimStart().length);
        const trailing = segment.slice(segment.trimEnd().length);
        output.push({ literal: leading }, { index: result.fragments.length }, { literal: trailing });
        result.fragments.push(text);
      }
    }
    return output;
  };
  if (!markdown) {
    // Plain-text paragraph boundaries remain intact and are not sent through Markdown parsing.
    const lines = /[^\r\n]+/g;
    for (const match of source.matchAll(lines)) result.replacements.push({ start: match.index, end: match.index + match[0].length, pieces: pieces(match[0]) });
  } else {
    const offset = frontmatter(source).length;
    const visit = (node: Nodes) => {
      if (protectedTypes.has(node.type)) return;
      // Autolink labels and shortcut/collapsed reference labels are also their destinations/IDs.
      if (node.type === 'link' && !source.slice(offset + node.position!.start.offset!, offset + node.position!.end.offset!).startsWith('[')) return;
      if (node.type === 'linkReference' && node.referenceType !== 'full') return;
      if (node.type === 'text') {
        result.replacements.push({ start: offset + node.position!.start.offset!, end: offset + node.position!.end.offset!, pieces: pieces(node.value) });
      } else if ('children' in node) for (const child of node.children) visit(child as Nodes);
    };
    visit(parse(source.slice(offset)));
  }
  if (result.fragments.length > 8192) throw new ProviderError('translation_too_large', 'The document contains too many prose fragments.', 413);
  return result;
}

export function restoreDocument(document: ProseDocument, translations: string[]): string {
  if (translations.length !== document.fragments.length || translations.some(t => typeof t !== 'string' || !t.trim() || /[\r\n\0]/.test(t)))
    throw new ProviderError('translation_result_invalid', 'The model returned incomplete prose.', 502);
  let output = '', cursor = 0;
  for (const replacement of document.replacements) {
    output += document.source.slice(cursor, replacement.start);
    for (const piece of replacement.pieces) output += 'literal' in piece ? piece.literal : document.markdown ? escape(translations[piece.index]!.trim()) : translations[piece.index]!.trim();
    cursor = replacement.end;
  }
  output += document.source.slice(cursor);
  if (document.markdown && signature(document.source) !== signature(output))
    throw new ProviderError('translation_markdown_changed', 'Protected Markdown structure could not be preserved. The source is unchanged.', 502);
  return output;
}

// Matches the existing provider contract: structure, list markers, IDs and machine content are fixed.
function signature(markdown: string): string {
  const metadata = frontmatter(markdown), source = markdown.slice(metadata.length);
  const visit = (node: Nodes): unknown => {
    if (protectedTypes.has(node.type)) return [node.type, source.slice(node.position!.start.offset, node.position!.end.offset)];
    const { position: _position, value: _value, children: _children, ...properties } = node as Nodes & { value?: string; children?: Nodes[] };
    if (node.type === 'text') return ['text', ...[...node.value.matchAll(/\bD\d+\b/g)].map(match => match[0])];
    const marker = node.type === 'listItem' ? source.slice(node.position!.start.offset, node.position!.end.offset).match(/^(?:[-+*]|\d+[.)])/)?.[0] : undefined;
    return [properties, marker, ...('children' in node ? node.children.map(child => visit(child as Nodes)) : [])];
  };
  return JSON.stringify([metadata, visit(parse(source))]);
}
