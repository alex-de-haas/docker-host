import { describe, expect, it } from "vitest";
import { remarkSoftBreaks, transformChatUrl } from "./markdown";

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/** Runs the plugin over a tree and reports what the paragraph became. */
function rewrite(children: MarkdownNode[]): MarkdownNode[] {
  const tree: MarkdownNode = { type: "root", children: [{ type: "paragraph", children }] };
  remarkSoftBreaks()(tree);
  return tree.children![0].children!;
}

describe("transcript markdown URL policy", () => {
  it("keeps the schemes an operator would follow", () => {
    expect(transformChatUrl("https://hosty.local/docs")).toBe("https://hosty.local/docs");
    expect(transformChatUrl("mailto:ops@hosty.local")).toBe("mailto:ops@hosty.local");
    expect(transformChatUrl("#findings")).toBe("#findings");
  });

  it.each(["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd", "vbscript:x"])(
    "drops a href that executes rather than navigates: %s",
    value => {
      // Transcript content is agent output, and an agent can be talked into writing anything. A link
      // is the one place that text would otherwise become script on the panel's own origin.
      expect(transformChatUrl(value)).toBe("");
    },
  );

  it("drops credentials smuggled into the authority", () => {
    expect(transformChatUrl("https://hosty.local:secret@evil.test/apps")).toBe("");
  });

  it("drops a relative reference, having no base to resolve it against", () => {
    // Marketplace resolves these against the catalog document that carried them. A transcript has no
    // such document, so a relative target would resolve against the panel's own URL — a link into
    // the operator's session dressed as a link into the docs.
    expect(transformChatUrl("images/screen.png")).toBe("");
    expect(transformChatUrl("/apps")).toBe("");
  });
});

describe("soft breaks", () => {
  it("keeps a single newline visible, as the plain-text transcript did", () => {
    // Harnesses write line-per-item prose; CommonMark's fold to a space would silently reflow
    // messages that read correctly before anything rendered markdown at all.
    expect(rewrite([{ type: "text", value: "first\nsecond" }])).toEqual([
      { type: "text", value: "first" },
      { type: "break" },
      { type: "text", value: "second" },
    ]);
  });

  it("leaves code alone, inline or fenced", () => {
    // Their newlines live in `value` with no children to walk, which is what keeps a code block's
    // own line endings intact rather than shredded into breaks.
    const code = [
      { type: "inlineCode", value: "a\nb" },
      { type: "code", value: "hosty core start\nhosty apps list" },
    ];
    expect(rewrite(code)).toEqual(code);
  });

  it("reaches text nested inside emphasis and links", () => {
    const [strong] = rewrite([{ type: "strong", children: [{ type: "text", value: "over\nthere" }] }]);
    expect(strong.children).toEqual([
      { type: "text", value: "over" },
      { type: "break" },
      { type: "text", value: "there" },
    ]);
  });

  it("emits a break per newline, so a deliberate blank line stays one", () => {
    expect(rewrite([{ type: "text", value: "one\n\ntwo" }]).filter(node => node.type === "break")).toHaveLength(2);
  });

  it("leaves text without newlines untouched", () => {
    expect(rewrite([{ type: "text", value: "nothing to split" }])).toEqual([{ type: "text", value: "nothing to split" }]);
  });
});
