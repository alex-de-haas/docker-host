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
