import {
  headings,
  documentLinks,
  documentKind,
  documentIndex,
} from "../../../../scripts/docs-format.mjs";
import type { ParsedDocument, PlanCard } from "./types";

export function enrichDocuments(
  documents: ParsedDocument[],
  complete = true,
): ParsedDocument[] {
  const byPath = new Map(
    documents.map((document) => [document.path, document]),
  );
  const backlinks = new Map<
    string,
    { path: string; title: string; anchor: string }[]
  >();
  const errors = new Map<string, string[]>();
  for (const document of documents) {
    for (const link of document.links ??
      documentLinks(document.path, document.content)) {
      if (!link.path) continue; // Path validation is already supplied by the exact Core snapshot.
      const target = byPath.get(link.path);
      if (!target) continue; // Missing, inaccessible and non-document targets are not interchangeable.
      if (
        link.anchor &&
        target.content &&
        !(target.headings ?? headings(target.content)).some(
          (heading) => heading.id === link.anchor,
        )
      ) {
        const messages = errors.get(document.path) ?? [];
        messages.push(
          `Line ${link.line}: missing anchor #${link.anchor} in ${link.path}.`,
        );
        errors.set(document.path, messages);
      }
      if (link.path !== document.path) {
        const incoming = backlinks.get(link.path) ?? [];
        if (
          !incoming.some(
            (item) =>
              item.path === document.path && item.anchor === link.anchor,
          )
        )
          incoming.push({
            path: document.path,
            title: document.title,
            anchor: link.anchor,
          });
        backlinks.set(link.path, incoming);
      }
    }
  }
  const root = byPath.get("docs/root.md");
  if (
    root &&
    complete &&
    documents.every((document) => !document.errors.length)
  ) {
    const block = root.content.match(
      /<!-- docs-index:begin -->[\s\S]*?<!-- docs-index:end -->/,
    )?.[0];
    if (block !== documentIndex(documents))
      errors.set(root.path, [
        ...(errors.get(root.path) ?? []),
        "Generated index is stale or missing. Run node scripts/docs-index.mjs --fix.",
      ]);
  }
  return documents.map((document) => {
    const diagnostics = [
      ...new Set([...document.errors, ...(errors.get(document.path) ?? [])]),
    ];
    return {
      ...document,
      errors: diagnostics,
      progress: diagnostics.length ? null : document.progress,
      backlinks: backlinks.get(document.path) ?? [],
    };
  });
}
export function featurePath(path: string) {
  return /^docs\/features\/[^/]+\/(?:plan|feature)\.md$/.test(path)
    ? path.slice(0, path.lastIndexOf("/"))
    : null;
}
export function kindOf(card: PlanCard) {
  return documentKind(card.path);
}
export function attentionReasons(document: ParsedDocument | null): string[] {
  if (!document) return [];
  return [
    ...(document.status === "Blocked" ? ["Plan is blocked"] : []),
    ...(document.questions?.length ? ["Questions to discuss"] : []),
    ...document.errors,
  ];
}
