import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { prepareWindowsJob, resolveWindowsCompiler } from "./windows-job-cache.mjs";
import { TrackedNativeProcesses } from "./tracked-process.js";

let testCache: string, jobHelper: string, breakawayProbe: string;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const data = await mkdtemp(path.join(os.tmpdir(), "hosty-windows-native-")); cleanup.push(() => rm(data, { recursive: true, force: true }));
  const runId = randomUUID(), generation = randomUUID(), tracked = await TrackedNativeProcesses.create(data, runId, generation, { kind: "windows-job", helper: jobHelper }); cleanup.push(() => tracked.stop());
  return { data, runId, generation, tracked, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, HOME: data } };
}
describe.skipIf(process.platform !== "win32")("actual Windows native Job Object proof", () => {
  beforeAll(async () => {
    testCache = await mkdtemp(path.join(os.tmpdir(), "hosty-windows-helper-"));
    jobHelper = await prepareWindowsJob(testCache);
    // Prepare the boundary probe outside the timed native launch, using the same stock compiler.
    breakawayProbe = path.join(testCache, "breakaway-probe.exe");
    const source = `using System;using System.Text;using System.Runtime.InteropServices;public static class EscapeProbe {
[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct SI{public uint cb;public string a,b,c;public uint d,e,f,g,h,i,j,k;public ushort l,m;public IntPtr n,o,p,q;}
[StructLayout(LayoutKind.Sequential)]public struct PI{public IntPtr process,thread;public uint pid,tid;}
[DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI info,out PI process);
[DllImport("kernel32")]static extern bool CloseHandle(IntPtr handle);[DllImport("kernel32")]static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
public static string Run(string exe){var si=new SI{cb=(uint)Marshal.SizeOf(typeof(SI))};PI pi;bool ok=CreateProcessW(exe,new StringBuilder("\\\""+exe+"\\\" -e process.exit(0)"),IntPtr.Zero,IntPtr.Zero,false,0x01000000|0x08000000,IntPtr.Zero,null,ref si,out pi);int error=Marshal.GetLastWin32Error();if(ok){WaitForSingleObject(pi.process,5000);CloseHandle(pi.thread);CloseHandle(pi.process);return "escaped";}return "blocked:"+error;}
public static void Main(string[] args){Console.WriteLine(Run(args[0]));}}`;
    const input = path.join(testCache, "breakaway-probe.cs");
    await writeFile(input, source);
    await promisify(execFile)(await resolveWindowsCompiler(), ["/nologo", "/target:exe", "/out:" + breakawayProbe, input], { cwd: testCache });
  }, 120000);
  afterAll(async () => { if (testCache) await rm(testCache, { recursive: true, force: true }); });
  it("forwards Unicode stdin and EOF unchanged, then requires the separate SDK marker", async () => {
    const f = await fixture(), input = "Native input with spaces — Привет\n", child = f.tracked.transport.spawnTool!(["-e", "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>process.stdout.write(s));"], { cwd: f.data, env: f.env });
    let output = "", errors = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { errors += value; });
    child.stdin.end(input); const code = await new Promise<number | null>(resolve => child.once("close", resolve));
    expect(errors).toBe(""); expect(code).toBe(0); expect(output).toBe(input);
    expect(await f.tracked.stop()).toMatchObject({ stopped: false, allClosed: true, reason: "sdk_stop_unconfirmed" });
    await f.tracked.confirmSdkStop(); expect(await f.tracked.evidence()).toMatchObject({ stopped: true, allClosed: true });
    const folder = path.join(f.data, "native-processes", f.runId, f.generation), file = (await readdir(folder)).find(value => value !== "manifest.json" && value.endsWith(".json"))!;
    expect(JSON.parse(await readFile(path.join(folder, file), "utf8"))).toMatchObject({ mechanism: "windows-job.1", activeProcesses: 0, knownHandlesClosed: true });
  }, 30000);
  it("stops detached descendants before confirming an early-exiting native parent", async () => {
    const f = await fixture(), marker = path.join(f.data, "activity.txt"), descendant = `const fs=require('node:fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)},String(Date.now())),20);`;
    const parent = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});setTimeout(()=>process.exit(0),1200);`;
    const child = f.tracked.transport.spawnTool!(["-e", parent], { cwd: f.data, env: f.env }); child.stdout.resume(); child.stderr.resume();
    await new Promise(resolve => child.once("close", resolve)); const before = await readFile(marker, "utf8"); await new Promise(resolve => setTimeout(resolve, 150)); expect(await readFile(marker, "utf8")).toBe(before);
    await f.tracked.confirmSdkStop(); expect(await f.tracked.evidence()).toMatchObject({ stopped: true, allClosed: true });
  }, 30000);
  it("refuses an explicit CREATE_BREAKAWAY_FROM_JOB launch from a native descendant", async () => {
    const f = await fixture();
    const child = f.tracked.transport.spawnCommand!(breakawayProbe, [process.execPath], { cwd: f.data, env: f.env }); let output = "", errors = ""; child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { errors += value; });
    expect(await new Promise(resolve => child.once("close", resolve))).toBe(0); expect(errors).toBe(""); expect(output.trim()).toBe("blocked:5");
    await f.tracked.confirmSdkStop(); expect(await f.tracked.evidence()).toMatchObject({ stopped: true, allClosed: true });
  }, 30000);
});
