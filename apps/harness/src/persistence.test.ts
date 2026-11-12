import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), mkdir: vi.fn(actual.mkdir) };
});
import * as fs from "node:fs/promises";
import { durableAppendFile, durableCreateFile, durableMkdir, durableWriteFile, DurableWriteError,
  isUncertainWrite, retrySharingViolation, syncDirectory } from "./persistence.js";

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];
const errno = (code: string) => Object.assign(new Error(code), { code });
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.mkdir).mockReset().mockImplementation(actual.mkdir);
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => actual.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await actual.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "hosty-durable-")); roots.push(root);
  return { root, file: path.join(root, "state.json") };
}
const fakeHandle = (trace: string[], prefix = "file"): FileHandle => ({
  writeFile: vi.fn(async () => { trace.push(`${prefix}:write`); }),
  sync: vi.fn(async () => { trace.push(`${prefix}:sync`); }),
  close: vi.fn(async () => { trace.push(`${prefix}:close`); }),
}) as unknown as FileHandle;

it("settles replacements, appends and exclusive identities on actual files", async () => {
  const { root, file } = await fixture();
  await durableWriteFile(file, "old"); await durableWriteFile(file, "new");
  expect(await actual.readFile(file, "utf8")).toBe("new");
  await durableAppendFile(file, Buffer.from("\nnext"));
  expect(await actual.readFile(file, "utf8")).toBe("new\nnext");
  const key = path.join(root, "key"); await durableCreateFile(key, new Uint8Array([1, 2, 3]));
  await expect(durableCreateFile(key, "replacement")).rejects.toMatchObject({ code: "EEXIST" });
  expect(await actual.readFile(key)).toEqual(Buffer.from([1, 2, 3]));
  expect((await actual.readdir(root)).some(name => name.endsWith(".tmp"))).toBe(false);
  if (process.platform !== "win32") expect((await actual.stat(file)).mode & 0o777).toBe(0o600);
});

it("flushes and closes replacement contents before rename and settles the directory before resolving", async () => {
  const trace: string[] = [], file = fakeHandle(trace), directory = fakeHandle(trace, "directory");
  vi.mocked(fs.open).mockImplementation(async (name, flags) => {
    trace.push(flags === "wx" ? "open:temporary" : "open:directory");
    if (flags === "wx") { expect(String(name)).toMatch(/^\/store\/state\.[a-f0-9-]+\.tmp$/); return file; }
    expect(name).toBe("/store"); return directory;
  });
  vi.mocked(fs.rename).mockImplementation(async () => { trace.push("rename"); });
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  await durableWriteFile("/store/state", "payload");
  expect(trace).toEqual(["open:temporary", "file:write", "file:sync", "file:close", "rename", "open:directory", "directory:sync", "directory:close"]);
});

it("takes ownership of binary input before waiting for an open", async () => {
  const { file } = await fixture();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => { await barrier; return actual.open(...args); });
  const content = Buffer.from("before"), writing = durableWriteFile(file, content);
  content.fill(120); release(); await writing;
  expect(await actual.readFile(file, "utf8")).toBe("before");
});

it("retains an interrupted temporary and closes it when file sync fails", async () => {
  const { root, file } = await fixture(); await actual.writeFile(file, "committed");
  const failure = errno("EIO"); let closed = false;
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args), close = handle.close.bind(handle);
    handle.sync = vi.fn(async () => { throw failure; });
    handle.close = vi.fn(async () => { closed = true; await close(); }); return handle;
  });
  const error = await durableWriteFile(file, "candidate").catch(error => error);
  expect(error).toBeInstanceOf(DurableWriteError); expect(isUncertainWrite(error)).toBe(true);
  expect(error.cause).toBe(failure); expect(closed).toBe(true);
  expect(await actual.readFile(file, "utf8")).toBe("committed");
  expect(await actual.readFile(error.evidencePath, "utf8")).toBe("candidate");
  expect((await actual.readdir(root)).filter(name => name.endsWith(".tmp"))).toHaveLength(1);
  expect(fs.rename).not.toHaveBeenCalled();
});

it("reports a post-rename flush failure as uncertain without restoring older content", async () => {
  const { file } = await fixture(); await actual.writeFile(file, "older");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  const failure = errno("EIO");
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[1] === "r") handle.sync = vi.fn(async () => { throw failure; });
    return handle;
  });
  await expect(durableWriteFile(file, "newer")).rejects.toMatchObject({ uncertain: true, cause: failure, evidencePath: file });
  expect(await actual.readFile(file, "utf8")).toBe("newer");
});

