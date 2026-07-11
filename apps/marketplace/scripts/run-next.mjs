import { spawn } from "node:child_process";

const [command = "dev", fallbackPort] = process.argv.slice(2);
const port = process.env.PORT || fallbackPort;
const nextBin = process.platform === "win32" ? "next.cmd" : "next";
const args = [command];

if (port) {
  args.push("--port", port);
}

const child = spawn(nextBin, args, {
  stdio: "inherit",
  // Node's CVE-2024-27980 hardening refuses to spawn a `.cmd`/`.bat` (next.cmd) without a shell,
  // throwing EINVAL. Run through the shell on Windows; POSIX spawns the `next` binary directly (D-M1).
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exitCode = code ?? 1;
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
