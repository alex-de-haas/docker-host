// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolActivity, TranscriptEvent } from "./transcript";
import { transcriptItems } from "@/lib/transcript-items";
import type { AssistantEvent } from "@/lib/assistant-api";
import type { DevelopmentWorkspace } from "@/lib/development-api";
let root: Root, container: HTMLDivElement;
const event = (seq: number, type: string, extra = {}): AssistantEvent => ({ seq, ts: "", type, ...extra });
const click = (node: HTMLElement) => act(async () => node.click());
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.includes(text))!;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("keeps reads expandable and preserves expanded tool input as more reads arrive", async () => {
  const first = event(1, "tool_use", { toolName: "Read", input: { file_path: "src/one.ts" } });
  await act(async () => root.render(<ToolActivity events={[first]} />));
  expect(container.textContent).toContain("1 tool call"); expect(container.textContent).not.toContain("src/one.ts");
  await click(button("1 tool call")); await click(button("Readsrc/one.ts")); expect(container.textContent).toContain('"file_path"');
  const control = button("Readsrc/one.ts"); control.focus();
  await act(async () => root.render(<ToolActivity events={[first, event(2, "tool_use", { toolName: "Grep", input: { pattern: "needle" } })]} />));
  expect(container.textContent).toContain("2 tool calls"); expect(container.textContent).toContain('"file_path"'); expect(container.textContent).toContain("needle"); expect(document.activeElement).toBe(control);
});
it("shows same-file recorded totals once per exact repository and keeps Review links and raw tool inputs", async () => {
  const workspace = (id: string): DevelopmentWorkspace => ({ id, state: "active", workflow: { state: "in-progress", revision: 0 }, owner: { kind: "assistant", appId: "hosty.harness", reference: "session", label: "Session" }, worktrees: [{ id: `tree-${id}`, workspaceId: id, repository: `https://github.com/example/${id}`, branch: "feature", state: "active", apps: [], leases: [], pullRequests: [] }] });
  const ref = (id: string) => ({ sessionId: "session", workspaceId: id, worktreeId: `tree-${id}`, repository: `https://github.com/example/${id}`, path: "src/index.ts" });
  const edit = (seq: number, id: string, additions: number, deletions: number) => event(seq, "tool_use", { toolName: "Edit", input: { file_path: `/${id}/src/index.ts`, old_string: "old", new_string: "new" }, fileEdits: [{ path: "src/index.ts", kind: "edit", additions, deletions, review: ref(id) }] });
  const open = vi.fn(); await act(async () => root.render(<ToolActivity events={[edit(1, "one", 2, 1), edit(2, "one", 3, 2), edit(3, "two", 1, 1)]} reviewContext={{ sessionId: "session", workspaces: [workspace("one"), workspace("two")], onOpen: open }} />));
  const tools = button("3 tool calls");
  const changes = button("Changes · 2 files");
  expect(changes.textContent).toContain("+6"); expect(changes.textContent).toContain("−4");
  expect(changes.getAttribute("aria-expanded")).toBe("false"); expect(tools.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelectorAll('button[aria-label="Review src/index.ts"]')).toHaveLength(0);
  await click(changes);
  expect(tools.getAttribute("aria-expanded")).toBe("false");
  const links = container.querySelectorAll<HTMLButtonElement>('button[aria-label="Review src/index.ts"]'); expect(links).toHaveLength(2);
  expect(links[0].textContent).toContain("+5"); expect(links[0].textContent).toContain("−3");
  const files = container.querySelector('[aria-label="File edits"]')!;
  expect([...files.querySelectorAll("h4")].map(node => node.textContent)).toEqual(["one", "two"]);
  expect(files.textContent).not.toContain("feature"); expect(files.textContent).not.toContain("Recorded edits in this section");
  await click(links[1]); expect(open).toHaveBeenCalledWith(ref("two"));
  await click(tools);
  expect(container.querySelector('[data-slot="tool-activity"] button[aria-label="Review src/index.ts"]')).toBeNull();
  expect(container.textContent).toContain("/one/src/index.ts"); expect(container.textContent).toContain("/two/src/index.ts");
});
it("updates a command result in place while retaining input disclosure and excludes raw output or arbitrary summaries", async () => {
  const call = event(1, "tool_use", { toolName: "Bash", toolUseId: "command:first", input: { command: "npm test", description: "Run tests" } });
  const render = (events: AssistantEvent[]) => act(async () => root.render(<>{transcriptItems(events, new Set()).map(item => item.kind === "activity" ? <ToolActivity key={item.key} events={item.events} commandResults={item.commandResults} toolResults={item.toolResults} /> : null)}</>));
  await render([call]); await click(button("1 tool call")); expect(container.textContent).toContain("Outcome unavailable"); expect(container.textContent).not.toContain("Completed"); await click(button("Run tests")); expect(container.textContent).toContain('"command"');
  const inputNode = button("Run tests"); inputNode.focus();
  await render([call, event(2, "command_result", { toolUseId: "command:first", status: "completed", exitCode: 0, durationMs: 4_000, summary: "14 passed", stdout: "super-secret-output", output: "raw-output" })]);
  expect(container.textContent).toContain("Completed"); expect(container.textContent).toContain("Exit 0"); expect(container.textContent).toContain("4 s"); expect(container.textContent).toContain("14 passed"); expect(container.textContent).toContain('"command"'); expect(document.activeElement).toBe(inputNode); expect(container.textContent).not.toMatch(/super-secret-output|raw-output/);
  await render([call, event(2, "command_result", { toolUseId: "command:first", status: "failed", exitCode: 1, summary: "token=private-secret" }), event(3, "tool_result", { toolUseId: "command:first", status: "failed", output: "The check failed." })]);
  expect(container.textContent).toContain("Failed"); expect(container.textContent).not.toContain("private-secret");
  expect(inputNode.textContent).toContain("Failed"); expect(inputNode.textContent).toContain("Exit 1");
  expect(container.textContent).toContain("Tool output"); expect(container.textContent).toContain("The check failed."); expect(container.textContent).not.toContain("Tool failed");
  expect(inputNode.querySelector("button")).toBeNull();
});
it("keeps legacy commands unknown and unmatched results explicit without replaying output", async () => {
  await act(async () => root.render(<><ToolActivity events={[event(1, "tool_use", { toolName: "Command", input: { command: "old command" } })]} /><TranscriptEvent event={event(2, "command_result", { toolUseId: "orphan", status: "failed", exitCode: 2, summary: "1 failed", output: "secret" })} decision={null} answers={null} denyReason={false} onDecide={vi.fn()} onAnswer={vi.fn()} /></>));
  await click(button("1 tool call")); await click(button("old command"));
  expect(container.textContent).toContain("older call has no recorded result identity"); expect(container.textContent).toContain("Command result has no unique matching call in this turn"); expect(container.textContent).toContain("Exit 2"); expect(container.textContent).not.toContain("secret");
});


