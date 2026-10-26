import { spawn } from "node:child_process";
const [command = "dev", fallbackPort] = process.argv.slice(2);
const port = process.env.PORT || fallbackPort;
const child = spawn(process.platform === "win32" ? "next.cmd" : "next", [command, ...(port ? ["--port", port] : [])], {
  stdio: "inherit", shell: process.platform === "win32",
});
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
