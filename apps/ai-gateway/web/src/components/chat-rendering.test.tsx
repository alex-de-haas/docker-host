import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown";
import { ChatAttachment } from "./chat-attachment";
import { TranscriptEvent } from "./transcript";
import { indexAttachments } from "../lib/attachments";
import type { AssistantEvent } from "../lib/assistant-api";

describe("chat component integration", () => {
  it("renders an unfinished code fence with copy controls and readable source", () => {
    const html = renderToStaticMarkup(<Markdown streaming text={'Before\n\n```unknown-language\nconst value = "<script>";\n// [!code ++]'} />);
    expect(html).toContain('data-slot="code-block"');
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('// [!code ++]');
    expect(html).not.toContain('<script>');
  });

  it("keeps inline code inline and preserves the markdown link/image policy", () => {
    const html = renderToStaticMarkup(<Markdown text={'Use `npm test`. [unsafe](javascript:alert) ![remote](https://example.com/image.png)'} />);
    expect(html).toContain('<code>npm test</code>');
    expect(html).not.toContain('data-slot="code-block"');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("shows upload errors and a disabled remove action while sending", () => {
    const html = renderToStaticMarkup(<ChatAttachment name="report.txt" size={1024} state="error"
      description="Upload failed · send to retry" disabled onRemove={() => {}} />);
    expect(html).toContain('data-state="error"');
    expect(html).toContain('1.0 KB');
    expect(html).toContain('Upload failed');
    expect(html).toContain('aria-label="Remove report.txt"');
    expect(html).toContain('disabled=""');
  });

  it("shows a stored attachment only under its claiming message, including after replay", () => {
    const events = [
      { seq: 1, type: "attachment_added", name: "stored-report.txt", size: 1024 },
      { seq: 2, type: "notice", message: "Reconnected" },
      { seq: 3, type: "user_message", text: "", attachments: ["stored-report.txt"] },
    ] as AssistantEvent[];
    const attachments = indexAttachments(events);
    const html = renderToStaticMarkup(<>{events.map(event => <TranscriptEvent key={event.seq}
      event={event} attachments={attachments} decision={null} answers={null} denyReason={false}
      onDecide={async () => {}} onAnswer={async () => {}} />)}</>);
    expect(html.match(/data-slot="attachment"/g)).toHaveLength(1);
    expect(html).toContain('stored-report.txt');
    expect(html).toContain('1.0 KB');
    expect(html).not.toContain('Remove stored-report.txt');
  });
});