it("reveals call-matched output without losing expanded input or focus when a result arrives", async () => {
  const call = event(1, "tool_use", { toolName: "mcp__core__list_apps", toolUseId: "mcp:one", input: {} });
  const render = (events: AssistantEvent[]) => act(async () => root.render(<>{transcriptItems(events, new Set()).map(item => item.kind === "activity" ? <ToolActivity key={item.key} events={item.events} toolResults={item.toolResults} /> : null)}</>));
  await render([call]); await click(button("1 tool call"));
  const control = container.querySelector<HTMLButtonElement>('[data-slot="collapsible-content"] button')!; await click(control);
  expect(container.textContent).toContain("Tool input"); expect(container.textContent).toContain("Tool output was not recorded");
  control.focus();
  const result = event(2, "tool_result", { toolUseId: "mcp:one", status: "completed", output: '{"apps":["Demo App"]}' });
  await render([call, result]);
  expect(document.activeElement).toBe(control); expect(container.textContent).toContain("Tool input");
  expect(container.textContent).toContain("Tool output"); expect(container.textContent).toContain('"Demo App"');
  expect(container.textContent).not.toContain("was not recorded");
  await render([call, { ...result, status: "failed", output: "denied", truncated: true }]);
  expect(container.textContent).toContain("Tool failed"); expect(container.textContent).toContain("denied"); expect(container.textContent).toContain("Output truncated");
});
it("renders tool output as inert text and hides unmatched result content", async () => {
  const call = event(1, "tool_use", { toolName: "Read", toolUseId: "read:one", input: {} });
  await act(async () => root.render(<ToolActivity events={[call]} toolResults={{ 1: { status: "completed", output: '<img src=x onerror="alert(1)">' } }} />));
  await click(button("1 tool call")); await click(container.querySelector<HTMLButtonElement>('[data-slot="collapsible-content"] button')!);
  expect(container.querySelector("img")).toBeNull(); expect(container.textContent).toContain("<img");
  await act(async () => root.render(<TranscriptEvent event={event(2, "tool_result", { toolUseId: "orphan", status: "completed", output: "unmatched-private-content" })} decision={null} answers={null} denyReason={false} onDecide={vi.fn()} onAnswer={vi.fn()} />));
  expect(container.textContent).toContain("no unique matching call"); expect(container.textContent).not.toContain("unmatched-private-content");
});

