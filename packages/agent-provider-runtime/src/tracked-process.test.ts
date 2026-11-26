import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { TrackedNativeProcesses, nativeProcessEnvironment } from "./tracked-process.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture() {
  const data = await mkdtemp(path.join(os.tmpdir(), "hosty-native-proof-"));
  cleanup.push(() => rm(data, { recursive: true, force: true }));
  const runId = randomUUID(), generation = randomUUID(), tracked = await TrackedNativeProcesses.create(data, runId, generation);
  cleanup.push(() => tracked.stop());
  return { data, runId, generation, tracked };
}
async function until(check: () => Promise<boolean>, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (!await check()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for native fixture"); await pause(30); }
}
it("reserves native generations once and keeps empty-process proof separate from mutation effects", async () => {
  const f = await fixture();
  await expect(TrackedNativeProcesses.create(f.data, f.runId, f.generation)).rejects.toThrow();
  expect(await f.tracked.stop()).toMatchObject({ stopped: false, allClosed: true, sealed: true, spawnCount: 0 });
  await f.tracked.confirmSdkStop(); expect(await f.tracked.evidence()).toMatchObject({ stopped: true });
  expect(await TrackedNativeProcesses.readEvidence(f.data, f.runId, randomUUID())).toMatchObject({ stopped: false });
  expect(() => f.tracked.transport.spawnTool!(["-e", ""], { cwd: f.data, env: { PATH: process.env.PATH, HOME: f.data } })).toThrow("sealed");
});
it("forwards selected homes and explicitly referenced MCP bearers without Hosty control credentials", () => {
  const env = nativeProcessEnvironment({ PATH: "selected-path", HOME: "/selected-home", ENGINE_CONFIG_HOME: "/selected-config", HOSTY_APP_SERVICE_TOKEN: "private-control",
    HOSTY_CORE_CONTROL_SECRET: "private-core", HOSTY_MCP_BEARER_CHOSEN: "narrow-proxy", HOSTY_MCP_BEARER_OTHER: "other-run", NODE_CHANNEL_FD: "3", NODE_OPTIONS: "--unsafe" },
    ['HOSTY_MCP_BEARER_CHOSEN']);
  expect(env).toMatchObject({ PATH: "selected-path", HOME: "/selected-home", ENGINE_CONFIG_HOME: "/selected-config", HOSTY_MCP_BEARER_CHOSEN: "narrow-proxy" });
  for (const key of ["HOSTY_APP_SERVICE_TOKEN", "HOSTY_CORE_CONTROL_SECRET", "HOSTY_MCP_BEARER_OTHER", "NODE_CHANNEL_FD", "NODE_OPTIONS"]) expect(env).not.toHaveProperty(key);
});
it("persists stop proof after an actual native command exits and checks execution identity", async () => {
  const f = await fixture();
  const child = f.tracked.transport.spawn(process.execPath, ["-e", "process.stdout.write('native output');"], { command: process.execPath, cwd: f.data, env: { PATH: process.env.PATH, HOME: f.data } });
  let output = ""; child.stdout.on("data", value => { output += value; }); child.stderr.resume();
  await new Promise(resolve => child.once("close", resolve));
  expect(output).toBe("native output");
  const evidence = await TrackedNativeProcesses.readEvidence(f.data, f.runId, f.generation);
  expect(evidence).toMatchObject({ stopped: false, allClosed: true, spawnCount: 1, runId: f.runId, generation: f.generation });
  await f.tracked.confirmSdkStop();
  expect(await f.tracked.stop()).toMatchObject({ stopped: true, sealed: true });
  const directory = path.join(f.data, "native-processes", f.runId, f.generation);
  const file = (await readdir(directory)).find(name => name !== "manifest.json" && name.endsWith(".json"))!;
  const receipt = JSON.parse(await readFile(path.join(directory, file), "utf8"));
  await writeFile(path.join(directory, file), JSON.stringify({ ...receipt, nonce: randomUUID() }));
  expect(await TrackedNativeProcesses.readEvidence(f.data, f.runId, f.generation)).toMatchObject({ stopped: false });
});
it("forwards stdin EOF without cancelling a tool that computes after reading its complete input", async () => {
  const f = await fixture();
  const child = f.tracked.transport.spawnTool!(["-e", "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.parse(input).text),100));"],
    { cwd: f.data, env: { PATH: process.env.PATH, HOME: f.data } });
  let output = ""; child.stdout.on("data", value => { output += value; }); child.stderr.resume();
  child.stdin.end(JSON.stringify({ text: "completed after input EOF" }));
  const code = await new Promise(resolve => child.once("close", resolve));
  expect(code).toBe(0); expect(output).toBe("completed after input EOF");
  await f.tracked.confirmSdkStop();
  expect(await f.tracked.stop()).toMatchObject({ stopped: process.platform !== "win32", spawnCount: 1 });
});
it("drains large native stdout and stderr before closing the SDK-facing runner", async () => {
  const f = await fixture(), size = 1024 * 1024;
  const script = `const bytes=Buffer.alloc(${size},120);process.stdout.write(bytes,()=>process.stderr.write(bytes,()=>process.exit(0)));`;
  const child = f.tracked.transport.spawnTool!(["-e", script], { cwd: f.data, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, HOME: f.data } });
  let output = 0, errors = 0; child.stdout.on("data", value => { output += value.length; }); child.stderr.on("data", value => { errors += value.length; });
  const code = await new Promise<number | null>(resolve => child.once("close", resolve));
  expect(code).toBe(0); expect(output).toBe(size); expect(errors).toBe(size);
  await f.tracked.confirmSdkStop(); expect(await f.tracked.evidence()).toMatchObject({ stopped: true, allClosed: true });
}, 30000);
it.skipIf(process.platform === "win32")("stops a stubborn descendant after its native parent exits while the evidence writer survives escalation", async () => {
  const f = await fixture(), marker = path.join(f.data, "activity.txt");
  const descendant = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)},String(Date.now())),20);`;
  const parent = `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'}); setTimeout(()=>process.exit(0),200);`;
  const child = f.tracked.transport.spawnCommand!(process.execPath, ["-e", parent], { cwd: f.data, env: { PATH: process.env.PATH, HOME: f.data } });
  child.stdout.resume(); child.stderr.resume();
  await until(async () => await readFile(marker).then(() => true, () => false));
  await new Promise(resolve => child.once("close", resolve));
  await f.tracked.confirmSdkStop();
  expect(await f.tracked.stop()).toMatchObject({ stopped: true, spawnCount: 1 });
  const before = await readFile(marker, "utf8"); await pause(100); expect(await readFile(marker, "utf8")).toBe(before);
  const directory = path.join(f.data, "native-processes", f.runId, f.generation);
  const receipt = (await readdir(directory)).find(name => name !== "manifest.json" && name.endsWith(".json"))!;
  expect(JSON.parse(await readFile(path.join(directory, receipt), "utf8"))).toMatchObject({ treeStopped: true, outputDrained: false });
});

