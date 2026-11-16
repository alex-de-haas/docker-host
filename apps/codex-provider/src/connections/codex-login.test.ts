import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CodexLogin, CodexLoginError, codexLoginFailure } from "./codex-login.js";

const secret = "synthetic-native-secret-never-expose", cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
const script = `
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
const mode=process.env.TEST_CODEX_LOGIN_MODE, root=process.env.CODEX_HOME;
writeFileSync(root+'/pid',String(process.pid));
process.stderr.write('synthetic-native-secret-never-expose '+root+'\\n');
if(mode==='early-exit')process.exit(23);
if(mode==='ignore-term')process.on('SIGTERM',()=>{});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); appendFileSync(root+'/requests',JSON.stringify(m)+'\\n');
 if(!m.id)return;
 if(mode==='rpc-all'||(mode==='rpc'&&m.method!=='initialize'))return send({id:m.id,error:{code:Number(process.env.TEST_CODEX_LOGIN_RPC_CODE||-32603),message:process.env.TEST_CODEX_LOGIN_ERROR,data:{secret:'synthetic-native-secret-never-expose'}}});
 if(m.method==='initialize')return send({id:m.id,result:{userAgent:'synthetic'}});
 if(mode==='inherited-pipe'){
  const keeper=spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.env.CODEX_HOME+'/grandchild-pid',String(process.pid));setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
  keeper.unref();send({id:m.id,result:{ok:true}});setTimeout(()=>process.exit(0),30);return;
 }
 if(mode==='hang'){writeFileSync(root+'/waiting','yes');return;}
 if(mode==='exit'){process.exit(17);}
 if(mode==='overflow'){process.stdout.write('x'.repeat(1024*1024+1));return;}
 if(mode==='invalid')return send({id:m.id,result:'synthetic-native-secret-never-expose'});
 if(mode==='complete'){send({method:'account/login/completed',params:{success:true}});send({method:'account/login/completed',params:{success:false}});}
 send({id:m.id,result:{ok:true}});
});
process.stdin.on('end',()=>writeFileSync(root+'/stdin-ended','yes'));
`;
async function fixture(mode = "ok", message = secret, rpcCode = -32603) {
  const directory = await mkdtemp(path.join(tmpdir(), "hosty-codex-login-")), file = path.join(directory, "fixture.mjs");
  await writeFile(file, script); vi.stubEnv("HOSTY_HARNESS_CODEX_COMMAND", file);
  vi.stubEnv("TEST_CODEX_LOGIN_MODE", mode); vi.stubEnv("TEST_CODEX_LOGIN_ERROR", message); vi.stubEnv("TEST_CODEX_LOGIN_RPC_CODE", String(rpcCode));
  const client = new CodexLogin(directory), completed = vi.fn(); client.onComplete = completed;
  cleanups.push(async () => { await client.closeAndWait(); await rm(directory, { recursive: true, force: true }); });
  return { client, completed, directory };
}
async function until(action: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 200; i++) { if (await action()) return; await sleep(10); }
  throw new Error("Synthetic child did not reach the expected state.");
}
async function errorOf(promise: Promise<unknown>): Promise<CodexLoginError> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(CodexLoginError); return error as CodexLoginError; }
  throw new Error("Expected a typed diagnostic.");
}
function privateOutput(error: CodexLoginError, directory?: string) {
  const text = [error.message, error.stack, JSON.stringify(error.diagnostic), JSON.stringify(codexLoginFailure(error))].join("\n");
  expect(text).not.toContain(secret); if (directory) expect(text).not.toContain(directory);
}
it("uses the actual child protocol and confirms native exit on shutdown", async () => {
  const f = await fixture(); await f.client.initialize();
  expect(await f.client.request("account/read", { refreshToken: false })).toEqual({ ok: true });
  const requests = (await readFile(path.join(f.directory, "requests"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(requests.map(value => value.method)).toEqual(["initialize", "initialized", "account/read"]);
  const pid = Number(await readFile(path.join(f.directory, "pid"), "utf8"));
  await f.client.closeAndWait(); expect(() => process.kill(pid, 0)).toThrow();
  expect(await readFile(path.join(f.directory, "stdin-ended"), "utf8")).toBe("yes");
  const after = await errorOf(f.client.request("account/read", {})); expect(after.diagnostic).toMatchObject({ code: "closed", phase: "account-read", method: "account/read" }); privateOutput(after, f.directory);
});
it.each([
  ["device code request failed with status 403 Forbidden", "rejected", 403],
  ["failed to request device code: device code request failed with status 403 Forbidden", "rejected", 403],
  ["failed to request device code: device code request failed with status 429 Too Many Requests", "rejected", 429],
  ["device code request failed with status 503 Service Unavailable", "network", 503],
  ["device code login is not enabled for this Codex server. Use the browser login or verify the server URL.", "unsupported", 404],
])("classifies the pinned upstream device-code failure %s without exposing native data", async (message, code, httpStatus) => {
  const rpcCode = httpStatus === 404 ? -32600 : -32603;
  const f = await fixture("rpc", message, rpcCode); await f.client.initialize();
  const error = await errorOf(f.client.request("account/login/start", { type: "chatgptDeviceCode" }));
  expect(error.diagnostic).toEqual({ code, phase: "device-code", method: "account/login/start", rpcCode, httpStatus }); privateOutput(error, f.directory);
});
it.each([
  ["initialize", "initialize"], ["account/login/cancel", "cancel"], ["account/read", "account-read"],
  ["account/rateLimits/read", "usage-read"], ["model/list", "model-read"],
])("retains the safe phase for a real %s RPC failure", async (method, phase) => {
  const f = await fixture("rpc-all", secret, -32601);
  const error = await errorOf(f.client.request(method, {}));
  expect(error.diagnostic).toEqual({ code: "unsupported", phase, method, rpcCode: -32601 }); privateOutput(error, f.directory);
});
it.each([secret, `device code request failed with status 403 Forbidden ${secret}`, "device code request failed with status 999", "failed to start device code login: ".repeat(20)])("does not infer upstream status from an unrecognized message", async message => {
  const f = await fixture("rpc", message); await f.client.initialize();
  const error = await errorOf(f.client.request("account/login/start", {}));
  expect(error.diagnostic).toEqual({ code: "rpc_failed", phase: "device-code", method: "account/login/start", rpcCode: -32603 }); privateOutput(error, f.directory);
});
it("retains an early exit and rejects later initialization immediately", async () => {
  const f = await fixture("early-exit"); await until(() => f.completed.mock.calls.length > 0);
  const started = Date.now(), error = await errorOf(f.client.initialize());
  expect(Date.now() - started).toBeLessThan(500); expect(error.diagnostic).toEqual({ code: "native_exit", phase: "initialize", method: "initialize", exitCode: 23 });
  expect(f.completed).toHaveBeenCalledExactlyOnceWith(false); privateOutput(error, f.directory);
});
it("preserves exit metadata for an in-flight device-code request", async () => {
  const f = await fixture("exit"); await f.client.initialize();
  const error = await errorOf(f.client.request("account/login/start", {}));
  expect(error.diagnostic).toEqual({ code: "native_exit", phase: "device-code", method: "account/login/start", exitCode: 17 }); privateOutput(error, f.directory);
});
it("redacts asynchronous spawn errors and retains only a whitelisted errno", async () => {
  const command = path.join(tmpdir(), secret, "missing-executable"); vi.stubEnv("HOSTY_HARNESS_CODEX_COMMAND", command);
  const client = new CodexLogin(tmpdir()); cleanups.push(() => client.closeAndWait());
  const error = await errorOf(client.initialize()); expect(error.diagnostic).toEqual({ code: "launch_failed", phase: "initialize", method: "initialize", errno: "ENOENT" }); privateOutput(error, command);
});
it("captures synchronous invalid spawn input without exposing it or throwing from the constructor", async () => {
  vi.stubEnv("HOSTY_HARNESS_CODEX_COMMAND", process.execPath); const client = new CodexLogin(secret + "\0");
  cleanups.push(() => client.closeAndWait()); const error = await errorOf(client.initialize());
  expect(error.diagnostic).toEqual({ code: "launch_failed", phase: "initialize", method: "initialize" }); privateOutput(error);
});
it("bounds unterminated protocol output and stops the child", async () => {
  const f = await fixture("overflow"); await f.client.initialize();
  const error = await errorOf(f.client.request("account/login/start", {}));
  expect(error.diagnostic).toMatchObject({ code: "output_limit", phase: "device-code" }); privateOutput(error, f.directory); await f.client.closeAndWait();
});
it("rejects malformed RPC results with a safe typed response error", async () => {
  const f = await fixture("invalid"); await f.client.initialize();
  const error = await errorOf(f.client.request("account/read", {})); expect(error.diagnostic).toMatchObject({ code: "invalid_response", phase: "account-read" }); privateOutput(error, f.directory);
});
it("times out the actual pending child request and retains that failure after shutdown", async () => {
  const f = await fixture("hang"); await f.client.initialize(); vi.useFakeTimers();
  const failed = errorOf(f.client.request("account/login/start", {}));
  await until(async () => { try { return await readFile(path.join(f.directory, "waiting"), "utf8") === "yes"; } catch { return false; } });
  await vi.advanceTimersByTimeAsync(30_000); const error = await failed; vi.useRealTimers();
  expect(error.diagnostic).toEqual({ code: "timeout", phase: "device-code", method: "account/login/start" });
  expect((await errorOf(f.client.request("account/login/cancel", {}))).diagnostic).toMatchObject({ code: "timeout", phase: "cancel" }); privateOutput(error, f.directory);
});
it("emits one completion notification and waits for confirmed shutdown", async () => {
  const f = await fixture("complete"); await f.client.initialize(); await f.client.request("account/read", {});
  await f.client.closeAndWait(); expect(f.completed).toHaveBeenCalledExactlyOnceWith(true);
});
it("drops unapproved diagnostic facts and untyped error text", () => {
  const error = new CodexLoginError({ code: "rpc_failed", phase: "device-code", method: "account/login/start", rpcCode: Number.NaN, httpStatus: 900, errno: secret, signal: secret, exitCode: Infinity });
  expect(error.diagnostic).toEqual({ code: "rpc_failed", phase: "device-code", method: "account/login/start" }); privateOutput(error);
  expect(codexLoginFailure(new Error(secret))).toEqual({ code: "failed", diagnostic: { code: "failed", phase: "request" }, message: "Codex authentication could not be completed. (codex_login_failed; phase=request)" });
});

it("classifies the exact native ChatGPT policy rejection without echoing its advice", async () => {
  const f = await fixture("rpc", "ChatGPT login is disabled. Use API key login instead.", -32600); await f.client.initialize();
  const error = await errorOf(f.client.request("account/login/start", {}));
  expect(error.diagnostic).toEqual({ code: "rejected", phase: "device-code", method: "account/login/start", rpcCode: -32600 });
  expect(error.message).not.toContain("API key"); privateOutput(error, f.directory);
});

it("bounds shutdown when a native descendant keeps inherited pipes open and permits a confirmed retry", async () => {
  const f = await fixture("inherited-pipe"); let ownedPid: number | undefined;
  try {
    await f.client.initialize(); await f.client.request("account/read", {});
    await until(async () => { try { ownedPid = Number(await readFile(path.join(f.directory, "grandchild-pid"), "utf8")); return Number.isSafeInteger(ownedPid) && ownedPid! > 0; } catch { return false; } });
    await until(() => f.completed.mock.calls.length > 0);
    const started = Date.now(), error = await errorOf(f.client.closeAndWait());
    expect(Date.now() - started).toBeGreaterThanOrEqual(2800); expect(Date.now() - started).toBeLessThan(4500);
    expect(error.diagnostic).toEqual({ code: "timeout", phase: "shutdown" }); privateOutput(error, f.directory);
    expect(() => process.kill(ownedPid!, 0)).not.toThrow();
    expect(await readFile(path.join(f.directory, "grandchild-pid"), "utf8")).toBe(String(ownedPid));
  } finally {
    if (!ownedPid) { try { ownedPid = Number(await readFile(path.join(f.directory, "grandchild-pid"), "utf8")); } catch {} }
    if (ownedPid && Number.isSafeInteger(ownedPid) && ownedPid > 0) {
      try { process.kill(ownedPid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await until(() => { try { process.kill(ownedPid!, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } });
    }
    await f.client.closeAndWait();
  }
}, 10_000);