it("keeps a command group and expanded call stable as commands and matching results arrive", async () => {
  const first = event(1, "tool_use", { toolName: "Bash", toolUseId: "command:first", input: { command: "npm test", description: "Run tests" } });
  const second = event(2, "tool_use", { toolName: "Command", toolUseId: "command:second", input: { command: "npm run build", description: "Build app" } });
  const render = (events: AssistantEvent[]) => act(async () => root.render(<>{transcriptItems(events, new Set()).map(item => item.kind === "activity" ? <ToolActivity key={item.key} events={item.events} commandResults={item.commandResults} toolResults={item.toolResults} /> : null)}</>));
  await render([first]);
  const group = button("1 tool call");
  expect(button("Run tests")).toBeUndefined();
  await click(group); await click(button("Run tests"));
  const control = button("Run tests"); control.focus();
  await render([first, second]);
  expect(button("2 tool calls")).toBe(group); expect(group.getAttribute("aria-expanded")).toBe("true");
  expect(button("Run tests")).toBe(control); expect(document.activeElement).toBe(control);
  expect(control.getAttribute("aria-expanded")).toBe("true"); expect(container.textContent).toContain('"command": "npm test"');
  const results = [event(3, "command_result", { toolUseId: "command:second", status: "failed", exitCode: 1, durationMs: 7 }), event(4, "tool_result", { toolUseId: "command:first", status: "completed", output: "Tests passed." }), event(5, "command_result", { toolUseId: "command:first", status: "completed", exitCode: 0, durationMs: 12 })];
  await render([first, second, ...results]);
  expect(document.activeElement).toBe(control); expect(control.textContent).toContain("Completed"); expect(control.textContent).toContain("Exit 0"); expect(control.textContent).toContain("12 ms");
  expect(button("npm run build").textContent).toContain("Failed"); expect(button("npm run build").textContent).toContain("Exit 1"); expect(button("npm run build").textContent).toContain("7 ms");
  expect(container.textContent).toContain("Tests passed."); expect(container.textContent).not.toContain("Tool failed");
  await click(group); expect(group.getAttribute("aria-expanded")).toBe("false"); expect(button("Run tests")).toBeUndefined();
  await render([first, second, ...results, event(6, "tool_use", { toolName: "Bash", toolUseId: "command:third", input: { command: "npm run lint" } })]);
  expect(button("3 tool calls")).toBe(group); expect(group.getAttribute("aria-expanded")).toBe("false");
});

