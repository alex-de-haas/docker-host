// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CodeBlock } from "./reui/code-block/code-block";
import { DEFAULT_CODE_BLOCK_THEMES, highlightCode } from "./reui/code-block/code-block-highlight";

describe("code block review regressions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the matching default theme when either theme name is unknown", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const code = 'const value = "hello";';
    const expected = await highlightCode(code, { language: "typescript" });
    expect(expected.some(line => line.tokens.some(token => token.colorDark && token.colorDark !== token.color))).toBe(true);
    const actual = await highlightCode(code, {
      language: "typescript",
      themes: { light: "missing-review-light", dark: "missing-review-dark" },
    });
    expect(actual).toEqual(expected);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(DEFAULT_CODE_BLOCK_THEMES.dark));
  });

  it("unfolds using source line keys when displayed line numbers are offset", async () => {
    const onFoldedChange = vi.fn();
    await act(async () => root.render(<CodeBlock
      code={'function example() {\n  return 42;\n}'} highlight={false}
      startLine={40} foldable foldRegions={[{ start: 1, end: 3 }]}
      defaultFolded={[1]} onFoldedChange={onFoldedChange}
    />));
    expect(container.querySelector('[data-code-line="41"]')).toBeNull();
    const marker = container.querySelector<HTMLButtonElement>('[data-slot="code-block-fold-marker"]');
    expect(marker).not.toBeNull();
    await act(async () => marker!.click());
    expect(onFoldedChange).toHaveBeenLastCalledWith([]);
    expect(container.querySelector('[data-code-line="41"]')?.textContent).toContain("return 42;");
    expect(container.querySelector('[data-slot="code-block-fold-marker"]')).toBeNull();
  });

  it("announces completion once per streaming transition in Strict Mode", async () => {
    const render = async (streaming: boolean, code: string) => {
      await act(async () => root.render(<StrictMode>
        <CodeBlock code={code} highlight={false} streaming={streaming} />
      </StrictMode>));
    };
    const announcement = () => container.querySelector('[aria-live="polite"]')?.textContent;
    await render(false, "first");
    expect(announcement()).toBe("");
    await render(true, "first\nsecond");
    expect(announcement()).toBe("");
    await render(false, "first\nsecond");
    expect(announcement()).toBe("Code generation complete, 2 lines.");
    await render(false, "first\nsecond\nthird");
    expect(announcement()).toBe("Code generation complete, 2 lines.");
    await render(true, "next");
    expect(announcement()).toBe("");
    await render(false, "next");
    expect(announcement()).toBe("Code generation complete, 1 lines.");
  });
});
