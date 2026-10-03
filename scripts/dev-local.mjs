#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.resolve(process.env.HOSTY_DEV_DATA_ROOT || path.join(repoRoot, ".hosty-dev"));
const coreUrl = process.env.HOSTY_CORE_URL || `http://localhost:${resolvePort("HOSTY_CORE_PORT", 3001)}`;
const shellOrigin = process.env.HOSTY_SHELL_PUBLIC_ORIGIN || `http://localhost:${resolvePort("HOSTY_SHELL_PORT", 3000)}`;
let coreEndpoint;
let shellEndpoint;

try {
  coreEndpoint = parseEndpoint(coreUrl);
  shellEndpoint = parseEndpoint(shellOrigin);
  await assertPortAvailable("Core", coreEndpoint);
  await assertPortAvailable("Shell", shellEndpoint);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Example with alternate ports:");
  console.error("  HOSTY_CORE_PORT=3301 HOSTY_SHELL_PORT=3300 npm run dev");
  process.exit(1);
}

const commonEnv = {
  ...process.env,
  HOSTY_CORE_URL: coreUrl,
  HOSTY_CORE_PORT: String(coreEndpoint.port),
  HOSTY_SHELL_PORT: String(shellEndpoint.port),
  HOSTY_DATA_ROOT: dataRoot,
  HOSTY_CORE_PUBLIC_ORIGIN: coreUrl,
  HOSTY_SHELL_PUBLIC_ORIGIN: shellOrigin,
};

const children = [];
let shuttingDown = false;

start("Core", "dotnet", ["run", "--no-launch-profile", "--project", "apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj"], {
  ...commonEnv,
  DOTNET_ENVIRONMENT: "Development",
  HOSTY_SHELL_BOOTSTRAP_ENABLED: "true",
  HOSTY_SHELL_BOOTSTRAP_RUNTIME: "dev",
  HOSTY_SHELL_SOURCE_OVERRIDE_PATH: repoRoot,
  HOSTY_SHELL_AUTOSTART: "true",
});

console.log("");
console.log("Hosty local development is starting.");
console.log(`Core:  ${coreUrl}`);
console.log(`Shell: ${shellOrigin}`);
console.log(`Data:  ${dataRoot}`);
console.log("");
console.log(`Open ${shellOrigin} and sign in at Core with your email and password.`);
console.log("After Core is ready, initialize a new data root from another terminal:");
console.log(`  hosty --data-root "${dataRoot}" auth setup-token`);
console.log("For an existing account without a password, use recovery instead:");
console.log(`  hosty --data-root "${dataRoot}" auth recovery-token`);
console.log("Press Ctrl+C to stop Core and Shell.");

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));
process.on("exit", () => {
  if (!shuttingDown) {
    stopAll("SIGTERM");
  }
});

function start(label, command, args, env) {
  // No shell: dotnet resolves directly on every platform, and a cmd.exe wrapper
  // on Windows would make `child` track the wrapper instead of the real process.
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    console.error(`${label} exited${signal ? ` with signal ${signal}` : ` with code ${code}`}.`);
    stopAll("SIGTERM");
    process.exitCode = code ?? 1;
  });
}

function stopAll(signal) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed && child.exitCode === null) {
      if (process.platform === "win32" && typeof child.pid === "number") {
        // On Windows child.kill() terminates only the direct child, and
        // `dotnet run` hosts the actual Core process as its own child, so kill
        // the whole tree. Otherwise Core keeps running and the next
        // `npm run dev` fails the port availability check.
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill(signal);
      }
    }
  }
}

function resolvePort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`${name} must be an integer between 1 and 65535 (got "${raw}").`);
    process.exit(1);
  }

  return port;
}

function parseEndpoint(origin) {
  const url = new URL(origin);
  return {
    hostname: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
  };
}

async function assertPortAvailable(label, endpoint) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      reject(new Error(`${label} port ${endpoint.hostname}:${endpoint.port} is not available (${error.code || error.message}). Stop the existing process or set a different origin.`));
    });
    server.once("listening", () => {
      server.close(resolve);
    });
    server.listen(endpoint.port, endpoint.hostname);
  });
}