it("collapses mixed calls into one section and reveals a flat list in recorded order", async () => {
  const calls = [event(1, "tool_use", { toolName: "Command", toolUseId: "cmd:one", input: { command: "first command" } }), event(2, "tool_use", { toolName: "mcp__core__list_apps", toolUseId: "mcp:one", input: {} }), event(3, "tool_use", { toolName: "Read", toolUseId: "read:one", input: { file_path: "src/app.ts" } }), event(4, "tool_use", { toolName: "Bash", toolUseId: "cmd:two", input: { command: "second command" } })];
  await act(async () => root.render(<ToolActivity events={calls} commandResults={{ 1: { status: "failed", exitCode: 1 }, 4: { status: "completed", exitCode: 0 } }} />));
  expect(container.querySelectorAll("button")).toHaveLength(1); expect(button("4 tool calls").textContent).toContain("1 failed");
  await click(button("4 tool calls"));
  const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="collapsible-content"] button[aria-expanded]')];
  expect(rows).toHaveLength(4); expect(rows[0].textContent).toContain("first command"); expect(rows[0].textContent).toContain("Failed");
  expect(rows[1].textContent).toContain("list_apps"); expect(rows[2].textContent).toContain("src/app.ts"); expect(rows[3].textContent).toContain("second command"); expect(rows[3].textContent).toContain("Completed");
  expect(container.querySelectorAll('[data-slot="collapsible-trigger"]')).toHaveLength(1);
  for (const row of rows) expect(row.querySelector("button")).toBeNull();
  await click(rows[1]); expect(container.textContent).toContain("Tool input"); expect(container.textContent).toContain("Tool output was not recorded");
});

it("updates the collapsed failure count once per call from matched recorded outcomes", async () => {
  const calls = [event(1, "tool_use", { toolName: "Command", toolUseId: "cmd:one", input: { command: "check" } }), event(2, "tool_use", { toolName: "mcp__core__list_apps", toolUseId: "mcp:one", input: {} })];
  const render = (events: AssistantEvent[]) => act(async () => root.render(<>{transcriptItems(events, new Set()).map(item => item.kind === "activity" ? <ToolActivity key={item.key} events={item.events} commandResults={item.commandResults} toolResults={item.toolResults} /> : null)}</>));
  await render(calls);
  const group = button("2 tool calls"); group.focus();
  expect(group.textContent).not.toContain("failed");
  const results = [event(3, "command_result", { toolUseId: "cmd:one", status: "failed", exitCode: 1 }), event(4, "tool_result", { toolUseId: "cmd:one", status: "failed", output: "command failed" }), event(5, "tool_result", { toolUseId: "mcp:one", status: "failed", output: "MCP failed" })];
  await render([...calls, ...results, { ...results[0], seq: 6 }, { ...results[2], seq: 7 }]);
  expect(button("2 tool calls")).toBe(group); expect(group.textContent).toContain("2 failed");
  expect(group.getAttribute("aria-expanded")).toBe("false"); expect(document.activeElement).toBe(group);
  expect(container.textContent).not.toContain("command failed"); expect(container.textContent).not.toContain("MCP failed");
  await click(group); expect(group.textContent).toContain("2 failed");
  expect(button("check").textContent).toContain("Failed");
});
it("counts only confirmed failures and keeps command metadata authoritative", async () => {
  const calls = Array.from({length: 9}, (_, index) => event(index + 1, "tool_use", { toolName: index < 4 ? "Command" : "mcp__core__check", toolUseId: `call:${index}` }));
  await act(async () => root.render(<ToolActivity events={calls}
    commandResults={{ 1: { status: "completed" }, 2: { status: "unknown" }, 3: { status: "unknown", conflict: true } }}
    toolResults={{ 1: { status: "failed", output: "" }, 2: { status: "failed", output: "" }, 3: { status: "failed", output: "" }, 4: { status: "failed", output: "" }, 5: { status: "cancelled", output: "" }, 6: { status: "unknown", output: "" }, 7: { status: "unknown", output: "", conflict: true }, 8: { status: "failed", output: "" }, 9: { status: "completed", output: "" } }} />));
  expect(button("9 tool calls").textContent).toContain("1 failed");
});

