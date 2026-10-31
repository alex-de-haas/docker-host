// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Markdown } from "./markdown";
import { PullRequestMarkdown } from "./pull-request-markdown";

vi.mock("@/components/chat-code-block", () => ({
  ChatCodeBlock: ({ code }: { code: string }) => <pre><code>{code}</code></pre>,
}));
function render(text: string) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<PullRequestMarkdown text={text} />);
  return container;
}

describe("PR Markdown with embedded HTML", () => {
  it("renders compact Dependabot HTML as a working native disclosure", () => {
    const container = render('Bumps **node-server**.\n\n<details><summary>Release notes</summary><p><em>Sourced from <a href="https://github.com/example/repo/releases">releases</a>.</em></p><blockquote><h2>2.1.5</h2><ul><li>Fix <code>request.signal</code>.</li></ul></blockquote></details>');
    const details = container.querySelector("details")!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Release notes");
    details.querySelector("summary")!.click();
    expect(details.open).toBe(true);
    details.querySelector("summary")!.click();
    expect(details.open).toBe(false);
    expect(container.querySelector("strong")?.textContent).toBe("node-server");
    expect(details.querySelector("blockquote h4")?.textContent).toBe("2.1.5");
    expect(details.querySelector("li code")?.textContent).toBe("request.signal");
    expect(container.textContent).not.toContain("<details>");
    expect(details.querySelector("a")?.target).toBe("_blank");
    expect(details.querySelector("a")?.rel).toBe("noopener noreferrer");
  });
  it("preserves Markdown lists, tables, task lists and literal code inside HTML", () => {
    const container = render('<details open><summary>Commits</summary>\n\n- **Fix** the client\n- [Compare](https://github.com/example/repo/compare/a...b)\n\n| Before | After |\n| --- | --- |\n| 2.1.0 | 2.1.5 |\n\n- [x] Tests passed\n\n```html\n<script>literal example</script>\n```\n\n</details>');
    expect(container.querySelector("details")?.open).toBe(true);
    expect(container.querySelector("li strong")?.textContent).toBe("Fix");
    expect(container.querySelectorAll("td")).toHaveLength(2);
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
    expect(container.querySelector("pre code")?.textContent).toContain("<script>literal example</script>");
    expect(container.querySelector("script")).toBeNull();
  });
  it("removes active HTML, layout overrides and unsafe links while keeping readable content", () => {
    const container = render(`<details ontoggle="alert(1)" style="position:fixed;inset:0"><summary onclick="alert(1)" accesskey="x" tabindex="-1">Safe summary</summary>
<script>alert('script payload')</script><style>body{display:none}</style>
<iframe src="https://example.com/embed"></iframe><object data="https://example.com/embed"></object>
<form action="https://example.com/post"><input name="secret"><button>Submit</button></form>
<svg onload="alert(1)"><a href="javascript:alert(1)">svg</a></svg>
<p id="location" name="cookie" onclick="alert(1)">Readable text</p>
<a href="jav&#x61;script:alert(1)">Unsafe script</a>
<a href="data:text/html,unsafe">Unsafe data</a><a href="/api/admin">Relative</a>
<a href="https://trusted.test:password@evil.test/">Credentials</a>
<a href="https://github.com/example/repo" target="_self">Safe link</a>
</details>`);
    expect(container.querySelector("script,style,iframe,object,embed,form,button,svg,math")).toBeNull();
    expect(container.querySelector("[style],[onclick],[ontoggle],[onload],[accesskey],[tabindex]")).toBeNull();
    expect(container.querySelector("#location,[name=cookie]")).toBeNull();
    expect(container.textContent).toContain("Readable text");
    expect(container.textContent).toContain("Unsafe script");
    expect(container.textContent).not.toContain("script payload");
    expect(container.textContent).not.toContain("body{display:none}");
    expect(Array.from(container.querySelectorAll("a"), a => a.href)).toEqual(["https://github.com/example/repo"]);
  });
  it("keeps HTML and Markdown images inert, including picture sources", () => {
    const container = render('<picture><source srcset="https://tracker.test/a 1x, https://tracker.test/b 2x"><img src="https://tracker.test/pixel" alt="Build badge" onerror="alert(1)"></picture>\n\n![Preview](https://example.com/preview.png)\n\n<img src="javascript:alert(1)" alt="Unavailable">');
    expect(container.querySelector("img,picture,source")).toBeNull();
    expect(container.querySelector('a[href="https://tracker.test/pixel"]')?.textContent).toBe("Build badge");
    expect(container.querySelector('a[href="https://example.com/preview.png"]')?.textContent).toBe("Preview");
    expect(container.textContent).toContain("Unavailable");
  });
  it("recovers an unclosed disclosure and preserves inline code as text", () => {
    const container = render('<details><summary>Incomplete provider text</summary>\n\nRead `<img src=x onerror=alert(1)>` as code.');
    expect(container.querySelector("details summary")?.textContent).toBe("Incomplete provider text");
    expect(container.querySelector("code")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
  });
  it("leaves HTML escaping in the shared chat renderer unchanged", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<Markdown text="<details><summary>Literal HTML in chat</summary></details>" />);
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain("<details><summary>Literal HTML in chat</summary></details>");
  });
});
