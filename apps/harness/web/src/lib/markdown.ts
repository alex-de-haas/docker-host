// The two pieces of markdown policy the transcript needs that Marketplace's renderer does not.
//
// Rendering itself is `react-markdown` + `remark-gfm`, the same pair
// `apps/marketplace/src/components/markdown-description.tsx` uses — one markdown implementation in
// the repository, not two. What differs is the source: Marketplace renders a description fetched
// from a catalog URL, so it resolves relative links against that base. A transcript has no base and
// no trusted origin — it renders whatever an agent was talked into writing — so its policy is
// stricter and lives here, pure and tested, rather than inline in the component.

/** Anything with `children` — the parts of an mdast tree this module walks. */
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/**
 * Keeps a link that navigates and drops one that executes.
 *
 * `react-markdown` sanitizes urls on its own; naming the allowed schemes here makes the transcript's
 * rule visible and testable instead of inherited. A refused target becomes an empty href, which
 * keeps the operator's ability to read the text of the link they were nearly sold.
 */
export function transformChatUrl(value: string): string {
  const href = value.trim();
  if (href.startsWith("#")) {
    return href;
  }
  try {
    const url = new URL(href);
    const allowed = url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
    // Credentials in a link are how a plausible-looking host hides the real one.
    return allowed && !url.username && !url.password ? url.href : "";
  } catch {
    // Relative to what? A transcript has no base document, so a relative target resolves to nothing.
    return "";
  }
}

/**
 * A remark plugin that keeps a single newline as a line break.
 *
 * CommonMark folds a soft break into a space. Harnesses write line-per-item prose, and the
 * transcript rendered it verbatim before it rendered markdown at all — so following the spec here
 * would silently reflow messages that used to read correctly. Hard breaks are untouched: they are
 * already `break` nodes by the time this runs.
 */
export function remarkSoftBreaks() {
  return (tree: MarkdownNode): void => {
    splitSoftBreaks(tree);
  };
}

function splitSoftBreaks(node: MarkdownNode): void {
  if (!node.children) {
    return;
  }
  const rewritten: MarkdownNode[] = [];
  for (const child of node.children) {
    // Only literal text is split. Code — inline or fenced — carries its newlines in `value` and no
    // children, so it is never reached, which is what keeps a code block's own line endings intact.
    if (child.type === "text" && child.value?.includes("\n")) {
      const lines = child.value.split("\n");
      lines.forEach((line, index) => {
        if (index > 0) {
          rewritten.push({ type: "break" });
        }
        if (line) {
          rewritten.push({ type: "text", value: line });
        }
      });
      continue;
    }
    splitSoftBreaks(child);
    rewritten.push(child);
  }
  node.children = rewritten;
}