it("keeps Changes independent and stable as edits arrive between other calls", async () => {
  const ref = { sessionId: "session", workspaceId: "workspace", worktreeId: "tree", repository: "repo", path: "README.md" };
  const edit = (seq: number, additions?: number) => event(seq, "tool_use", { toolName: "FileChange", input: { changes: [{ path: "README.md" }] }, fileEdits: [{ path: "README.md", kind: "edit", additions, deletions: 0, review: ref }] });
  const command = event(1, "tool_use", { toolName: "Command", toolUseId: "command:one", input: { command: "check changes" } });
  const render = (events: AssistantEvent[]) => act(async () => root.render(<ToolActivity events={events} />));
  await render([command]); expect(container.querySelector('[data-slot="transcript-changes"]')).toBeNull();
  await click(button("1 tool call")); const control = button("check changes"); await click(control); control.focus();
  await render([command, edit(2, 3)]);
  expect(document.activeElement).toBe(control); expect(control.getAttribute("aria-expanded")).toBe("true");
  const changes = button("Changes · 1 file"); await click(changes); control.focus();
  const mcp = event(3, "tool_use", { toolName: "mcp__core__check", input: {} });
  await render([command, edit(2, 3), mcp, edit(4, 2)]);
  expect(button("Changes · 1 file")).toBe(changes); expect(changes.textContent).toContain("+5");
  expect(changes.getAttribute("aria-expanded")).toBe("true"); expect(document.activeElement).toBe(control);
  expect(container.querySelectorAll('button[aria-label="Review README.md"]')).toHaveLength(1);
  expect(container.querySelector('[data-slot="tool-activity"]')?.contains(changes)).toBe(false);
  expect(container.querySelector('[data-slot="transcript-changes"]')?.parentElement).toBe(container.querySelector('[data-slot="tool-activity"]')?.parentElement);
  await click(button("4 tool calls")); expect(changes.getAttribute("aria-expanded")).toBe("true");
  await render([command, edit(2, 3), mcp, edit(4, 2), edit(5)]);
  expect(changes.textContent).toContain("Line totals unavailable"); expect(changes.textContent).not.toContain("+5"); expect(changes.textContent).not.toContain("+0");
});
it("keeps unbound legacy file entries separate and makes unavailable Review explanations accessible", async () => {
  const edit = (seq: number) => event(seq, "tool_use", { toolName: "Edit", input: { file_path: "README.md", old_string: "a", new_string: "b" } });
  await act(async () => root.render(<ToolActivity events={[edit(1), edit(2)]} />));
  const changes = button("Changes · 2 file entries"); expect(changes.textContent).toContain("Line totals unavailable");
  await click(changes);
  const reviews = container.querySelectorAll<HTMLButtonElement>('button[aria-label="Review README.md"]');
  expect(reviews).toHaveLength(2); expect([...reviews].every(node => node.disabled && node.getAttribute("aria-describedby"))).toBe(true);
  expect(container.textContent).toContain("no recorded source binding");
});

