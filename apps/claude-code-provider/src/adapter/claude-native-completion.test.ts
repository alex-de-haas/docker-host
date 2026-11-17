import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { ClaudeNativeCompletion } from "./claude-native-completion.js";

const result = (uuid: string, extra = {}) => ({ type: "result", subtype: "success", session_id: "native", uuid, num_turns: 1, result: uuid, ...extra });
const state = (value: string, session_id = "native") => ({ type: "system", subtype: "session_state_changed", sdk_host_only: true, session_id, state: value });
function fixture(maxFrameBytes?: number) {
  const input = new PassThrough(), ready = vi.fn(), failed = vi.fn(), bytes: Buffer[] = [];
  const observer = new ClaudeNativeCompletion(input, ready, failed, undefined, maxFrameBytes);
  observer.stdout.on("data", chunk => bytes.push(Buffer.from(chunk)));
  const write = (...messages: Record<string, unknown>[]) => { const text = messages.map(message => JSON.stringify(message) + "\n").join(""); input.write(text); return text; };
  return { input, ready, failed, observer, bytes, write };
}

it("binds hidden idle to the final raw result even while the SDK still delivers earlier results", () => {
  const f = fixture(), progress = result("progress"), final = result("final");
  f.write(state("running"), { type: "system", subtype: "init", session_id: "native" }, progress, state("running"), final, state("idle"));
  expect(f.observer.confirms(progress)).toBe(false);
  expect(f.observer.confirms(final)).toBe(true);
  expect(f.ready).toHaveBeenCalledOnce();
  expect(f.failed).not.toHaveBeenCalled();
});

it("passes through identical bytes across split frames and multibyte text", () => {
  const f = fixture(), final = result("final", { result: "Ответ" });
  const bytes = Buffer.from([state("running"), final, state("idle")].map(value => JSON.stringify(value) + "\n").join(""));
  for (let offset = 0; offset < bytes.length; offset += 7) f.input.write(bytes.subarray(offset, offset + 7));
  expect(Buffer.concat(f.bytes)).toEqual(bytes);
  expect(f.observer.confirms(final)).toBe(true);
});

it("does not let foreign, child or replayed messages prove completion", () => {
  const f = fixture(), final = result("final");
  f.write(state("running"), final, state("idle", "foreign"), { ...state("idle"), parent_tool_use_id: "child" }, { ...state("idle"), isReplay: true });
  expect(f.observer.confirms(final)).toBe(false);
  f.write(state("idle"));
  expect(f.observer.confirms({ ...final, session_id: "foreign" })).toBe(false);
  expect(f.observer.confirms({ ...final, parent_tool_use_id: "child" })).toBe(false);
  expect(f.observer.confirms(final)).toBe(true);
});

it("preserves the final substantive result through model-less notification acknowledgements", () => {
  const f = fixture(), final = result("final"), ack = result("ack", { num_turns: 0, result: "" });
  f.write(state("running"), final, state("running"), ack, state("idle"));
  expect(f.observer.confirms(final)).toBe(true);
  expect(f.observer.confirms(ack)).toBe(false);
  f.observer.beginTurn();
  expect(f.observer.confirms(final)).toBe(false);
  f.write(state("running"), ack, state("idle"));
  expect(f.observer.confirms(ack)).toBe(true);
});

it("revokes stale idle when native continuation starts again", () => {
  const f = fixture(), final = result("final");
  f.write(final, state("idle")); expect(f.observer.confirms(final)).toBe(true);
  f.write(state("running")); expect(f.observer.confirms(final)).toBe(false);
});

it.each(["oversize", "invalid", "identity"])("fails closed on %s native framing without altering stdout", kind => {
  const f = fixture(1024), final = result("final");
  f.write(final);
  const bytes = kind === "oversize" ? "x".repeat(1025) + "\n" : kind === "invalid" ? "not-json\n" : JSON.stringify({ ...final, uuid: undefined }) + "\n";
  f.input.write(bytes); f.write(state("idle"));
  expect(f.failed).toHaveBeenCalledOnce();
  expect(f.observer.confirms(final)).toBe(false);
  expect(Buffer.concat(f.bytes).toString()).toContain(bytes);
});

it("preserves stream backpressure until the SDK consumes stdout", async () => {
  const input = new PassThrough({ highWaterMark: 1024 }), ready = vi.fn(), failed = vi.fn();
  const observer = new ClaudeNativeCompletion(input, ready, failed);
  const payload = Buffer.from(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(128 * 1024) }] } }) + "\n");
  input.write(payload);
  expect(observer.stdout.readableLength).toBeGreaterThan(0);
  expect(input.write(payload)).toBe(false);
  expect(input.readableLength).toBeGreaterThan(0);
  const received: Buffer[] = [], ended = new Promise<void>((resolve, reject) => {
    observer.stdout.on("data", chunk => received.push(Buffer.from(chunk)));
    observer.stdout.once("end", resolve); observer.stdout.once("error", reject);
  });
  input.end(); await ended;
  expect(Buffer.concat(received)).toEqual(Buffer.concat([payload, payload]));
  expect(failed).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled();
});

it("never treats incomplete native framing at EOF as completion", async () => {
  const f = fixture(), final = result("final");
  f.write(final);
  const ended = new Promise<void>(resolve => f.observer.stdout.once("end", resolve));
  f.input.end('{"type":"system","subtype":"session_state_changed"');
  await ended;
  expect(f.failed).toHaveBeenCalledOnce();
  expect(f.observer.confirms(final)).toBe(false);
});