it.skipIf(process.platform === "win32")("retains root exit while a real ordinary POSIX descendant still writes", async () => {
  const f = await fixture(), marker = path.join(f.data, "descendant-writes.txt");
  const descendant = `const {appendFileSync}=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>appendFileSync(${JSON.stringify(marker)},'.'),25);`;
  const parent = `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
  const child = f.tracked.transport.spawn(process.execPath, ["-e", parent], { cwd: f.data, env: { PATH: process.env.PATH, HOME: f.data } });
  child.stdout.resume(); child.stderr.resume();
  await until(() => readFile(marker).then(() => true, () => false));
  child.kill("SIGTERM");
  await f.tracked.transport.waitForTargetExit!(child);
  await f.tracked.confirmSdkStop();
  const evidence = await TrackedNativeProcesses.readEvidence(f.data, f.runId, f.generation);
  expect(evidence).toMatchObject({ targetStopped: true, allClosed: false });
  expect(evidence).not.toHaveProperty("writerScopeClosed");
  const writesAtRootExit = (await readFile(marker)).length;
  await until(async () => (await readFile(marker)).length > writesAtRootExit);
  expect(await f.tracked.stop()).toMatchObject({ targetStopped: true, allClosed: true });
  expect(await f.tracked.evidence()).not.toHaveProperty("writerScopeClosed");
}, 20000);

it.skipIf(process.platform === "win32")("preserves synchronous native burst notifications and duplex RPC under stdout/stderr backpressure", async () => {
  const f = await fixture(), count = 64, size = 128 * 1024;
  // writeSync mirrors a native blocking stdout writer: EAGAIN is a real failure, not retried here.
  const script = `const {writeSync}=require('node:fs');const {createInterface}=require('node:readline');
    const write=(fd,bytes)=>{let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);};
    const send=value=>write(1,Buffer.from(JSON.stringify(value)+'\\n'));
    const input=createInterface({input:process.stdin});send({type:'ready'});
    input.on('line',line=>{const request=JSON.parse(line);
      if(request.type==='burst'){for(let sequence=0;sequence<${count};sequence++){
        send({type:'notification',sequence,text:'x'.repeat(${size})});write(2,Buffer.alloc(${size},121));
      }send({type:'ack',id:request.id});}
      else if(request.type==='quit'){send({type:'terminal'});send({type:'ack',id:request.id});process.exit(0);}
      else send({type:'ack',id:request.id});});`;
  const child = f.tracked.transport.spawnTool!(["-e", script], { cwd: f.data, env: { PATH: process.env.PATH, HOME: f.data } });
  let buffer = "", errors = 0, notifications = 0, terminal = false;
  const acknowledgements: number[] = [];
  let ready!: () => void, complete!: () => void, reject!: (error: Error) => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const finished = new Promise<void>((resolve, fail) => { complete = resolve; reject = fail; });
  // Attach a rejection observer before intentionally pausing the readers.
  void finished.catch(() => {});
  child.stdout.on("data", value => {
    buffer += value.toString();
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const frame = JSON.parse(line);
        if (frame.type === "ready") ready();
        if (frame.type === "notification") {
          expect(frame.sequence).toBe(notifications++);
          expect(frame.text.length).toBe(size); expect(/^x+$/.test(frame.text)).toBe(true);
        }
        if (frame.type === "terminal") terminal = true;
        if (frame.type === "ack") acknowledgements.push(frame.id);
      } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    }
  });
  child.stderr.on("data", value => { errors += value.length; });
  child.once("close", code => { if (code === 0 && terminal) complete(); else reject(new Error(`Native fixture closed before terminal delivery (exit ${code}).`)); });
  await started;
  child.stdin.write(JSON.stringify({ type: "ping", id: 1 }) + "\n");
  await until(async () => acknowledgements.includes(1));
  child.stdout.pause(); child.stderr.pause();
  child.stdin.write(JSON.stringify({ type: "burst", id: 2 }) + "\n");
  child.stdin.write(JSON.stringify({ type: "ping", id: 3 }) + "\n");
  try {
    await pause(200);
    const directory = path.join(f.data, "native-processes", f.runId, f.generation);
    const receipt = (await readdir(directory)).find(name => name !== "manifest.json" && name.endsWith(".json"))!;
    expect(JSON.parse(await readFile(path.join(directory, receipt), "utf8")).state).not.toBe("stopped");
  } finally { child.stdout.resume(); child.stderr.resume(); }
  await until(async () => acknowledgements.includes(3));
  child.stdin.write(JSON.stringify({ type: "quit", id: 4 }) + "\n");
  await finished;
  expect(notifications).toBe(count); expect(errors).toBe(count * size); expect(buffer).toBe("");
  expect(acknowledgements).toEqual([1, 2, 3, 4]);
  await f.tracked.confirmSdkStop();
  expect(await f.tracked.stop()).toMatchObject({ stopped: true, allClosed: true, sealed: true, spawnCount: 1 });
}, 20000);
it.skipIf(process.platform === "win32")("keeps the receipt writer alive when an SDK requests SIGKILL and confirms the owned tree", async () => {
  const f = await fixture();
  const child = f.tracked.transport.spawnTool!(["-e", "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000);"], { cwd: f.data, env: { PATH: process.env.PATH, HOME: f.data } });
  child.stderr.resume(); await new Promise(resolve => child.stdout.once("data", resolve));
  child.kill("SIGKILL");
  await new Promise(resolve => child.once("close", resolve));
  await f.tracked.confirmSdkStop();
  expect(await f.tracked.stop()).toMatchObject({ stopped: true, sealed: true });
});
it.skipIf(process.platform === "win32")("retains owned-group evidence after a provider crash without inventing an SDK stop", async () => {
  const f = await fixture(), marker = path.join(f.data, "parent-ready");
  // This fixture uses another generation so its one provider-process owner can exit independently.
  const generation = randomUUID(), helper = path.join(f.data, "parent.mjs");
  const source = fileURLToPath(new URL("./tracked-process.ts", import.meta.url));
  await writeFile(helper, `import {TrackedNativeProcesses} from ${JSON.stringify(source)}; import{writeFileSync}from'node:fs';
const t=await TrackedNativeProcesses.create(${JSON.stringify(f.data)},${JSON.stringify(f.runId)},${JSON.stringify(generation)});
const c=t.transport.spawnTool(['-e',"process.stdout.write('ready');setInterval(()=>{},1000)"],{cwd:${JSON.stringify(f.data)},env:{PATH:process.env.PATH,HOME:${JSON.stringify(f.data)}}});c.stderr.resume();c.stdout.once('data',()=>writeFileSync(${JSON.stringify(marker)},'ready'));`);
  const parent = spawn(process.execPath, ["--import", "tsx", helper], { cwd: path.resolve(fileURLToPath(new URL("../../../", import.meta.url))), env: { PATH: process.env.PATH, HOME: f.data }, stdio: ["ignore","ignore","pipe"] });
  let errors = ""; parent.stderr.on("data", value => { errors += value; });
  cleanup.push(async () => { if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL"); });
  await until(async () => { if (parent.exitCode !== null) throw new Error(errors); return readFile(marker).then(() => true, () => false); });
  parent.kill("SIGKILL"); await new Promise(resolve => parent.once("close", resolve));
  await until(async () => (await TrackedNativeProcesses.readEvidence(f.data, f.runId, generation)).allClosed);
  expect(await TrackedNativeProcesses.readEvidence(f.data, f.runId, generation)).toMatchObject({ stopped: false, allClosed: true, spawnCount: 1, reason: "sdk_stop_unconfirmed" });
});

it.skipIf(process.platform === "win32")("recovers a durable SDK stop marker before the provider journal records its terminal state", async () => {
  const f = await fixture();
  const child = f.tracked.transport.spawnTool!(["-e", "process.stdout.write('ready');setInterval(()=>{},1000);"], { cwd: f.data, env: { PATH: process.env.PATH, HOME: f.data } });
  child.stderr.resume(); await new Promise(resolve => child.stdout.once("data", resolve));
  await f.tracked.transport.stopProcess!(child);
  expect(await f.tracked.evidence()).toMatchObject({ stopped: false, allClosed: true });
  await f.tracked.confirmSdkStop();
  expect(await TrackedNativeProcesses.readEvidence(f.data, f.runId, f.generation)).toMatchObject({ stopped: true, allClosed: true, sealed: true });
});

it.skipIf(process.platform === "win32")("separates a closed unqualified target from an unverified detached descendant after takeover", async () => {
  const f = await fixture();
  const child = f.tracked.transport.spawn(process.execPath, ["-e", "process.exit(0)"], { cwd: f.data, env: {} });
  child.stdout.resume(); child.stderr.resume();
  await new Promise(resolve => child.once("close", resolve));
  await f.tracked.confirmSdkStop();
  expect(await TrackedNativeProcesses.readEvidence(f.data, f.runId, f.generation, true)).toMatchObject({
    targetStopped: true, stopped: false, allClosed: false, reason: "unqualified_descendants",
  });
});