it("shows one repository heading for multiple files while retaining each exact Review reference", async () => {
  const repository = "https://github.com/example/project.git";
  const reference = { sessionId: "session", workspaceId: "workspace", worktreeId: "tree", repository };
  const paths = ["README.md", "src/main.ts"];
  const references = paths.map(path => ({ ...reference, path }));
  const events = references.map((review, index) => event(index + 1, "tool_use", { toolName: "Edit", fileEdits: [{ path: review.path, additions: index + 1, deletions: 0, review }] }));
  const workspace: DevelopmentWorkspace = { id: "workspace", state: "active", workflow: { state: "in-progress", revision: 0 }, owner: { kind: "assistant", appId: "hosty.harness", reference: "session", label: "Session" },
    worktrees: [{ id: "tree", workspaceId: "workspace", repository, branch: "hosty/session/a-long-branch", state: "active", apps: [], leases: [], pullRequests: [] }] };
  const open = vi.fn();
  await act(async () => root.render(<ToolActivity events={events} reviewContext={{ sessionId: "session", workspaces: [workspace], onOpen: open }} />));
  await click(button("Changes · 2 files"));
  const files = container.querySelector('[aria-label="File edits"]')!;
  expect([...files.querySelectorAll("h4")].map(node => node.textContent)).toEqual(["project"]);
  expect(files.querySelector("h4")?.title).toBe(repository);
  expect(files.textContent).not.toContain(workspace.worktrees[0].branch);
  expect(files.textContent).not.toContain("Recorded edits in this section");
  const rows = [...files.querySelectorAll<HTMLButtonElement>("button")];
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("README.md"); expect(rows[0].textContent).toContain("+1");
  expect(rows[1].textContent).toContain("src/main.ts"); expect(rows[1].textContent).toContain("+2");
  await click(rows[0]); await click(rows[1]);
  expect(open.mock.calls.map(([ref]) => ref)).toEqual(references);
});
it("keeps identical file and repository basenames in distinct sources independently reviewable", async () => {
  const sources = [
    { id: "tree-one", repository: "https://github.com/one/project.git" },
    { id: "tree-two", repository: "https://github.com/two/project.git" },
    { id: "tree-three", repository: "https://github.com/one/project.git" },
  ];
  const references = sources.map(source => ({ sessionId: "session", workspaceId: "workspace", worktreeId: source.id, repository: source.repository, path: "README.md" }));
  const events = references.map((review, index) => event(index + 1, "tool_use", { toolName: "Edit", fileEdits: [{ path: review.path, additions: index + 1, deletions: 0, review }] }));
  const workspace: DevelopmentWorkspace = { id: "workspace", state: "active", workflow: { state: "in-progress", revision: 0 }, owner: { kind: "assistant", appId: "hosty.harness", reference: "session", label: "Session" },
    worktrees: sources.map(source => ({ id: source.id, workspaceId: "workspace", repository: source.repository, branch: `hosty/session/${source.id}`, state: "active", apps: [], leases: [], pullRequests: [] })) };
  const open = vi.fn();
  await act(async () => root.render(<ToolActivity events={events} reviewContext={{ sessionId: "session", workspaces: [workspace], onOpen: open }} />));
  await click(button("Changes · 3 files"));
  const files = container.querySelector('[aria-label="File edits"]')!;
  const groups = [...files.querySelectorAll("section")];
  expect(groups).toHaveLength(3);
  expect(groups.map(group => group.querySelector("h4")?.textContent)).toEqual(["project", "project", "project"]);
  for (const [index, group] of groups.entries()) {
    const row = group.querySelector<HTMLButtonElement>('button[aria-label="Review README.md"]')!;
    expect(row.disabled).toBe(false); expect(row.textContent).toContain(`+${index + 1}`);
    await click(row);
  }
  expect(open.mock.calls.map(([ref]) => ref)).toEqual(references);
});
it("keeps a recorded repository group unavailable when its exact workspace binding is absent", async () => {
  const ref = { sessionId: "session", workspaceId: "missing", worktreeId: "missing-tree", repository: "https://github.com/example/project", path: "README.md" };
  const open = vi.fn();
  await act(async () => root.render(<ToolActivity events={[event(1, "tool_use", { toolName: "Edit", fileEdits: [{ path: ref.path, review: ref }] })]} reviewContext={{ sessionId: "session", workspaces: [], onOpen: open }} />));
  await click(button("Changes · 1 file"));
  const row = container.querySelector<HTMLButtonElement>('button[aria-label="Review README.md"]')!;
  expect(row.disabled).toBe(true);
  expect(container.querySelector("h4")?.textContent).toBe("project");
  const hint = container.querySelector(`[id="${row.getAttribute("aria-describedby")}"]`);
  expect(hint?.textContent).toContain("recorded workspace is unavailable");
  expect(container.textContent).toContain("Recorded line totals unavailable");
  await click(row); expect(open).not.toHaveBeenCalled();
});