it("treats a failed close as uncertain and keeps an earlier write error as the cause", async () => {
  const { file } = await fixture(), first = errno("ENOSPC"), closing = errno("EIO");
  const handle = fakeHandle([]);
  handle.writeFile = vi.fn(async () => { throw first; });
  handle.close = vi.fn(async () => { throw closing; });
  vi.mocked(fs.open).mockResolvedValueOnce(handle);
  await expect(durableWriteFile(file, "candidate")).rejects.toMatchObject({ uncertain: true, cause: first });
  expect(handle.close).toHaveBeenCalledTimes(1); expect(handle.sync).not.toHaveBeenCalled();
  expect(fs.rename).not.toHaveBeenCalled();
  handle.writeFile = vi.fn(async () => {});
  vi.mocked(fs.open).mockResolvedValueOnce(handle);
  await expect(durableWriteFile(file, "candidate")).rejects.toMatchObject({ uncertain: true, cause: closing });
  expect(fs.rename).not.toHaveBeenCalled();
});

it("never retries append after bytes may already have reached the file", async () => {
  const { file } = await fixture(); await actual.writeFile(file, "first\n");
  const failure = errno("EBUSY");
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args); handle.sync = vi.fn(async () => { throw failure; }); return handle;
  });
  await expect(durableAppendFile(file, "second\n")).rejects.toMatchObject({ uncertain: true, cause: failure });
  expect(await actual.readFile(file, "utf8")).toBe("first\nsecond\n");
  expect(fs.open).toHaveBeenCalledExactlyOnceWith(file, "a", 0o600);
});

it("retains an exclusive candidate after a failed sync without publishing partial bytes", async () => {
  const { file } = await fixture();
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args); handle.sync = vi.fn(async () => { throw errno("EIO"); }); return handle;
  });
  const error = await durableCreateFile(file, "identity").catch(error => error);
  expect(error).toMatchObject({ uncertain: true });
  await expect(actual.readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await actual.readFile(error.evidencePath, "utf8")).toBe("identity");
});

it("publishes an exclusive identity only after its complete contents have been flushed", async () => {
  const { file } = await fixture();
  let release!: () => void, flushing = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args), sync = handle.sync.bind(handle);
    handle.sync = vi.fn(async () => { flushing = true; await barrier; await sync(); }); return handle;
  });
  const writing = durableCreateFile(file, "complete identity");
  await vi.waitFor(() => expect(flushing).toBe(true));
  await expect(actual.readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  release(); await writing;
  expect(await actual.readFile(file, "utf8")).toBe("complete identity");
});

describe("sharing violations", () => {
  it.each(["EACCES", "EPERM", "EBUSY"])("retries %s without rewriting the temporary", async code => {
    const { file } = await fixture();
    vi.mocked(fs.rename).mockRejectedValueOnce(errno(code));
    await durableWriteFile(file, "once");
    expect(fs.rename).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fs.open).mock.calls.filter(call => call[1] === "wx")).toHaveLength(1);
    expect(await actual.readFile(file, "utf8")).toBe("once");
  });
  it("bounds sharing retries and leaves unpublished evidence", async () => {
    const { file } = await fixture(); await actual.writeFile(file, "old");
    const failure = errno("EPERM"); vi.mocked(fs.rename).mockRejectedValue(failure);
    const error = await durableWriteFile(file, "candidate").catch(error => error);
    expect(error).toMatchObject({ uncertain: true, cause: failure });
    expect(fs.rename).toHaveBeenCalledTimes(4);
    expect(await actual.readFile(file, "utf8")).toBe("old");
    expect(await actual.readFile(error.evidencePath, "utf8")).toBe("candidate");
  });
  it("does not retry non-sharing errors", async () => {
    const failure = errno("ENOSPC"), action = vi.fn(async () => { throw failure; });
    await expect(retrySharingViolation(action)).rejects.toBe(failure); expect(action).toHaveBeenCalledTimes(1);
  });
});

it("does not report a successful replacement until the directory sync finishes", async () => {
  const trace: string[] = [], file = fakeHandle(trace), directory = fakeHandle(trace, "directory");
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  directory.sync = vi.fn(async () => { trace.push("directory:sync"); await barrier; });
  vi.mocked(fs.open).mockImplementation(async (_target, flags) => flags === "wx" ? file : directory);
  vi.mocked(fs.rename).mockResolvedValue(); Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  let done = false; const writing = durableWriteFile("/store/state", "payload").then(() => { done = true; });
  await vi.waitFor(() => expect(directory.sync).toHaveBeenCalledTimes(1));
  expect(done).toBe(false); release(); await writing; expect(done).toBe(true);
});

it("skips unsupported Windows directory flushing while still flushing the file", async () => {
  const trace: string[] = [], file = fakeHandle(trace);
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.mocked(fs.open).mockResolvedValue(file); vi.mocked(fs.rename).mockResolvedValue();
  await durableWriteFile("C:/store/state", "payload");
  expect(trace).toEqual(["file:write", "file:sync", "file:close"]);
  expect(fs.open).toHaveBeenCalledTimes(1);
  await syncDirectory("C:/store"); expect(fs.open).toHaveBeenCalledTimes(1);
});

it("settles a newly created nested directory chain through its existing parent", async () => {
  const { root } = await fixture(), nested = path.join(root, "one", "two");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  await durableMkdir(nested);
  expect(vi.mocked(fs.open).mock.calls.map(call => call[0])).toEqual([nested, path.dirname(nested), root]);
  expect((await actual.stat(nested)).isDirectory()).toBe(true);
});
