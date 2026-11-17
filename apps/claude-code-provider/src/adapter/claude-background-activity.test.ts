import { expect, it, vi } from "vitest";
import { ClaudeBackgroundLifecycle } from "./claude-background.js";

const task = (task_id: string, task_type: string, extra = {}) => ({ task_id, task_type, ...extra });
const inventory = (...tasks: Record<string, unknown>[]) => ({ type: "system", subtype: "background_tasks_changed", tasks });
const edge = (task_id: string, extra = {}) => ({ type: "system", subtype: "task_started", task_id, ...extra });
function fixture() { return new ClaudeBackgroundLifecycle(() => undefined, vi.fn()); }

it("retains inventory-only agent ancestry after the agent has ended and left the live set", () => {
  const f = fixture();
  f.observe(inventory(task("agent", "local_agent", { run_id: "2" })));
  f.observe({ type: "system", subtype: "task_notification", task_id: "agent", run_id: "2", status: "completed" });
  f.observe(inventory(task("bash", "local_bash", { parent_task_id: "agent" })));
  expect(f.busy).toBe(true);
  f.observe(inventory()); expect(f.busy).toBe(false);
});

it("learns foreground agent ancestry from native edges before background descendants appear", () => {
  const f = fixture();
  f.observe(edge("agent", { task_type: "local_agent", is_backgrounded: false }));
  f.observe(inventory(task("bash", "local_bash", { parent_task_id: "agent" })));
  expect(f.busy).toBe(true);
});

it("excludes ambient and unrelated root background tasks, including documented unknown parents", () => {
  const f = fixture();
  f.observe(edge("agent", { task_type: "local_agent" }));
  f.observe(inventory(task("root", "local_bash"), task("unknown", "local_bash", { parent_task_id: "untracked" }),
    task("ambient", "local_bash", { parent_task_id: "agent", ambient: true })));
  expect(f.busy).toBe(false);
});

it("does not overwrite known ancestry with late metadata from an older task run", () => {
  const f = fixture();
  f.observe(edge("agent", { task_type: "local_agent", run_id: "2" }));
  f.observe(edge("agent", { task_type: "local_bash", run_id: "1" }));
  f.observe(inventory(task("bash", "local_bash", { parent_task_id: "agent" })));
  expect(f.busy).toBe(true);
});

it.each([
  [task("bad", "local_bash", { parent_task_id: "" })],
  [task("self", "local_bash", { parent_task_id: "self" })],
  [task("a", "local_bash", { parent_task_id: "b" }), task("b", "local_bash", { parent_task_id: "a" })],
].map(tasks => ({ tasks })))("keeps malformed or cyclic ancestry uncertain: %j", ({ tasks }) => {
  const f = fixture(); f.observe(inventory(...tasks)); expect(f.busy).toBe(true);
});

it("keeps ancestry uncertainty when retained identities exceed the bounded capacity", () => {
  const f = fixture();
  for (let index = 0; index < 257; index++) f.observe(edge(`agent-${index}`, { task_type: "local_agent" }));
  f.observe(inventory());
  expect(f.busy).toBe(true);
});

it("does not let conflicting task types erase established native agent ownership", () => {
  const f = fixture();
  f.observe(edge("agent", { task_type: "local_agent", run_id: "1" }));
  f.observe(inventory(task("agent", "local_bash", { run_id: "2" })));
  expect(f.busy).toBe(true);
});

it("preserves the native child outcome without confirming stop while its command is active", () => {
  const emit = vi.fn(), source = { agentId: "child", parentAgentId: "root", parentToolCallId: "spawn" };
  const f = new ClaudeBackgroundLifecycle(() => source, emit);
  f.observe(edge("agent", { task_type: "local_agent", run_id: "1", tool_use_id: "spawn", is_backgrounded: true }));
  f.observe({ type: "system", subtype: "task_notification", task_id: "agent", run_id: "1", status: "completed" });
  f.observe(inventory(task("bash", "local_bash", { parent_task_id: "agent" })));
  expect(f.busy).toBe(true);
  expect(emit.mock.calls.map(([event]) => [event.state, event.stopConfirmed])).toEqual([["running", false], ["succeeded", false]]);
  f.observe(edge("agent", { task_type: "local_agent", run_id: "2", tool_use_id: "spawn", is_backgrounded: true }));
  expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ state: "running", stopConfirmed: false });
});


it("retains proven ancestry when the SDK stops tracking the ended launcher", () => {
  const f = fixture();
  f.observe(inventory(task("agent", "local_agent"), task("bash", "local_bash", { parent_task_id: "agent", run_id: "1" })));
  f.observe(inventory(task("bash", "local_bash", { run_id: "1" })));
  expect(f.busy).toBe(true);
});

it("resets ambient and background flags for a resumed run while retaining its original ancestry", () => {
  const f = fixture();
  f.observe(edge("owner", { task_type: "local_agent" }));
  f.observe(edge("agent", { task_type: "local_agent", run_id: "1", ambient: true, is_backgrounded: true, parent_task_id: "owner" }));
  f.observe(edge("agent", { task_type: "local_agent", run_id: "2" }));
  expect(f.busy).toBe(false); // The new foreground run does not inherit backgrounding.
  f.observe({ type: "system", subtype: "task_updated", task_id: "agent", run_id: "2", patch: { is_backgrounded: true } });
  expect(f.busy).toBe(true); // It also does not inherit the old run's ambient flag.
});
